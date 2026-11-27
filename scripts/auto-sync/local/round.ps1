#Requires -Version 5.1
<#
Single-process tray worker. Dot-sourced into a private runspace owned by tray.ps1.
No separate PowerShell/Node daemon or protocol; Node is launched only for sync.mjs.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$LocalDir,
    [string]$ConfigJson = '',
    [string]$ConfigBase64 = '',
    [Parameter(Mandatory = $true)][string]$RunId
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-ConfigPathValue {
    param($Object, [string]$Path, $Default = $null)
    $current = $Object
    foreach ($part in $Path.Split('.')) {
        if ($null -eq $current) { return $Default }
        $property = $current.PSObject.Properties[$part]
        if ($null -eq $property) { return $Default }
        $current = $property.Value
    }
    if ($null -eq $current) { return $Default }
    return $current
}

function Get-SafeArrayProperty {
    param($Object, [string]$Name)
    $value = Get-ConfigPathValue $Object $Name $null
    if ($null -eq $value) { return ,([object[]]@()) }
    return ,([object[]]@($value))
}

function ConvertTo-SafeLogText {
    param([AllowNull()][string]$Text, $Config, [int]$MaxLength = 2000)
    if ($null -eq $Text) { return '' }
    $value = $Text -replace '[\r\n\t]+', ' '
    $secretPaths = @(
        'credentials.H1111_SESSION', 'credentials.H1111_USER', 'credentials.H1111_PASSWORD',
        'credentials.GH_TOKEN', 'credentials.PUSH_TOKEN', 'wifi.password', 'security.lockPassword'
    )
    foreach ($path in $secretPaths) {
        $secret = [string](Get-ConfigPathValue $Config $path '')
        if ($secret.Length -gt 0) { $value = $value.Replace($secret, '***') }
    }
    $value = [regex]::Replace($value, '(?i)(gh[pousr]_[A-Za-z0-9_]{12,})', '***')
    $value = [regex]::Replace($value, '(?i)(Bearer\s+)[A-Za-z0-9._~+/-]+=*', '$1***')
    $value = [regex]::Replace($value, '(?i)(https?://)[^/@\s:]+:[^/@\s]+@', '$1***@')
    if ($value.Length -gt $MaxLength) { $value = $value.Substring(0, $MaxLength) + '…' }
    return $value
}

function Write-RoundLog {
    param([string]$Message, [string]$Level = 'INFO')
    $now = Get-Date
    $folder = Join-Path (Join-Path (Join-Path (Join-Path $LocalDir 'logs') $now.ToString('yyyy')) $now.ToString('MM')) $now.ToString('dd')
    [void][System.IO.Directory]::CreateDirectory($folder)
    $line = '[' + $now.ToString('yyyy-MM-dd HH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture) + '] [' + $Level + '] ' + (ConvertTo-SafeLogText $Message $script:RoundConfig)
    [System.IO.File]::AppendAllText((Join-Path $folder 'run.log'), $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

function ConvertTo-WindowsArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    for ($i = 0; $i -lt $Value.Length; $i++) {
        $char = $Value[$i]
        if ($char -eq [char]92) { $slashes++; continue }
        if ($char -eq [char]34) {
            if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
            [void]$builder.Append('\"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
        [void]$builder.Append($char)
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [hashtable]$Environment = @{},
        [int]$TimeoutMs = 120000,
        [switch]$KillProcessTree
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[[string]$key] = [string]$Environment[$key] }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    $stdoutTask = $null
    $stderrTask = $null
    try {
        if (-not $process.Start()) { throw '无法启动子进程' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            if ($KillProcessTree) {
                try {
                    $killer = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\taskkill.exe') -ArgumentList @('/PID', [string]$process.Id, '/T', '/F') -WindowStyle Hidden -PassThru
                    [void]$killer.WaitForExit(10000)
                }
                catch { try { $process.Kill() } catch { } }
            }
            else { try { $process.Kill() } catch { } }
            try { [void]$process.WaitForExit(10000) } catch { }
            return [pscustomobject]@{ ExitCode = $null; TimedOut = $true; Stdout = ''; Stderr = '' }
        }
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            TimedOut = $false
            Stdout = [string]$stdoutTask.Result
            Stderr = [string]$stderrTask.Result
        }
    }
    finally { $process.Dispose() }
}

function Get-GitEnvironment {
    param([string]$Token = '')
    # 自动任务绝不等待交互式凭据；清掉继承的 askpass/SSH 与 GIT_CONFIG_*，
    # 再按本次命令临时注入 GitHub extraheader。
    $envMap = @{
        GIT_TERMINAL_PROMPT = '0'
        GIT_ASKPASS = ''
        SSH_ASKPASS = ''
        GIT_SSH_COMMAND = ''
        GIT_SSH = ''
        GIT_SSH_VARIANT = ''
        GCM_INTERACTIVE = 'Never'
        GCM_MODAL_PROMPT = '0'
        GIT_CONFIG_COUNT = '0'
        GIT_CONFIG_PARAMETERS = ''
    }
    if ([string]::IsNullOrWhiteSpace($Token)) { return $envMap }
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('x-access-token:' + $Token))
    # GIT_CONFIG_VALUE_N 不能是空串；只注入合法的 extraheader，credential.helper
    # 由 Invoke-GitRound 的 `-c credential.helper=` 临时关闭。
    $envMap['GIT_CONFIG_COUNT'] = '1'
    $envMap['GIT_CONFIG_KEY_0'] = 'http.https://github.com/.extraheader'
    $envMap['GIT_CONFIG_VALUE_0'] = 'AUTHORIZATION: basic ' + $basic
    return $envMap
}

function Invoke-GitRound {
    param([string[]]$Arguments, [string]$Token = '', [int]$TimeoutMs = 120000)
    $git = Get-Command git.exe -ErrorAction Stop
    # 通过合法的命令行配置关闭本机 credential.helper；环境变量只负责注入可解析的 extraheader。
    $gitArguments = @('-C', $Root, '-c', 'credential.helper=') + $Arguments
    $run = Invoke-ExternalCommand -FilePath $git.Source -Arguments $gitArguments -Environment (Get-GitEnvironment $Token) -TimeoutMs $TimeoutMs -KillProcessTree
    if ($run.TimedOut) { throw ('Git 命令超时：' + (($Arguments | Select-Object -First 2) -join ' ')) }
    $combined = (([string]$run.Stdout) + "`n" + ([string]$run.Stderr)).Trim()
    if ($run.ExitCode -ne 0) {
        $safe = ConvertTo-SafeLogText $combined $script:RoundConfig 900
        if (-not $safe) { $safe = 'Git 返回非零退出码' }
        throw ('Git ' + (($Arguments | Select-Object -First 2) -join ' ') + ' 失败：' + $safe)
    }
    return [pscustomobject]@{ Output = ([string]$run.Stdout).Trim(); Stderr = ([string]$run.Stderr).Trim() }
}

function Test-GitUnsafeOperation {
    $gitDir = (Invoke-GitRound @('rev-parse', '--git-dir')).Output
    if (-not [System.IO.Path]::IsPathRooted($gitDir)) { $gitDir = Join-Path $Root $gitDir }
    foreach ($marker in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD')) {
        if (Test-Path -LiteralPath (Join-Path $gitDir $marker)) { return $true }
    }
    foreach ($folder in @('rebase-apply', 'rebase-merge')) {
        if (Test-Path -LiteralPath (Join-Path $gitDir $folder)) { return $true }
    }
    return $false
}

function Get-ConnectedSsid {
    try {
        $command = Get-Command netsh.exe -ErrorAction Stop
        $text = (& $command.Source wlan show interfaces 2>&1 | Out-String)
        $match = [regex]::Match($text, '(?im)^\s*SSID\s*:\s*(.*?)\s*$')
        if ($match.Success) { return $match.Groups[1].Value.Trim() }
    }
    catch { }
    return ''
}

function Test-InternetConnectivity {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('api.github.com', 443, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(5000, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    }
    catch { return $false }
    finally {
        if ($null -ne $client) { try { $client.Dispose() } catch { } }
    }
}

function Get-SavedWifiProfileName {
    param([string]$Ssid)
    $command = Get-Command netsh.exe -ErrorAction Stop
    $profiles = (& $command.Source wlan show profiles 2>&1 | Out-String)
    foreach ($line in ($profiles -split "`r?`n")) {
        $colon = $line.IndexOf(':')
        if ($colon -lt 0) { continue }
        $name = $line.Substring($colon + 1).Trim()
        if (-not $name) { continue }
        $detail = (& $command.Source wlan show profile name=$name 2>&1 | Out-String)
        $ssidMatch = [regex]::Match($detail, '(?im)^\s*SSID\s+name\s*:\s*"?(.*?)"?\s*$')
        if ($ssidMatch.Success -and $ssidMatch.Groups[1].Value.Trim() -eq $Ssid) { return $name }
        if ($name -eq $Ssid) { return $name }
    }
    return ''
}

function Add-TemporaryWifiProfile {
    param([string]$Ssid, [string]$Password)
    $netsh = (Get-Command netsh.exe -ErrorAction Stop).Source
    $safeSsid = [System.Security.SecurityElement]::Escape($Ssid)
    $safePassword = [System.Security.SecurityElement]::Escape($Password)
    $profileName = 'fdn-autosync-' + [guid]::NewGuid().ToString('N')
    $xml = '<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>' + $profileName + '</name><SSIDConfig><SSID><name>' + $safeSsid + '</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>' + $safePassword + '</keyMaterial></sharedKey></security></MSM></WLANProfile>'
    $profilePath = Join-Path ([System.IO.Path]::GetTempPath()) ('fdn-wifi-' + [guid]::NewGuid().ToString('N') + '.xml')
    try {
        [System.IO.File]::WriteAllText($profilePath, $xml, (New-Object System.Text.UTF8Encoding($true)))
        $output = & $netsh wlan add profile filename=$profilePath user=current 2>&1
        if ($LASTEXITCODE -ne 0) { throw '无法安装临时 WiFi 配置' }
        return $profileName
    }
    finally { Remove-Item -LiteralPath $profilePath -Force -ErrorAction SilentlyContinue }
}

function Wait-ForWifiConnection {
    param([string]$Ssid, [int]$TimeoutSeconds = 35)
    $end = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ((Get-ConnectedSsid) -eq $Ssid -and (Test-InternetConnectivity)) { return $true }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $end)
    return $false
}

function Start-WifiPreparation {
    param($Config)
    $wifi = Get-ConfigPathValue $Config 'wifi' ([pscustomobject]@{})
    $prepared = [pscustomobject]@{ ConnectedByUs = $false; CreatedProfile = $false; Ssid = ''; ProfileName = ''; Warning = '' }
    if (-not [bool](Get-ConfigPathValue $wifi 'enabled' $false)) { return $prepared }
    $ssid = [string](Get-ConfigPathValue $wifi 'ssid' '')
    if ([string]::IsNullOrWhiteSpace($ssid)) { throw 'WiFi 管理已启用但 SSID 为空' }
    if (-not [bool](Get-ConfigPathValue $wifi 'alwaysConnect' $false) -and (Test-InternetConnectivity)) { return $prepared }
    if ((Get-ConnectedSsid) -eq $ssid) { return $prepared }

    $netsh = (Get-Command netsh.exe -ErrorAction Stop).Source
    $profileName = ''
    if ([bool](Get-ConfigPathValue $wifi 'useSavedFirst' $true)) { $profileName = Get-SavedWifiProfileName $ssid }
    if (-not $profileName) { $profileName = $ssid }
    $connected = $false
    $output = & $netsh wlan connect name=$profileName ssid=$ssid 2>&1
    if ($LASTEXITCODE -eq 0) { $connected = Wait-ForWifiConnection $ssid 20 }
    if (-not $connected -and -not [string]::IsNullOrEmpty([string](Get-ConfigPathValue $wifi 'password' ''))) {
        $temporaryProfileName = Add-TemporaryWifiProfile $ssid ([string](Get-ConfigPathValue $wifi 'password' ''))
        $prepared.CreatedProfile = $true
        $profileName = [string]$temporaryProfileName
        $output = & $netsh wlan connect name=$profileName ssid=$ssid 2>&1
        if ($LASTEXITCODE -eq 0) { $connected = Wait-ForWifiConnection $ssid 25 }
    }
    if (-not $connected) {
        if ($prepared.CreatedProfile) { $null = & $netsh wlan delete profile name=$profileName 2>&1 }
        throw ('无法连接指定 WiFi 或联网检查未通过（SSID：' + $ssid + '）')
    }
    $prepared.ConnectedByUs = $true
    $prepared.Ssid = $ssid
    $prepared.ProfileName = $profileName
    return $prepared
}

function Complete-WifiPreparation {
    param($Config, $Prepared, [bool]$Failed)
    $wifi = Get-ConfigPathValue $Config 'wifi' ([pscustomobject]@{})
    $netsh = (Get-Command netsh.exe -ErrorAction Stop).Source
    $shouldDisconnect = $Prepared.ConnectedByUs -and [bool](Get-ConfigPathValue $wifi 'disconnectAfter' $false) -and (-not $Failed -or [bool](Get-ConfigPathValue $wifi 'disconnectEvenOnFailure' $true))
    if ($shouldDisconnect) {
        if ((Get-ConnectedSsid) -eq $Prepared.Ssid) {
            $null = & $netsh wlan disconnect 2>&1
            if ($LASTEXITCODE -ne 0) { Write-RoundLog '结束阶段断开 WiFi 失败' 'WARN' }
        }
        else { Write-RoundLog '结束阶段未断开：当前网络已不是本轮连接的 WiFi' 'WARN' }
    }
    # 只要是本轮为了连接而新建的 profile，就清掉它；不影响用户原来保存的配置。
    if ($Prepared.CreatedProfile) {
        $null = & $netsh wlan delete profile name=$Prepared.ProfileName 2>&1
        if ($LASTEXITCODE -ne 0) { Write-RoundLog '结束阶段删除本轮临时 WiFi 配置失败' 'WARN' }
    }
    elseif ($shouldDisconnect -and [bool](Get-ConfigPathValue $wifi 'forgetOnDisconnect' $false)) {
        $null = & $netsh wlan delete profile name=$Prepared.ProfileName 2>&1
        if ($LASTEXITCODE -ne 0) { Write-RoundLog '结束阶段删除指定 WiFi 配置失败' 'WARN' }
    }
}

function Invoke-NodeSync {
    param($Config)
    $runtime = Get-ConfigPathValue $Config 'runtime' ([pscustomobject]@{})
    $nodePath = [string](Get-ConfigPathValue $runtime 'nodePath' '')
    if ([string]::IsNullOrWhiteSpace($nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw '配置的 Node.js 路径不存在' }
    $syncScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'sync.mjs'
    if (-not (Test-Path -LiteralPath $syncScript -PathType Leaf)) { throw '找不到共享同步入口 sync.mjs' }

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('fdn-autosync-' + [guid]::NewGuid().ToString('N'))
    [void][System.IO.Directory]::CreateDirectory($tempDir)
    $resultFile = Join-Path $tempDir 'result.json'
    $stdoutFile = Join-Path $tempDir 'stdout.log'
    $stderrFile = Join-Path $tempDir 'stderr.log'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodePath
    $psi.Arguments = ConvertTo-WindowsArgument $syncScript
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    $psi.EnvironmentVariables['LOCAL_SYNC_STEP_COMMIT'] = '0'
    $psi.EnvironmentVariables['LOCAL_SYNC_STEP_PUSH'] = '0'
    $psi.EnvironmentVariables['LOCAL_SYNC_RESULT_FILE'] = $resultFile
    $psi.EnvironmentVariables['H1111_SESSION'] = [string](Get-ConfigPathValue $Config 'credentials.H1111_SESSION' '')
    $psi.EnvironmentVariables['H1111_USER'] = [string](Get-ConfigPathValue $Config 'credentials.H1111_USER' '')
    $psi.EnvironmentVariables['H1111_PASSWORD'] = [string](Get-ConfigPathValue $Config 'credentials.H1111_PASSWORD' '')
    $psi.EnvironmentVariables['GH_TOKEN'] = [string](Get-ConfigPathValue $Config 'credentials.GH_TOKEN' '')
    foreach ($name in @('GITHUB_ACTIONS', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'GITHUB_TOKEN')) { $psi.EnvironmentVariables[$name] = '' }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $outTask = $null
    $errTask = $null
    try {
        if (-not $process.Start()) { throw '无法启动 node.exe' }
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        $timeout = [math]::Max(1, [int](Get-ConfigPathValue $runtime 'syncTimeoutMinutes' 120)) * 60000
        if (-not $process.WaitForExit($timeout)) {
            try {
                $killer = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\taskkill.exe') -ArgumentList @('/PID', [string]$process.Id, '/T', '/F') -WindowStyle Hidden -PassThru
                [void]$killer.WaitForExit(10000)
            }
            catch { try { $process.Kill() } catch { } }
            try { [void]$process.WaitForExit(10000) } catch { }
            throw ('同步超时（' + (Get-ConfigPathValue $runtime 'syncTimeoutMinutes' 120) + ' 分钟）')
        }
        $process.WaitForExit()
        $out = [string]$outTask.Result
        $err = [string]$errTask.Result
        # stdout 可能包含第三方库诊断；本地状态只依赖结果文件，避免把不受控输出写入长期日志。
        foreach ($line in ($err -split "`r?`n")) {
            if (-not [string]::IsNullOrWhiteSpace($line)) { Write-RoundLog ('[sync:stderr] ' + $line) }
        }
        $payload = $null
        if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
            try { $payload = [System.IO.File]::ReadAllText($resultFile, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
            catch { throw '共享同步结果文件格式无效' }
        }
        if ($process.ExitCode -ne 0) {
            $message = '共享同步失败（退出码 ' + $process.ExitCode + '）'
            $errors = Get-SafeArrayProperty $payload 'errors'
            if ($errors.Count -gt 0) { $message += '：' + (ConvertTo-SafeLogText ([string]$errors[0]) $Config 800) }
            return [pscustomobject]@{ Payload = $payload; Failure = $message; InternalError = $false }
        }
        if ($null -eq $payload -or $null -eq $payload.PSObject.Properties['ok'] -or $null -eq $payload.PSObject.Properties['items']) {
            return [pscustomobject]@{ Payload = $payload; Failure = '共享同步未生成完整结构化结果'; InternalError = $true }
        }
        if (-not [bool](Get-ConfigPathValue $payload 'ok' $false)) {
            $message = '共享同步报告有失败项'
            $errors = Get-SafeArrayProperty $payload 'errors'
            if ($errors.Count -gt 0) { $message += '：' + (ConvertTo-SafeLogText ([string]$errors[0]) $Config 800) }
            return [pscustomobject]@{ Payload = $payload; Failure = $message; InternalError = $false }
        }
        return [pscustomobject]@{ Payload = $payload; Failure = ''; InternalError = $false }
    }
    finally {
        $process.Dispose()
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Set-CommitIdentityArguments {
    param([System.Collections.Generic.List[string]]$Arguments, $Config)
    $mode = [string](Get-ConfigPathValue $Config 'stages.commit.identityMode' 'gha')
    switch ($mode) {
        'default' { }
        'custom' {
            $name = [string](Get-ConfigPathValue $Config 'stages.commit.userName' '')
            $email = [string](Get-ConfigPathValue $Config 'stages.commit.userEmail' '')
            if ($name) { $Arguments.Add('-c'); $Arguments.Add('user.name=' + $name) }
            if ($email) { $Arguments.Add('-c'); $Arguments.Add('user.email=' + $email) }
        }
        default {
            $Arguments.Add('-c'); $Arguments.Add('user.name=github-actions[bot]')
            $Arguments.Add('-c'); $Arguments.Add('user.email=github-actions[bot]@users.noreply.github.com')
        }
    }
}

function Invoke-CommitSyncData {
    param($Config, $Payload)
    $ids = New-Object System.Collections.Generic.List[string]
    foreach ($item in (Get-SafeArrayProperty $Payload 'items')) {
        if ($null -eq $item) { continue }
        $versions = Get-SafeArrayProperty $item 'versions'
        $pruned = Get-SafeArrayProperty $item 'pruned'
        $hasChanges = ($versions.Count -gt 0) -or ($pruned.Count -gt 0)
        $id = [string](Get-ConfigPathValue $item 'id' '')
        if ($hasChanges -and $id -match '^\d+$' -and -not $ids.Contains($id)) { [void]$ids.Add($id) }
    }
    if ($ids.Count -eq 0) { Write-RoundLog 'Commit：本轮没有同步数据变更'; return $false }
    $committed = $false
    foreach ($id in $ids) {
        $path = 'data/down/' + $id
        $null = Invoke-GitRound @('add', '-A', '--', $path)
        $diff = Invoke-ExternalCommand -FilePath (Get-Command git.exe -ErrorAction Stop).Source -Arguments (@('-C', $Root, 'diff', '--cached', '--quiet', '--', $path)) -Environment (Get-GitEnvironment '') -TimeoutMs 30000
        if ($diff.TimedOut) { throw '检查暂存区超时' }
        if ($diff.ExitCode -eq 0) { continue }
        if ($diff.ExitCode -ne 1) { throw '检查暂存区失败' }
        $versionList = @()
        foreach ($item in (Get-SafeArrayProperty $Payload 'items')) {
            if ([string](Get-ConfigPathValue $item 'id' '') -eq $id) {
                foreach ($v in (Get-SafeArrayProperty $item 'versions')) {
                    $versionList += [string]$v
                }
            }
        }
        $subject = '[LOCAL] 新增：内容：数据源：资源id-' + $id + '：' + (($versionList | Sort-Object -Unique) -join '&') + '呜~'
        $args = New-Object 'System.Collections.Generic.List[string]'
        Set-CommitIdentityArguments $args $Config
        $args.Add('commit'); $args.Add('--only'); $args.Add('-m'); $args.Add($subject); $args.Add('--'); $args.Add($path)
        $null = Invoke-GitRound -Arguments $args.ToArray()
        $committed = $true
        Write-RoundLog ('Commit：已提交资源 id=' + $id)
    }
    return $committed
}

function Get-UpstreamInfo {
    $branch = (Invoke-GitRound @('branch', '--show-current')).Output
    if (-not $branch) { throw '当前处于 detached HEAD，无法确定上游' }
    $remote = (Invoke-GitRound @('config', '--get', ('branch.' + $branch + '.remote'))).Output
    $merge = (Invoke-GitRound @('config', '--get', ('branch.' + $branch + '.merge'))).Output
    if (-not $remote -or -not $merge.StartsWith('refs/heads/')) { throw '当前分支上游不是可识别的远端跟踪分支' }
    $remoteBranch = $merge.Substring('refs/heads/'.Length)
    $url = (Invoke-GitRound @('remote', 'get-url', '--push', $remote)).Output
    return [pscustomobject]@{ Remote = $remote; Branch = $remoteBranch; Url = $url }
}

function Get-PushTokenForUpstream {
    param($Target = $null)
    if ($null -eq $Target) { $Target = Get-UpstreamInfo }
    $token = [string](Get-ConfigPathValue $script:RoundConfig 'credentials.PUSH_TOKEN' '')
    if ($token -and $Target.Url -match '^https://github[.]com/') { return $token }
    return ''
}

function Get-AheadCount {
    $text = (Invoke-GitRound @('rev-list', '--left-right', '--count', 'HEAD...@{upstream}')).Output
    $parts = $text -split '\s+'
    if ($parts.Count -lt 2 -or $parts[0] -notmatch '^\d+$') { throw '无法确定本地待推送提交数' }
    return [int]$parts[0]
}

function Invoke-AutoSyncRound {
    param([string]$RoundId)
    $result = [ordered]@{
        status = 'failure'; startedAt = (Get-Date).ToString('o'); finishedAt = ''; durationMs = 0
        message = ''; stats = $null; error = $null; stages = @(); warnings = @(); committed = $false; pushed = $false
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $prepared = [pscustomobject]@{ ConnectedByUs = $false; CreatedProfile = $false; Ssid = ''; ProfileName = '' }
    $failed = $false
    $internalError = $false
    $skipRest = $false
    $payload = $null
    $stageList = New-Object System.Collections.ArrayList
    $mark = {
        param([string]$Name, [string]$Status, [string]$Text)
        [void]$stageList.Add([pscustomobject]@{ name = $Name; status = $Status; message = $Text })
        Write-RoundLog ('[' + $Name + '] ' + $Text) $(if ($Status -eq 'failed') { 'ERROR' } elseif ($Status -eq 'skipped') { 'WARN' } else { 'INFO' })
    }

    try {
        # 必须先检查全仓库；脏树时不碰 WiFi、Pull、同步、Commit 或 Push。
        & $mark 'prepare' 'running' '检查工作区状态'
        $status = Invoke-GitRound @('status', '--porcelain', '--untracked-files=all')
        if ($status.Output) {
            $paths = @($status.Output -split "`r?`n" | Select-Object -First 8) -join '；'
            $message = '工作区有未提交改动，跳过本轮：' + $paths
            & $mark 'prepare' 'failed' $message
            $failed = $true; $skipRest = $true; $result.message = $message
        }
        elseif (Test-GitUnsafeOperation) {
            $message = 'Git 正处于未完成的 Merge/Rebase/Cherry-pick 等操作，跳过本轮'
            & $mark 'prepare' 'failed' $message
            $failed = $true; $skipRest = $true; $result.message = $message
        }
        else { & $mark 'prepare' 'ok' '工作区干净，继续本轮' }

        if (-not $skipRest) {
            try { $prepared = Start-WifiPreparation $script:RoundConfig; & $mark 'wifi' 'ok' '联网准备完成' }
            catch {
                $wifiFailure = $_.Exception.Message
                if ([bool](Get-ConfigPathValue $script:RoundConfig 'wifi.skipOnFailure' $true)) {
                    $failed = $true; $skipRest = $true; $result.message = $wifiFailure
                    & $mark 'wifi' 'failed' $wifiFailure
                }
                else { $result.warnings += $wifiFailure; & $mark 'wifi' 'skipped' ($wifiFailure + '；配置允许继续同步') }
            }
        }

        if (-not $skipRest) {
            if ([bool](Get-ConfigPathValue $script:RoundConfig 'stages.pull.enabled' $true)) {
                try {
                    $target = Get-UpstreamInfo
                    $token = Get-PushTokenForUpstream $target
                    $pullTimeout = [math]::Max(1, [int](Get-ConfigPathValue $script:RoundConfig 'runtime.pullTimeoutMinutes' 10)) * 60000
                    $null = Invoke-GitRound @('fetch', $target.Remote) $token $pullTimeout
                    $strategy = [string](Get-ConfigPathValue $script:RoundConfig 'stages.pull.strategy' 'rebase')
                    if ($strategy -eq 'ff-only') { $pullArg = '--ff-only' } else { $pullArg = '--rebase' }
                    $null = Invoke-GitRound @('pull', $pullArg, $target.Remote, $target.Branch) $token $pullTimeout
                    & $mark 'pull' 'ok' ('Pull 完成（' + $strategy + '）')
                }
                catch { $failed = $true; $skipRest = $true; $result.message = $_.Exception.Message; & $mark 'pull' 'failed' $result.message }
            }
            else { & $mark 'pull' 'skipped' 'Pull 阶段已关闭' }
        }

        if (-not $skipRest) {
            if ([bool](Get-ConfigPathValue $script:RoundConfig 'stages.sync.enabled' $true)) {
                try {
                    $sync = Invoke-NodeSync $script:RoundConfig
                    $payload = $sync.Payload
                    if ($sync.InternalError) { $internalError = $true; $failed = $true; $skipRest = $true; $result.message = $sync.Failure; & $mark 'sync' 'failed' $sync.Failure }
                    elseif ($sync.Failure) { $failed = $true; $skipRest = $true; $result.message = $sync.Failure; & $mark 'sync' 'failed' $sync.Failure }
                    else { & $mark 'sync' 'ok' $(if ([bool](Get-ConfigPathValue $payload 'allLatest' $false)) { '所有软件已是最新' } else { '共享同步完成' }) }
                }
                catch { $internalError = $true; $failed = $true; $skipRest = $true; $result.message = $_.Exception.Message; & $mark 'sync' 'failed' $result.message }
            }
            else { & $mark 'sync' 'skipped' 'Sync 阶段已关闭' }
        }

        if ($skipRest) { & $mark 'commit' 'skipped' '前序阶段失败，跳过 Commit' }
        elseif (-not [bool](Get-ConfigPathValue $script:RoundConfig 'stages.commit.enabled' $true)) {
            & $mark 'commit' 'skipped' 'Commit 已关闭，本轮产物保留在工作区'
            & $mark 'push' 'skipped' 'Commit 被跳过，按要求不执行 Push'
            $skipRest = $true
            $result.message = 'Sync 完成，Commit 与 Push 均按设置跳过'
        }
        else {
            try {
                if ($null -ne $payload) { $result.committed = Invoke-CommitSyncData $script:RoundConfig $payload }
                & $mark 'commit' 'ok' $(if ($result.committed) { '同步数据提交完成' } else { '没有需要提交的新数据' })
            }
            catch { $failed = $true; $skipRest = $true; $result.message = $_.Exception.Message; & $mark 'commit' 'failed' $result.message }
        }

        if (-not $skipRest) {
            if (-not [bool](Get-ConfigPathValue $script:RoundConfig 'stages.push.enabled' $true)) {
                & $mark 'push' 'skipped' 'Push 阶段已关闭；本地提交保留，后续轮次可补推'
            }
            else {
                try {
                    $target = Get-UpstreamInfo
                    $aheadBefore = Get-AheadCount
                    if ($aheadBefore -le 0) {
                        & $mark 'push' 'skipped' '没有待推送的本地提交'
                    }
                    elseif ([bool](Get-ConfigPathValue $script:RoundConfig 'stages.push.skipIfDirty' $false) -and (Invoke-GitRound @('status', '--porcelain', '--untracked-files=all')).Output) {
                        & $mark 'push' 'skipped' '存在未提交改动，按设置跳过 Push'
                    }
                    else {
                        $token = Get-PushTokenForUpstream $target
                        $pushTimeout = [math]::Max(1, [int](Get-ConfigPathValue $script:RoundConfig 'runtime.pushTimeoutMinutes' 5)) * 60000
                        $null = Invoke-GitRound @('push', $target.Remote, ('HEAD:' + $target.Branch)) $token $pushTimeout
                        $aheadAfter = Get-AheadCount
                        if ($aheadAfter -gt 0) { throw ('Push 命令完成但仍有 ' + $aheadAfter + ' 个待推送提交') }
                        $result.pushed = $true
                        & $mark 'push' 'ok' ('已推送 ' + $aheadBefore + ' 个提交')
                    }
                }
                catch { $failed = $true; $result.message = $_.Exception.Message; & $mark 'push' 'failed' $result.message }
            }
        }
    }
    catch {
        $internalError = $true; $failed = $true; $result.message = $_.Exception.Message
        & $mark 'internal' 'failed' $result.message
    }
    finally {
        try { Complete-WifiPreparation $script:RoundConfig $prepared $failed }
        catch { $result.warnings += ('结束阶段清理失败：' + $_.Exception.Message); Write-RoundLog $result.warnings[-1] 'WARN' }
        & $mark 'finish' 'ok' '本轮收尾完成'
    }

    $timer.Stop()
    $result.finishedAt = (Get-Date).ToString('o')
    $result.durationMs = $timer.ElapsedMilliseconds
    $result.stages = @($stageList.ToArray())
    if ($internalError) { $result.status = 'internal-error' }
    elseif ($failed) { $result.status = 'failure' }
    elseif ($result.committed -or $result.pushed -or ($payload -and -not [bool](Get-ConfigPathValue $payload 'allLatest' $false))) { $result.status = 'success' }
    else { $result.status = 'up-to-date' }
    if (-not $result.message) {
        if ($result.status -eq 'success') { $result.message = '自动同步成功' }
        elseif ($result.status -eq 'up-to-date') { $result.message = '当前已是最新' }
        else { $result.message = '自动同步失败' }
    }
    if ($null -ne $payload) {
        $items = @()
        $versionTotal = 0
        foreach ($item in (Get-SafeArrayProperty $payload 'items')) {
            $itemVersions = Get-SafeArrayProperty $item 'versions'
            if ($itemVersions.Count -gt 0) {
                $items += $item
                $versionTotal += $itemVersions.Count
            }
        }
        if ($items.Count -gt 0) {
            $result.stats = [pscustomobject]@{ resources = $items.Count; versions = $versionTotal }
        }
    }
    return [pscustomobject]$result
}

$script:RoundConfig = $null
try {
    if ($ConfigBase64) { $ConfigJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64)) }
    if (-not $ConfigJson) { throw '缺少本轮配置快照' }
    $script:RoundConfig = $ConfigJson | ConvertFrom-Json -ErrorAction Stop
    Invoke-AutoSyncRound -RoundId $RunId
}
catch {
    [pscustomobject]@{
        status = 'internal-error'; startedAt = (Get-Date).ToString('o'); finishedAt = (Get-Date).ToString('o'); durationMs = 0
        message = (ConvertTo-SafeLogText $_.Exception.Message $script:RoundConfig); stats = $null
        error = $_.Exception.GetType().FullName; stages = @(); warnings = @(); committed = $false; pushed = $false
    }
}
