#Requires -Version 5.1
<##
    fdn-autosync-tray

    轻量单进程 Windows 托盘宿主：
    - 本进程负责托盘、菜单、调度、配置、状态和通知。
    - 每轮同步在本进程的后台 runspace 中执行；Node 只在 Sync 阶段按需启动。
    - 六阶段编排位于 round.ps1；不依赖旧的 Node 常驻协议。

    本文件必须保存为 UTF-8 with BOM，才能被 Windows PowerShell 5.1 正确读取中文。
##>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$NoTray,
    [switch]$VerboseLog,
    [switch]$TestMenu
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ----------------------------- 路径与运行时 -----------------------------
$script:LocalDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($script:LocalDir)) {
    $script:LocalDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$script:RepoRoot = (Resolve-Path (Join-Path $script:LocalDir '..\..\..')).Path
$script:ConfigPath = Join-Path $script:LocalDir 'config.json'
$script:StatePath = Join-Path $script:LocalDir 'state.json'
$script:RoundPath = Join-Path $script:LocalDir 'round.ps1'
$script:IconCompose = Join-Path $script:LocalDir 'icon-compose.ps1'
$script:LogsDir = Join-Path $script:LocalDir 'logs'
$script:AssetsDir = Join-Path $script:LocalDir 'assets'
$script:CacheDir = Join-Path $script:LocalDir 'cache\icons'
$script:DefaultIconPath = Join-Path $script:AssetsDir 'default.ico'
$script:StartVbsPath = Join-Path $script:LocalDir 'start.vbs'
$script:StartupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'fdn-autosync-tray.lnk'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:AppName = 'fdn-autosync-tray'
$script:VerboseLogging = [bool]$VerboseLog
$script:NoTrayMode = [bool]$NoTray

$script:Config = $null
$script:State = $null
$script:Running = $false
$script:Paused = $false
$script:Locked = $false
$script:NextRunAt = $null
$script:Runspace = $null
$script:RunAsync = $null
$script:RunTimer = $null
$script:ScheduleTimer = $null
$script:NotifyIcon = $null
$script:ContextMenu = $null
$script:CurrentIcon = $null
$script:ExitRequested = $false
$script:RestartRequested = $false
$script:RunNumber = 0
$script:InstanceMutex = $null
$script:InstanceMutexOwned = $false

# ----------------------------- 小工具 -----------------------------
function Get-ConfigValue {
    param($Object, [string]$Path, $Default = $null)
    $value = $Object
    foreach ($part in $Path.Split('.')) {
        if ($null -eq $value) { return $Default }
        $property = $value.PSObject.Properties[$part]
        if ($null -eq $property) { return $Default }
        $value = $property.Value
    }
    if ($null -eq $value) { return $Default }
    return $value
}

function Set-ConfigValue {
    param($Object, [string]$Path, $Value)
    $parts = $Path.Split('.')
    $current = $Object
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
        $property = $current.PSObject.Properties[$parts[$i]]
        if ($null -eq $property -or $null -eq $property.Value) {
            $current | Add-Member -MemberType NoteProperty -Name $parts[$i] -Value ([pscustomobject]@{}) -Force
        }
        $current = $current.($parts[$i])
    }
    $leaf = $parts[-1]
    if ($null -eq $current.PSObject.Properties[$leaf]) {
        $current | Add-Member -MemberType NoteProperty -Name $leaf -Value $Value -Force
    }
    else { $current.($leaf) = $Value }
}

function Merge-ConfigDefaults {
    param($Target, $Defaults)
    $changed = $false
    foreach ($defaultProperty in $Defaults.PSObject.Properties) {
        $existing = $Target.PSObject.Properties[$defaultProperty.Name]
        if ($null -eq $existing) {
            $Target | Add-Member -MemberType NoteProperty -Name $defaultProperty.Name -Value $defaultProperty.Value -Force
            $changed = $true
            continue
        }
        if ($defaultProperty.Value -is [pscustomobject]) {
            if ($null -eq $existing.Value -or -not ($existing.Value -is [pscustomobject])) {
                $Target.($defaultProperty.Name) = $defaultProperty.Value
                $changed = $true
            }
            else { if (Merge-ConfigDefaults $existing.Value $defaultProperty.Value) { $changed = $true } }
        }
        elseif ($null -eq $existing.Value) {
            $Target.($defaultProperty.Name) = $defaultProperty.Value
            $changed = $true
        }
    }
    return $changed
}

function New-DefaultConfig {
    return [pscustomobject]@{
        version = 1
        runtime = [pscustomobject]@{ nodePath = ''; syncTimeoutMinutes = 120; pullTimeoutMinutes = 10; pushTimeoutMinutes = 5 }
        startup = [pscustomobject]@{ enabled = $false; runOnStart = $true }
        scheduler = [pscustomobject]@{ intervalMinutes = 10; catchUpOnWake = $true }
        wifi = [pscustomobject]@{ enabled = $false; ssid = ''; password = ''; useSavedFirst = $true; alwaysConnect = $false; skipOnFailure = $true; disconnectAfter = $false; disconnectEvenOnFailure = $true; forgetOnDisconnect = $false }
        stages = [pscustomobject]@{
            pull = [pscustomobject]@{ enabled = $true; strategy = 'rebase' }
            sync = [pscustomobject]@{ enabled = $true }
            commit = [pscustomobject]@{ enabled = $true; identityMode = 'gha'; userName = ''; userEmail = '' }
            push = [pscustomobject]@{ enabled = $true; skipIfDirty = $false }
        }
        credentials = [pscustomobject]@{ H1111_SESSION = ''; H1111_USER = ''; H1111_PASSWORD = ''; GH_TOKEN = ''; PUSH_TOKEN = '' }
        notifications = [pscustomobject]@{
            mode = 'standard'
            standard = [pscustomobject]@{ success = $true; 'up-to-date' = $false; failure = $true; 'internal-error' = $true }
            cumulative = [pscustomobject]@{ everyRuns = 7; internalErrorMode = 'always' }
        }
        appearance = [pscustomobject]@{ iconPath = $null }
        logging = [pscustomobject]@{ retentionDays = 90 }
        security = [pscustomobject]@{ lockPassword = '' }
    }
}

function Save-JsonAtomic {
    param([string]$Path, $Value)
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 20), $script:Utf8NoBom)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Get-SecretValues {
    $paths = @(
        'credentials.H1111_SESSION', 'credentials.H1111_USER', 'credentials.H1111_PASSWORD',
        'credentials.GH_TOKEN', 'credentials.PUSH_TOKEN', 'wifi.password', 'security.lockPassword'
    )
    $values = New-Object System.Collections.Generic.List[string]
    foreach ($path in $paths) {
        $value = [string](Get-ConfigValue $script:Config $path '')
        if ($value.Length -ge 3 -and -not $values.Contains($value)) { $values.Add($value) }
    }
    return $values
}

function Redact-Text {
    param([AllowNull()][string]$Text, [int]$MaxLength = 2500)
    if ($null -eq $Text) { return '' }
    $value = $Text -replace '[\r\n\t]+', ' '
    foreach ($secret in (Get-SecretValues)) { $value = $value.Replace($secret, '***') }
    $value = [regex]::Replace($value, '(?i)(gh[pousr]_[A-Za-z0-9_]{12,})', '***')
    $value = [regex]::Replace($value, '(?i)(Bearer\s+)[A-Za-z0-9._~+/-]+=*', '$1***')
    $value = [regex]::Replace($value, '(?i)(https?://)[^/@\s:]+:[^/@\s]+@', '$1***@')
    if ($value.Length -gt $MaxLength) { return $value.Substring(0, $MaxLength) + '…' }
    return $value
}

function Write-Log {
    param([string]$Text, [ValidateSet('DEBUG', 'INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
    if ($Level -eq 'DEBUG' -and -not $script:VerboseLogging) { return }
    try {
        $now = Get-Date
        $folder = Join-Path (Join-Path (Join-Path (Join-Path $script:LogsDir $now.ToString('yyyy')) $now.ToString('MM')) $now.ToString('dd')) ''
        [void][IO.Directory]::CreateDirectory($folder)
        $path = Join-Path $folder 'tray.log'
        $stamp = $now.ToString('yyyy-MM-dd HH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture)
        $line = '[{0}] [{1}] [{2}] {3}' -f $stamp, $Level, $script:AppName, (Redact-Text $Text)
        [IO.File]::AppendAllText($path, $line + "`r`n", $script:Utf8NoBom)
    }
    catch { }
}

function Show-ErrorMessage {
    param([string]$Text)
    Write-Log $Text 'ERROR'
    if ($script:NoTrayMode) { return }
    try {
        [void][Windows.Forms.MessageBox]::Show((Redact-Text $Text 1200), $script:AppName, [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
    }
    catch { }
}

function Format-NextRun {
    if ($null -eq $script:NextRunAt) {
        if ($script:Running) { return '本轮结束后安排' }
        if ($script:Paused) { return '未安排（已暂停）' }
        return '未安排'
    }
    return ([datetime]$script:NextRunAt).ToString('yyyy-MM-dd HH:mm:ss')
}

function Format-HHmm {
    param($Value)
    if ($null -eq $Value) { return '' }
    try { return ([datetime]$Value).ToString('HH:mm') } catch { return '' }
}

function Get-StatusLines {
    $lines = @(('自启动后已同步{0}次' -f [int]$script:State.totalRuns))
    if ($null -ne $script:State.lastRun) {
        $finished = Format-HHmm (Get-ConfigValue $script:State.lastRun 'finishedAt' $null)
        if ($finished) { $lines += ('上次在' + $finished) }
        $status = [string](Get-ConfigValue $script:State.lastRun 'status' '未知')
        $label = switch ($status) {
            'success' { '上次成功' }
            'up-to-date' { '上次已是最新' }
            'failure' { '上次失败' }
            'internal-error' { '上次内部错误' }
            default { '上次' + $status }
        }
        $lines += $label
    }
    $nextText = if ($null -ne $script:NextRunAt) { Format-HHmm $script:NextRunAt }
    elseif ($script:Running) { '本轮结束后安排' }
    elseif ($script:Paused) { '未安排（已暂停）' }
    else { '未安排' }
    $lines += ('下次在' + $nextText)
    return $lines
}

# ----------------------------- 单实例 -----------------------------
function Get-InstanceMutexName {
    $bytes = [Text.Encoding]::UTF8.GetBytes($script:RepoRoot.ToLowerInvariant())
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = $hash.ComputeHash($bytes) }
    finally { $hash.Dispose() }
    return 'Local\fdn-autosync-tray-' + (($digest | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Acquire-InstanceMutex {
    if ($Install -or $Uninstall) { return $true }
    try {
        $created = $false
        $script:InstanceMutex = New-Object Threading.Mutex($true, (Get-InstanceMutexName), [ref]$created)
        if (-not $created) {
            try { $script:InstanceMutex.Dispose() } catch { }
            $script:InstanceMutex = $null
            return $false
        }
        $script:InstanceMutexOwned = $true
        return $true
    }
    catch {
        Write-Log ('无法创建单实例互斥体：' + $_.Exception.Message) 'ERROR'
        return $false
    }
}

function Release-InstanceMutex {
    if ($script:InstanceMutexOwned -and $null -ne $script:InstanceMutex) {
        try { [void]$script:InstanceMutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $script:InstanceMutex) { try { $script:InstanceMutex.Dispose() } catch { } }
    $script:InstanceMutex = $null
    $script:InstanceMutexOwned = $false
}

# ----------------------------- 配置与状态 -----------------------------
function Load-Config {
    if (-not (Test-Path -LiteralPath $script:ConfigPath -PathType Leaf)) {
        $script:Config = New-DefaultConfig
        Save-JsonAtomic $script:ConfigPath $script:Config
        return
    }
    try {
        $script:Config = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $defaultsChanged = Merge-ConfigDefaults $script:Config (New-DefaultConfig)
        if ($defaultsChanged) { Save-JsonAtomic $script:ConfigPath $script:Config }
    }
    catch {
        $backup = $script:ConfigPath + '.corrupt-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
        try { Copy-Item -LiteralPath $script:ConfigPath -Destination $backup -Force } catch { }
        throw ('配置文件格式错误；原文件已尽量备份到 ' + $backup)
    }
}

function New-DefaultState {
    return [pscustomobject]@{
        version = 1
        locked = $false
        paused = $false
        totalRuns = 0
        lastRun = $null
        nextRunAt = $null
        stats = [pscustomobject]@{ success = 0; 'up-to-date' = 0; failure = 0; 'internal-error' = 0 }
        notification = [pscustomobject]@{ pendingRuns = 0; success = 0; 'up-to-date' = 0; failure = 0; 'internal-error' = 0 }
    }
}

function Load-State {
    $script:State = New-DefaultState
    if (Test-Path -LiteralPath $script:StatePath -PathType Leaf) {
        try {
            $raw = Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json -ErrorAction Stop
            foreach ($property in @('totalRuns', 'lastRun', 'nextRunAt')) {
                if ($null -ne $raw.PSObject.Properties[$property]) { $script:State.$property = $raw.$property }
            }
            if ($null -ne $raw.PSObject.Properties['stats']) { $script:State.stats = $raw.stats }
            elseif ($null -ne $raw.PSObject.Properties['counts']) { $script:State.stats = $raw.counts }
            if ($null -ne $raw.PSObject.Properties['notification']) { $script:State.notification = $raw.notification }
            $defaults = New-DefaultState
            if ($null -eq $script:State.stats -or -not ($script:State.stats -is [pscustomobject])) { $script:State.stats = $defaults.stats }
            else { [void](Merge-ConfigDefaults $script:State.stats $defaults.stats) }
            if ($null -eq $script:State.notification -or -not ($script:State.notification -is [pscustomobject])) { $script:State.notification = $defaults.notification }
            else { [void](Merge-ConfigDefaults $script:State.notification $defaults.notification) }
            $script:Locked = [bool](Get-ConfigValue $raw 'locked' $false)
            $script:Paused = [bool](Get-ConfigValue $raw 'paused' $false)
        }
        catch {
            $backup = $script:StatePath + '.corrupt-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
            try { Copy-Item -LiteralPath $script:StatePath -Destination $backup -Force } catch { }
            Write-Log ('状态文件损坏，已恢复默认：' + $_.Exception.Message) 'ERROR'
        }
    }
    $script:State.locked = $script:Locked
    $script:State.paused = $script:Paused
}

function Save-State {
    $script:State.locked = $script:Locked
    $script:State.paused = $script:Paused
    $script:State.nextRunAt = if ($null -eq $script:NextRunAt) { $null } else { ([datetime]$script:NextRunAt).ToString('o') }
    try { Save-JsonAtomic $script:StatePath $script:State } catch { Write-Log ('保存状态失败：' + $_.Exception.Message) 'ERROR' }
}

function Save-Config {
    try { Save-JsonAtomic $script:ConfigPath $script:Config; return $true }
    catch { Show-ErrorMessage ('保存配置失败：' + $_.Exception.Message); return $false }
}

function Set-ConfigText {
    param([string]$Path, [string]$Title, [string]$Label, [switch]$Password)
    $old = [string](Get-ConfigValue $script:Config $Path '')
    $value = Show-TextInput $Title $Label $old $Password
    if ($null -ne $value) { Set-ConfigValue $script:Config $Path $value; Save-Config | Out-Null; Build-TrayMenu }
}

function Set-ConfigNumber {
    param([string]$Path, [string]$Title, [string]$Label, [int]$Min = 1, [int]$Max = 1440)
    $old = [string](Get-ConfigValue $script:Config $Path $Min)
    $value = Show-TextInput $Title $Label $old
    if ($null -eq $value) { return }
    $number = 0
    if (-not [int]::TryParse($value, [ref]$number) -or $number -lt $Min -or $number -gt $Max) { Show-ErrorMessage ("请输入 {0} 到 {1} 之间的整数" -f $Min, $Max); return }
    Set-ConfigValue $script:Config $Path $number
    Save-Config | Out-Null
    Build-TrayMenu
}

function Toggle-Config {
    param([string]$Path)
    Set-ConfigValue $script:Config $Path (-not [bool](Get-ConfigValue $script:Config $Path $false))
    Save-Config | Out-Null
    Build-TrayMenu
}

function Set-ConfigEnum {
    param([string]$Path, [string]$Value)
    Set-ConfigValue $script:Config $Path $Value
    Save-Config | Out-Null
    Build-TrayMenu
}

# ----------------------------- WinForms 输入与路径 -----------------------------
function Show-TextInput {
    param([string]$Title, [string]$Label, [string]$Value = '', [bool]$Password = $false)
    $form = New-Object Windows.Forms.Form
    $form.Text = $Title
    $form.Width = 460
    $form.Height = 155
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $labelControl = New-Object Windows.Forms.Label
    $labelControl.Text = $Label
    $labelControl.Left = 12
    $labelControl.Top = 15
    $labelControl.AutoSize = $true
    $text = New-Object Windows.Forms.TextBox
    $text.Left = 12
    $text.Top = 42
    $text.Width = 420
    $text.Text = $Value
    $text.UseSystemPasswordChar = $Password
    $ok = New-Object Windows.Forms.Button
    $ok.Text = '确定'
    $ok.Left = 265
    $ok.Top = 78
    $ok.Width = 80
    $ok.DialogResult = [Windows.Forms.DialogResult]::OK
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = '取消'
    $cancel.Left = 352
    $cancel.Top = 78
    $cancel.Width = 80
    $cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $form.Controls.AddRange(@($labelControl, $text, $ok, $cancel))
    $form.AcceptButton = $ok
    $form.CancelButton = $cancel
    if ($form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { return $text.Text }
    return $null
}

function Open-Path { param([string]$Path) if (Test-Path -LiteralPath $Path) { Start-Process -FilePath 'explorer.exe' -ArgumentList @($Path) } else { Show-ErrorMessage ('路径不存在：' + $Path) } }

function Install-StartupShortcut {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($script:StartupShortcutPath)
        $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $shortcut.Arguments = '"' + $script:StartVbsPath + '"'
        $shortcut.WorkingDirectory = $script:LocalDir
        $shortcut.Description = 'fdn-autosync-tray 自动同步'
        $shortcut.Save()
        Set-ConfigValue $script:Config 'startup.enabled' $true
        Save-Config | Out-Null
    }
    catch { Show-ErrorMessage ('创建开机自启动失败：' + $_.Exception.Message) }
}

function Remove-StartupShortcut {
    if (Test-Path -LiteralPath $script:StartupShortcutPath) { Remove-Item -LiteralPath $script:StartupShortcutPath -Force }
    Set-ConfigValue $script:Config 'startup.enabled' $false
    Save-Config | Out-Null
}

function Select-IconFile {
    $dialog = New-Object Windows.Forms.OpenFileDialog
    $dialog.Filter = '图片|*.png;*.bmp;*.ico|所有文件|*.*'
    if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
    try {
        $extension = [IO.Path]::GetExtension($dialog.FileName).ToLowerInvariant()
        $target = Join-Path $script:AssetsDir ('user-icon' + $extension)
        [void][IO.Directory]::CreateDirectory($script:AssetsDir)
        Copy-Item -LiteralPath $dialog.FileName -Destination $target -Force
        Set-ConfigValue $script:Config 'appearance.iconPath' ('assets/user-icon' + $extension)
        if (Save-Config) { Update-TrayIcon }
    }
    catch { Show-ErrorMessage ('复制托盘底图失败：' + $_.Exception.Message) }
}

function Reset-IconFile {
    Set-ConfigValue $script:Config 'appearance.iconPath' $null
    Save-Config | Out-Null
    Update-TrayIcon
}

# ----------------------------- 菜单 -----------------------------
function Add-MenuControl {
    param($Menu, $Control)
    if ($Menu -is [Windows.Forms.ContextMenuStrip]) { [void]$Menu.Items.Add($Control) }
    elseif ($Menu -is [Windows.Forms.ToolStripItem]) { [void]$Menu.DropDownItems.Add($Control) }
    else { throw '菜单容器类型不受支持' }
}

function New-MenuItem {
    param($Menu, [string]$Text, [scriptblock]$Action = $null, [bool]$Enabled = $true, [bool]$Checked = $false)
    $item = New-Object Windows.Forms.ToolStripMenuItem
    $item.Text = $Text
    $item.Enabled = $Enabled
    $item.Checked = $Checked
    if ($null -ne $Action) { $item.Add_Click($Action) }
    Add-MenuControl $Menu $item
    return $item
}

function New-InfoItem { param($Menu, [string]$Text) [void](New-MenuItem $Menu $Text $null $false $false) }
function Add-Separator { param($Menu) Add-MenuControl $Menu (New-Object Windows.Forms.ToolStripSeparator) }

function Add-ConfigToggle {
    param($Menu, [string]$Text, [string]$Path, [bool]$Invert = $false)
    $checked = [bool](Get-ConfigValue $script:Config $Path $false)
    $action = { Toggle-Config $Path }.GetNewClosure()
    if ($Invert) { $checked = -not $checked }
    [void](New-MenuItem $Menu $Text $action $true $checked)
}

function Add-ConfigRadio {
    param($Menu, [string]$Text, [string]$Path, [string]$Value)
    $checked = ([string](Get-ConfigValue $script:Config $Path '') -eq $Value)
    $action = { Set-ConfigEnum $Path $Value }.GetNewClosure()
    [void](New-MenuItem $Menu $Text $action $true $checked)
}

function Add-TextConfigItem {
    param($Menu, [string]$Text, [string]$Path, [string]$Title, [string]$Label, [bool]$Password = $false)
    $action = { Set-ConfigText $Path $Title $Label -Password:$Password }.GetNewClosure()
    [void](New-MenuItem $Menu $Text $action)
}

function Toggle-Startup {
    if (Test-Path -LiteralPath $script:StartupShortcutPath) { Remove-StartupShortcut }
    else { Install-StartupShortcut }
    Build-TrayMenu
}

function New-SubMenu {
    param($Menu, [string]$Text)
    $item = New-Object Windows.Forms.ToolStripMenuItem
    $item.Text = $Text
    Add-MenuControl $Menu $item
    return $item
}

function Build-ConfigMenu {
    param($Menu)
    $configRoot = New-SubMenu $Menu '配置'

    $deployment = New-SubMenu $configRoot '部署'
    $startupChecked = Test-Path -LiteralPath $script:StartupShortcutPath
    [void](New-MenuItem $deployment '开机自启' { Toggle-Startup } $true $startupChecked)
    $appearance = New-SubMenu $deployment '托盘外观'
    $icon = New-SubMenu $appearance '图标'
    [void](New-MenuItem $icon '选择图片…' { Select-IconFile })
    [void](New-MenuItem $icon '重置' { Reset-IconFile })
    Add-ConfigToggle $deployment '启动后同步一次' 'startup.runOnStart'

    $prepare = New-SubMenu $configRoot '准备阶段'
    $wifi = New-SubMenu $prepare '无网时连指定WiFi'
    Add-ConfigToggle $wifi '总开关' 'wifi.enabled'
    Add-TextConfigItem $wifi '设定SSID…' 'wifi.ssid' 'WiFi SSID' 'SSID'
    Add-TextConfigItem $wifi '设定密码…' 'wifi.password' 'WiFi 密码' '密码' $true
    Add-ConfigToggle $wifi '优先使用已保存密码' 'wifi.useSavedFirst'
    Add-ConfigToggle $wifi '不检查网络，总是连' 'wifi.alwaysConnect'
    Add-ConfigToggle $wifi '失败时跳过整次' 'wifi.skipOnFailure'

    $pull = New-SubMenu $configRoot 'pull阶段'
    Add-ConfigToggle $pull '跳过此阶段' 'stages.pull.enabled' $true
    $rebase = New-SubMenu $pull '变基模式'
    Add-ConfigRadio $rebase 'rebase' 'stages.pull.strategy' 'rebase'
    Add-ConfigRadio $rebase 'ff-only' 'stages.pull.strategy' 'ff-only'

    $sync = New-SubMenu $configRoot 'sync阶段'
    Add-TextConfigItem $sync '设定H1111_SESSION…' 'credentials.H1111_SESSION' 'H1111_SESSION' '会话 Cookie' $true
    Add-TextConfigItem $sync '设定GH_TOKEN…' 'credentials.GH_TOKEN' 'GH_TOKEN' '只读 Token' $true

    $commit = New-SubMenu $configRoot 'commit阶段'
    Add-ConfigToggle $commit '跳过此阶段' 'stages.commit.enabled' $true
    $identity = New-SubMenu $commit 'git身份'
    Add-ConfigRadio $identity 'GHA' 'stages.commit.identityMode' 'gha'
    Add-ConfigRadio $identity '默认' 'stages.commit.identityMode' 'default'
    Add-ConfigRadio $identity '自定义' 'stages.commit.identityMode' 'custom'
    Add-TextConfigItem $identity '设定自定义用户名…' 'stages.commit.userName' 'Git 用户名' '用户名'
    Add-TextConfigItem $identity '设定自定义邮箱…' 'stages.commit.userEmail' 'Git 邮箱' '邮箱'

    $push = New-SubMenu $configRoot 'push阶段'
    Add-ConfigToggle $push '跳过此阶段' 'stages.push.enabled' $true
    Add-ConfigToggle $push '有未提交改动时跳过此阶段' 'stages.push.skipIfDirty'
    Add-TextConfigItem $push '设定PUSH_TOKEN…' 'credentials.PUSH_TOKEN' 'PUSH_TOKEN' '推送 Token' $true

    $finish = New-SubMenu $configRoot '结束阶段'
    $disconnect = New-SubMenu $finish '断开指定WiFi'
    Add-ConfigToggle $disconnect '无论是否成功，断开指定WiFi' 'wifi.disconnectAfter'
    Add-ConfigToggle $disconnect '并忘记' 'wifi.forgetOnDisconnect'
    $notifications = New-SubMenu $finish '通知'
    Add-ConfigRadio $notifications '标准模式' 'notifications.mode' 'standard'
    $standard = New-SubMenu $notifications '标准模式设置'
    Add-ConfigToggle $standard '成功' 'notifications.standard.success'
    Add-ConfigToggle $standard '已是最新' 'notifications.standard.up-to-date'
    Add-ConfigToggle $standard '失败' 'notifications.standard.failure'
    Add-ConfigToggle $standard '内部错误' 'notifications.standard.internal-error'
    Add-ConfigRadio $notifications '累积模式' 'notifications.mode' 'cumulative'
    $cumulative = New-SubMenu $notifications '累积模式设置'
    [void](New-MenuItem $cumulative '设定次数…' { Set-ConfigNumber 'notifications.cumulative.everyRuns' '累积通知次数' '次数' 1 100 })
    $internal = New-SubMenu $cumulative '内部错误处理'
    Add-ConfigRadio $internal '总是弹出' 'notifications.cumulative.internalErrorMode' 'always'
    Add-ConfigRadio $internal '不弹出' 'notifications.cumulative.internalErrorMode' 'never'

    [void](New-MenuItem $configRoot '设定间隔(min)…' { Set-ConfigNumber 'scheduler.intervalMinutes' '同步间隔' '分钟' 1 1440 })
    $misc = New-SubMenu $configRoot '杂项'
    [void](New-MenuItem $misc '设定日志保留天数…' { Set-ConfigNumber 'logging.retentionDays' '日志保留天数' '天数（0 = 永久）' 0 3650 })
    Add-TextConfigItem $misc '设定锁定密码…' 'security.lockPassword' '锁定密码' '密码' $true
}

function Convert-MenuItemToTree {
    param($Item)
    if ($Item -is [Windows.Forms.ToolStripSeparator]) { return '---' }
    $children = @()
    foreach ($child in $Item.DropDownItems) { $children += ,(Convert-MenuItemToTree $child) }
    if ($children.Count -eq 0) { return [string]$Item.Text }
    return [pscustomobject]@{ Text = [string]$Item.Text; Children = $children }
}

function Get-TrayMenuTree {
    $tree = @()
    foreach ($item in $script:ContextMenu.Items) { $tree += ,(Convert-MenuItemToTree $item) }
    return $tree
}

function Build-TrayMenu {
    if ($null -eq $script:ContextMenu) { return }
    $menu = $script:ContextMenu
    $menu.Items.Clear()
    $title = $script:AppName
    if ($script:Locked) { $title += '（已锁定）' }
    New-InfoItem $menu $title
    Add-Separator $menu
    foreach ($line in (Get-StatusLines)) { New-InfoItem $menu $line }
    Add-Separator $menu

    if ($script:Locked) {
        [void](New-MenuItem $menu '查看详细状态' { Show-Detail })
        [void](New-MenuItem $menu '立即同步' { Start-SyncRound } (-not $script:Running))
        [void](New-MenuItem $menu '解锁' { Unlock-Tray })
        [void](New-MenuItem $menu '浏览日志文件夹' { Open-Path $script:LogsDir })
        return
    }

    [void](New-MenuItem $menu '查看详细状态' { Show-Detail })
    [void](New-MenuItem $menu '立即同步' { Start-SyncRound } (-not $script:Running))
    $pauseText = if ($script:Paused) { '恢复自动同步' } else { '暂停自动同步' }
    [void](New-MenuItem $menu $pauseText { Toggle-Pause })
    [void](New-MenuItem $menu '锁定' { Lock-Tray })
    Add-Separator $menu

    $browse = New-SubMenu $menu '浏览'
    [void](New-MenuItem $browse '配置文件' { Open-Path $script:ConfigPath })
    [void](New-MenuItem $browse '日志文件夹' { Open-Path $script:LogsDir })
    Add-Separator $menu
    Build-ConfigMenu $menu
    Add-Separator $menu
    [void](New-MenuItem $menu '重启' { Request-Shutdown $true })
    [void](New-MenuItem $menu '退出' { Request-Shutdown $false })
}

# ----------------------------- 图标与通知 -----------------------------
function Get-BadgeName {
    if ($script:Running) { return 'running' }
    if ($script:Paused) { return 'paused' }
    if ($null -eq $script:State.lastRun) { return 'none' }
    switch ([string]$script:State.lastRun.status) {
        'success' { return 'success' }
        'up-to-date' { return 'up-to-date' }
        default { return 'failure' }
    }
}

function Update-TrayIcon {
    if ($null -eq $script:NotifyIcon -or -not (Test-Path -LiteralPath $script:IconCompose -PathType Leaf)) { return }
    $base = $script:DefaultIconPath
    $relative = [string](Get-ConfigValue $script:Config 'appearance.iconPath' '')
    if ($relative) {
        $custom = Join-Path $script:LocalDir ($relative -replace '/', '\')
        if (Test-Path -LiteralPath $custom -PathType Leaf) { $base = $custom }
    }
    $outDir = Join-Path $script:CacheDir 'single'
    $ico = Join-Path $outDir 'tray.ico'
    try {
        [void][IO.Directory]::CreateDirectory($outDir)
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:IconCompose -Base $base -Badge (Get-BadgeName) -OutDir $outDir -OutIco $ico 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ico -PathType Leaf)) { throw (($output | Out-String).Trim()) }
        $newIcon = New-Object Drawing.Icon($ico)
        $old = $script:CurrentIcon
        $script:CurrentIcon = $newIcon
        $script:NotifyIcon.Icon = $newIcon
        if ($null -ne $old) { $old.Dispose() }
    }
    catch { Write-Log ('图标更新失败：' + $_.Exception.Message) 'WARN' }
}

function Show-Notification {
    param($Result)
    if ($script:NoTrayMode -or $null -eq $script:NotifyIcon) { return }
    $status = [string]$Result.status
    $mode = [string](Get-ConfigValue $script:Config 'notifications.mode' 'standard')
    $show = $false
    $title = '自动同步'
    $text = [string]$Result.message
    if ($mode -eq 'standard') {
        $show = [bool](Get-ConfigValue $script:Config ('notifications.standard.' + $status) $false)
        switch ($status) {
            'success' { $title += '：成功' }
            'up-to-date' { $title += '：已是最新' }
            'failure' { $title += '：失败' }
            default { $title += '：内部错误' }
        }
        if ($Result.stats) { $text += ('；同步了 {0} 个资源，共 {1} 个版本。' -f $Result.stats.resources, $Result.stats.versions) }
    }
    else {
        $notification = $script:State.notification
        $notification.pendingRuns = [int]$notification.pendingRuns + 1
        if ($null -eq $notification.PSObject.Properties[$status]) { $notification | Add-Member NoteProperty $status 0 }
        $notification.$status = [int]$notification.$status + 1
        $every = [int](Get-ConfigValue $script:Config 'notifications.cumulative.everyRuns' 7)
        if ($status -eq 'internal-error' -and [string](Get-ConfigValue $script:Config 'notifications.cumulative.internalErrorMode' 'always') -eq 'always') {
            $show = $true
            $title = '自动同步：内部错误'
        }
        elseif ($notification.pendingRuns -ge $every) {
            $show = $true
            $title = '自动同步：运行汇总'
            $text = '自上次通知后：成功 {0} 次，已是最新 {1} 次，失败 {2} 次，内部错误 {3} 次。' -f $notification.success, $notification.'up-to-date', $notification.failure, $notification.'internal-error'
            $notification.pendingRuns = 0
            $notification.success = 0; $notification.'up-to-date' = 0; $notification.failure = 0; $notification.'internal-error' = 0
        }
        Save-State
    }
    if ($show) { try { $script:NotifyIcon.ShowBalloonTip(8000, $title, (Redact-Text $text 800), [Windows.Forms.ToolTipIcon]::Info) } catch { } }
}

function Protect-Result {
    param($Result)
    if ($null -eq $Result) { throw '同步没有返回结构化结果' }
    $status = [string]$Result.status
    if ($status -notin @('success', 'up-to-date', 'failure', 'internal-error')) { $status = 'internal-error' }
    $safe = [ordered]@{
        status = $status
        startedAt = [string](Get-ConfigValue $Result 'startedAt' '')
        finishedAt = [string](Get-ConfigValue $Result 'finishedAt' '')
        durationMs = [int][math]::Max(0, [int](Get-ConfigValue $Result 'durationMs' 0))
        message = Redact-Text ([string](Get-ConfigValue $Result 'message' '')) 1200
        stats = $null
        error = $null
        stages = @()
        warnings = @()
        committed = [bool](Get-ConfigValue $Result 'committed' $false)
        pushed = [bool](Get-ConfigValue $Result 'pushed' $false)
    }
    $stats = Get-ConfigValue $Result 'stats' $null
    if ($null -ne $stats) {
        $safe.stats = [pscustomobject]@{
            resources = [int][math]::Max(0, [int](Get-ConfigValue $stats 'resources' 0))
            versions = [int][math]::Max(0, [int](Get-ConfigValue $stats 'versions' 0))
        }
    }
    $error = Get-ConfigValue $Result 'error' $null
    if ($null -ne $error) {
        $safe.error = [pscustomobject]@{
            stage = Redact-Text ([string](Get-ConfigValue $error 'stage' '')) 120
            code = Redact-Text ([string](Get-ConfigValue $error 'code' '')) 120
            message = Redact-Text ([string](Get-ConfigValue $error 'message' '')) 800
        }
    }
    $stages = Get-ConfigValue $Result 'stages' @()
    foreach ($stage in @($stages)) {
        $safe.stages += [pscustomobject]@{
            name = Redact-Text ([string](Get-ConfigValue $stage 'name' '')) 120
            status = Redact-Text ([string](Get-ConfigValue $stage 'status' '')) 80
            message = Redact-Text ([string](Get-ConfigValue $stage 'message' '')) 800
        }
    }
    foreach ($warning in @(Get-ConfigValue $Result 'warnings' @())) { $safe.warnings += Redact-Text ([string]$warning) 600 }
    return [pscustomobject]$safe
}

function Show-Detail {
    $text = (Get-StatusLines) -join "`r`n"
    $text += "`r`n`r`n累计结果："
    foreach ($key in @('success', 'up-to-date', 'failure', 'internal-error')) { $text += "`r`n  $key：$($script:State.stats.$key)" }
    $lastStages = Get-ConfigValue $script:State.lastRun 'stages' @()
    if (@($lastStages).Count -gt 0) {
        $text += "`r`n`r`n最近一轮阶段："
        foreach ($stage in @($lastStages)) {
            $text += "`r`n  $(Redact-Text ([string](Get-ConfigValue $stage 'name' '')) 120)：$(Redact-Text ([string](Get-ConfigValue $stage 'status' '')) 80) · $(Redact-Text ([string](Get-ConfigValue $stage 'message' '')) 800)"
        }
    }
    $text = Redact-Text $text 6000
    [void][Windows.Forms.MessageBox]::Show($text, ($script:AppName + ' · 详细状态'), [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information)
}

# ----------------------------- 调度与同步 -----------------------------
function Toggle-Pause {
    $script:Paused = -not $script:Paused
    if ($script:Paused) { $script:NextRunAt = $null; $script:ScheduleTimer.Stop() }
    elseif (-not $script:Running) { $script:NextRunAt = (Get-Date).AddMinutes([int](Get-ConfigValue $script:Config 'scheduler.intervalMinutes' 10)); $script:ScheduleTimer.Start() }
    Save-State
    Build-TrayMenu
    Update-TrayIcon
}

function Start-SyncRound {
    if ($script:Running -or $script:ExitRequested) { return }
    $power = $null
    try {
        $configSnapshot = $script:Config | ConvertTo-Json -Depth 20 -Compress
        $configBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($configSnapshot))
        $script:RunNumber++
        $script:Running = $true
        $script:NextRunAt = $null
        if ($null -ne $script:ScheduleTimer) { $script:ScheduleTimer.Stop() }
        Build-TrayMenu
        Update-TrayIcon
        $power = [PowerShell]::Create()
        [void]$power.AddCommand($script:RoundPath)
        [void]$power.AddParameter('Root', $script:RepoRoot)
        [void]$power.AddParameter('LocalDir', $script:LocalDir)
        [void]$power.AddParameter('ConfigBase64', $configBase64)
        [void]$power.AddParameter('RunId', [string]$script:RunNumber)
        $script:Runspace = $power
        $script:RunAsync = $power.BeginInvoke()
        $script:RunTimer.Start()
        Write-Log '开始同步'
    }
    catch {
        if ($null -ne $power) { try { $power.Dispose() } catch { } }
        $script:Runspace = $null
        $script:RunAsync = $null
        $script:Running = $false
        if ($script:NoTrayMode) { $script:ExitRequested = $true }
        Write-Log ('无法启动同步 runspace：' + $_.Exception.Message) 'ERROR'
        Show-ErrorMessage ('无法启动同步：' + $_.Exception.Message)
        try { Build-TrayMenu; Update-TrayIcon } catch { }
    }
}

function Finish-SyncRound {
    if ($null -eq $script:Runspace -or $null -eq $script:RunAsync) { return }
    try {
        $objects = @($script:Runspace.EndInvoke($script:RunAsync))
        $rawResult = $objects | Select-Object -Last 1
        $result = Protect-Result $rawResult
        $script:State.totalRuns = [int]$script:State.totalRuns + 1
        $key = [string]$result.status
        if ($null -eq $script:State.stats.PSObject.Properties[$key]) { $key = 'internal-error' }
        $script:State.stats.$key = [int]$script:State.stats.$key + 1
        $script:State.lastRun = $result
        Show-Notification $result
        Write-Log ('同步结束：' + $result.status + '；' + $result.message)
    }
    catch { Show-ErrorMessage ('同步结果处理失败：' + $_.Exception.Message) }
    finally {
        $script:RunTimer.Stop()
        if ($null -ne $script:Runspace) { $script:Runspace.Dispose() }
        $script:Runspace = $null
        $script:RunAsync = $null
        $script:Running = $false
        if ($script:NoTrayMode) { $script:ExitRequested = $true }
        elseif (-not $script:Paused -and -not $script:ExitRequested) {
            $script:NextRunAt = (Get-Date).AddMinutes([int](Get-ConfigValue $script:Config 'scheduler.intervalMinutes' 10))
            $script:ScheduleTimer.Start()
        }
        Save-State
        Build-TrayMenu
        Update-TrayIcon
        if ($script:ExitRequested -and $null -eq $script:Runspace -and -not $script:NoTrayMode) { [Windows.Forms.Application]::Exit() }
    }
}

function Request-Shutdown {
    param([bool]$Restart)
    $script:RestartRequested = $Restart
    $script:ExitRequested = $true
    $script:ScheduleTimer.Stop()
    if ($script:Running) {
        Show-Notification ([pscustomobject]@{ status = 'up-to-date'; message = '当前同步结束后退出托盘'; stats = $null })
        return
    }
    if (-not $script:NoTrayMode) { [Windows.Forms.Application]::Exit() }
}

function Lock-Tray {
    $password = [string](Get-ConfigValue $script:Config 'security.lockPassword' '')
    if (-not $password) { Show-ErrorMessage '请先在“杂项 → 设定锁定密码”中设置密码'; return }
    $script:Locked = $true
    Save-State
    Build-TrayMenu
    Update-TrayIcon
}

function Unlock-Tray {
    $value = Show-TextInput '解锁' '锁定密码' '' $true
    if ($null -eq $value) { return }
    if ($value -ne [string](Get-ConfigValue $script:Config 'security.lockPassword' '')) { Show-ErrorMessage '密码错误'; return }
    $script:Locked = $false
    Save-State
    Build-TrayMenu
    Update-TrayIcon
}

# ----------------------------- 启动与收尾 -----------------------------
function Initialize-Tray {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    [Windows.Forms.Application]::EnableVisualStyles()

    if (-not $TestMenu -and -not (Acquire-InstanceMutex)) { return $false }
    if ($TestMenu) {
        # 只读地构造菜单树，使用内存默认配置，绝不读写用户的 config.json / state.json
        $script:Config = New-DefaultConfig
        $script:State = New-DefaultState
        $script:ContextMenu = New-Object Windows.Forms.ContextMenuStrip
        try {
            Build-TrayMenu
            $json = Get-TrayMenuTree | ConvertTo-Json -Depth 20 -Compress
            # 必须直接写控制台：若走管道输出，会污染 Initialize-Tray 的返回值，
            # 导致主流程误判为“初始化成功”并进入 Application.Run() 挂死。
            [Console]::Out.WriteLine($json)
            [Console]::Out.Flush()
        }
        finally { $script:ContextMenu.Dispose(); $script:ContextMenu = $null }
        return $false
    }
    Load-Config
    Load-State
    if (-not (Test-Path -LiteralPath $script:RoundPath -PathType Leaf)) { throw '找不到 round.ps1' }
    [void][IO.Directory]::CreateDirectory($script:LogsDir)

    if ($Install) { Install-StartupShortcut; return $false }
    if ($Uninstall) { Remove-StartupShortcut; return $false }

    $script:ScheduleTimer = New-Object Windows.Forms.Timer
    $script:ScheduleTimer.Interval = 1000
    $script:ScheduleTimer.Add_Tick({
        if ($null -ne $script:NextRunAt -and (Get-Date) -ge [datetime]$script:NextRunAt -and -not $script:Running) {
            $script:ScheduleTimer.Stop()
            Start-SyncRound
        }
    })
    $script:RunTimer = New-Object Windows.Forms.Timer
    $script:RunTimer.Interval = 500
    $script:RunTimer.Add_Tick({ if ($null -ne $script:Runspace -and $script:RunAsync.IsCompleted) { Finish-SyncRound } })

    if ($script:NoTrayMode) {
        # 无托盘模式用于联调：只执行一轮并在结果收回后退出，不常驻调度。
        if ($script:Paused) { $script:ExitRequested = $true }
        else { Start-SyncRound }
        return $true
    }

    $script:NotifyIcon = New-Object Windows.Forms.NotifyIcon
    $script:NotifyIcon.Text = $script:AppName
    $script:ContextMenu = New-Object Windows.Forms.ContextMenuStrip
    $script:NotifyIcon.ContextMenuStrip = $script:ContextMenu
    $script:NotifyIcon.Visible = $true
    $script:ContextMenu.Add_Opening({ Build-TrayMenu })

    Build-TrayMenu
    Update-TrayIcon
    if (-not $script:Paused -and [bool](Get-ConfigValue $script:Config 'startup.runOnStart' $true)) {
        Start-SyncRound
    }
    elseif (-not $script:Paused) {
        $script:NextRunAt = (Get-Date).AddMinutes([int](Get-ConfigValue $script:Config 'scheduler.intervalMinutes' 10))
        $script:ScheduleTimer.Start()
    }
    return $true
}

try {
    if (-not (Initialize-Tray)) { exit 0 }
    if ($script:NoTrayMode) {
        while (-not $script:ExitRequested) {
            Start-Sleep -Milliseconds 200
            if ($null -ne $script:Runspace -and $script:RunAsync.IsCompleted) { Finish-SyncRound }
        }
    }
    else {
        [Windows.Forms.Application]::Run()
    }
}
catch {
    Write-Log ('托盘启动失败：' + $_.Exception.Message) 'ERROR'
    Show-ErrorMessage ('托盘启动失败：' + $_.Exception.Message)
}
finally {
    if ($null -ne $script:ScheduleTimer) { $script:ScheduleTimer.Dispose() }
    if ($null -ne $script:RunTimer) { $script:RunTimer.Dispose() }
    if ($null -ne $script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose() }
    if ($null -ne $script:CurrentIcon) { $script:CurrentIcon.Dispose() }
    Release-InstanceMutex
    if ($script:RestartRequested) {
        try { Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList @('"' + $script:StartVbsPath + '"') -WorkingDirectory $script:LocalDir } catch { }
    }
}
