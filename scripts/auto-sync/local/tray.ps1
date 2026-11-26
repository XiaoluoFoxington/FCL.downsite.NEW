#Requires -Version 5.1
<#
.SYNOPSIS
    fdn-autosync-tray 托盘宿主（薄宿主：只做 Windows 集成，不做业务）。

.DESCRIPTION
    进程模型（PROTOCOL.md §1）：

        start.vbs (wscript, 无窗口)
          └─ powershell.exe -File tray.ps1     ← 本文件：托盘图标 / 菜单 / 窗口 / Toast / 自启动
               └─ node main.mjs                ← 本地业务（唯一调度器 + 唯一状态机，唯一读写配置/状态）

    职责边界：
      * 本脚本不做业务：不读 Git、不跑同步、不读写 config.json / state.json。
        （唯一例外：启动 Node 前只从 config.json 读取 runtime.nodePath 一个字段。）
      * 与 Node 通过 stdin/stdout 的 JSON Lines 通信，每行一个 JSON 对象（UTF-8）。
      * Node 的 stdout 只放协议消息；stderr 由本脚本追加写入 tray.log。
      * 宿主写出的 JSON 一律把非 ASCII 转成 \uXXXX，避免编码方向性歧义（PROTOCOL.md §3.4）。

    参数：
      -Install      创建当前用户 Startup 快捷方式（指向 start.vbs）后退出
      -Uninstall    删除该快捷方式后退出
      -NoTray       开发/自测模式：不建 NotifyIcon、不建菜单，但仍完整跑协议循环，
                    收到的每条消息都写进 tray.log
      -VerboseLog   额外记录 DEBUG 级日志

    环境变量（仅联调用，正常运行时不要设置）：
      FDN_TRAY_NODE_ARGS   覆盖传给 node 的参数（默认 <脚本目录>\main.mjs），
                           例如用桩脚本替换 main.mjs 做协议冒烟测试。

    注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 才不会把中文读成乱码）。
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$NoTray,
    [switch]$VerboseLog
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ============================ 全局状态 ============================

$script:AppName = 'fdn-autosync-tray'
$script:LogTag = '宿主'
$script:VerboseLogEnabled = [bool]$VerboseLog
$script:NoTrayMode = [bool]$NoTray

# 路径（全部由脚本自身位置推导，支持中文/空格/可移动目录）
$script:ScriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($script:ScriptDir)) {
    $script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$script:ConfigPath = Join-Path $script:ScriptDir 'config.json'
$script:StatePath = Join-Path $script:ScriptDir 'state.json'
$script:LogsDir = Join-Path $script:ScriptDir 'logs'
$script:AssetsDir = Join-Path $script:ScriptDir 'assets'
$script:DefaultIconPath = Join-Path $script:AssetsDir 'default.ico'
$script:SettingsScriptPath = Join-Path $script:ScriptDir 'settings.ps1'
$script:StartVbsPath = Join-Path $script:ScriptDir 'start.vbs'
$script:MainScriptPath = Join-Path $script:ScriptDir 'main.mjs'

# 启动项（当前用户 Startup 文件夹）
$script:StartupShortcutName = 'fdn-autosync-tray.lnk'
$script:LegacyShortcutNames = @('自动同步.lnk', '线路1自动同步.lnk')
$script:StartupDir = ''
$script:StartupShortcut = ''
$script:AutostartExists = $false

# Node 子进程与协议
$script:NodeProcess = $null
$script:NodeExe = ''
$script:NodeArguments = ''
$script:Bridge = $null
$script:NodeExitHandled = $false
$script:NodeExited = $false
$script:SeenFirstState = $false
$script:IdSeq = 0
$script:AckTable = $null
$script:State = $null
$script:AutostartStatusSent = $false
$script:PendingConfigFlagsRefresh = $false
$script:ConfigFlagsRequestId = ''
$script:ConfigFlagsRequestAt = $null
$script:ConfigStartupEnabled = $null
$script:ConfigHasLockPassword = $null
$script:ConfigFlagsKnown = $false

# UI 对象
$script:NotifyIcon = $null
$script:Menu = $null
$script:CurrentIcon = $null
$script:PumpTimer = $null
$script:AppContext = $null
$script:PumpInProgress = $false
$script:Stopping = $false
$script:CloseIntent = ''
$script:ToastReady = $null
$script:ToastAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$script:ExitCode = 0

# 编码（全程 UTF-8 无 BOM；日志文件也用它）
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ============================ 日志 ============================

function Write-TrayLog {
    param(
        [string]$Message,
        [ValidateSet('DEBUG', 'INFO', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )
    try {
        if ($Level -eq 'DEBUG' -and -not $script:VerboseLogEnabled) { return }
        $now = Get-Date
        $dir = Join-Path $script:LogsDir $now.ToString('yyyy')
        $dir = Join-Path $dir $now.ToString('MM')
        $dir = Join-Path $dir $now.ToString('dd')
        if (-not [System.IO.Directory]::Exists($dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
        $file = Join-Path $dir 'tray.log'
        # 注意：必须用 InvariantCulture。部分中文区域设置把「:」当成时间分隔符，
        # 用默认区域格式化 'HH:mm:ss' 会输出「20时36时15」这种畸形时间。
        $stamp = $now.ToString('yyyy-MM-dd HH:mm:ss.fff', [System.Globalization.CultureInfo]::InvariantCulture)
        $line = '[' + $stamp + '] [' + $Level + '] [' + $script:LogTag + '] ' + $Message
        [System.IO.File]::AppendAllText($file, $line + "`r`n", $script:Utf8NoBom)
    }
    catch {
        # 日志写失败绝不能影响托盘本身
    }
}

# 日志里截断 + 去掉连续空白，避免一条日志被撑爆
function Format-TextForLog {
    param([string]$Text, [int]$MaxLength = 300)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $clean = $Text -replace '[\r\n\t]+', ' '
    if ($clean.Length -gt $MaxLength) { $clean = $clean.Substring(0, $MaxLength) + '…' }
    return $clean
}

# -NoTray 下把每条收到的消息都落到 INFO，便于协议联调；正常运行时降到 DEBUG
function Write-ProtocolLog {
    param([string]$Text)
    if ($script:NoTrayMode) { Write-TrayLog $Text 'INFO' }
    else { Write-TrayLog $Text 'DEBUG' }
}

# ============================ 协议 JSON ============================

# PROTOCOL.md §3.4：ConvertTo-Json 后把非 ASCII 转成 \uXXXX，写出方向永远只有 ASCII
function ConvertTo-ProtocolJson {
    param($Object)
    $json = $Object | ConvertTo-Json -Depth 12 -Compress
    if ([string]::IsNullOrEmpty($json)) { return '{}' }
    return [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

function New-MessageId {
    param([string]$Prefix)
    $script:IdSeq = $script:IdSeq + 1
    return ($Prefix + '-' + $script:IdSeq)
}

# ConvertFrom-Json 得到 PSCustomObject，嵌套字段要转成 [ordered] 才能安全修改/回写
function ConvertTo-OrderedHashtable {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return $Value }
    if ($Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { return $Value }

    if ($Value -is [System.Collections.IDictionary]) {
        $map = [ordered]@{}
        foreach ($key in @($Value.Keys)) {
            $map[[string]$key] = ConvertTo-OrderedHashtable $Value[$key]
        }
        return $map
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $list = New-Object System.Collections.ArrayList
        foreach ($item in $Value) { [void]$list.Add((ConvertTo-OrderedHashtable $item)) }
        return , $list.ToArray()
    }
    try {
        $props = $Value.PSObject.Properties
        if ($null -ne $props -and $props.Count -gt 0) {
            $map = [ordered]@{}
            foreach ($p in $props) { $map[$p.Name] = ConvertTo-OrderedHashtable $p.Value }
            return $map
        }
    }
    catch {
    }
    return $Value
}

# 安全取字段：PSCustomObject / Hashtable 都适用，缺失或为空返回默认值
function Get-ObjectField {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    try {
        $prop = $Object.PSObject.Properties[$Name]
        if ($null -ne $prop -and $null -ne $prop.Value) { return $prop.Value }
    }
    catch {
    }
    try {
        if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
            $value = $Object[$Name]
            if ($null -ne $value) { return $value }
        }
    }
    catch {
    }
    return $Default
}

function Get-StateField {
    param([string]$Name, $Default = $null)
    return (Get-ObjectField $script:State $Name $Default)
}

function Get-IsLocked {
    return [bool](Get-StateField 'locked' $false)
}

# ============================ Node 子进程 ============================

# 只读 config.json 的 runtime.nodePath 一个字段（旧版配置在根上写 nodePath，也兼容读一次）
function Get-ConfiguredNodePath {
    try {
        if (-not (Test-Path -LiteralPath $script:ConfigPath -PathType Leaf)) { return '' }
        $raw = [System.IO.File]::ReadAllText($script:ConfigPath, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
        $cfg = $raw | ConvertFrom-Json
        $runtime = Get-ObjectField $cfg 'runtime' $null
        $path = ''
        if ($null -ne $runtime) { $path = [string](Get-ObjectField $runtime 'nodePath' '') }
        if ([string]::IsNullOrWhiteSpace($path)) { $path = [string](Get-ObjectField $cfg 'nodePath' '') }
        return $path.Trim()
    }
    catch {
        Write-TrayLog ('读取 config.json 的 runtime.nodePath 失败（将回退 PATH 里的 node）：' + $_.Exception.Message) 'WARN'
        return ''
    }
}

function Resolve-NodeExecutable {
    $configured = Get-ConfiguredNodePath
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        $candidate = $configured
        if (-not [System.IO.Path]::IsPathRooted($candidate)) {
            $candidate = Join-Path $script:ScriptDir $candidate
        }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return ([System.IO.Path]::GetFullPath($candidate)) }
        if (Test-Path -LiteralPath ($candidate + '.exe') -PathType Leaf) { return ([System.IO.Path]::GetFullPath($candidate + '.exe')) }
        Write-TrayLog ('config.json 的 runtime.nodePath 不存在：' + $candidate + '（回退 PATH 里的 node）') 'WARN'
    }
    $cmd = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cmd -and -not [string]::IsNullOrWhiteSpace($cmd.Source)) { return $cmd.Source }
    return ''
}

function Get-NodeArguments {
    $override = [string]$env:FDN_TRAY_NODE_ARGS
    if (-not [string]::IsNullOrWhiteSpace($override)) { return $override.Trim() }
    return ('"' + $script:MainScriptPath + '"')
}

function Initialize-NodeBridge {
    if ($null -ne $script:Bridge) { return }
    $code = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;

namespace FdnAutosyncTray
{
    /// stdout / stderr / 系统事件在这里入队，由 WinForms 定时器在 UI 线程取走处理。
    /// 这样既满足「BeginOutputReadLine 异步读」，又不用在非 PowerShell 线程里跑脚本块。
    public sealed class NodeBridge
    {
        private readonly ConcurrentQueue<string> _stdout = new ConcurrentQueue<string>();
        private readonly ConcurrentQueue<string> _stderr = new ConcurrentQueue<string>();
        private readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();

        public string[] DrainStdout() { return Drain(_stdout); }
        public string[] DrainStderr() { return Drain(_stderr); }
        public string[] DrainEvents() { return Drain(_events); }

        private static string[] Drain(ConcurrentQueue<string> queue)
        {
            List<string> list = new List<string>();
            string item;
            while (list.Count < 400 && queue.TryDequeue(out item)) { list.Add(item); }
            return list.ToArray();
        }

        public void Attach(Process process)
        {
            if (process == null) { return; }
            process.OutputDataReceived += OnStdout;
            process.ErrorDataReceived += OnStderr;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        public void Detach(Process process)
        {
            if (process == null) { return; }
            try { process.OutputDataReceived -= OnStdout; } catch { }
            try { process.ErrorDataReceived -= OnStderr; } catch { }
            try { process.CancelOutputRead(); } catch { }
            try { process.CancelErrorRead(); } catch { }
        }

        private void OnStdout(object sender, DataReceivedEventArgs e)
        {
            if (e != null && e.Data != null) { _stdout.Enqueue(e.Data); }
        }

        private void OnStderr(object sender, DataReceivedEventArgs e)
        {
            if (e != null && e.Data != null) { _stderr.Enqueue(e.Data); }
        }

        /// 系统从休眠恢复 → 入队 "wake"（SystemEvents 在自己的线程上触发，不能直接跑脚本块）
        public void WirePowerEvents()
        {
            try { Microsoft.Win32.SystemEvents.PowerModeChanged += OnPowerModeChanged; } catch { }
        }

        public void UnwirePowerEvents()
        {
            try { Microsoft.Win32.SystemEvents.PowerModeChanged -= OnPowerModeChanged; } catch { }
        }

        private void OnPowerModeChanged(object sender, Microsoft.Win32.PowerModeChangedEventArgs e)
        {
            if (e != null && e.Mode == Microsoft.Win32.PowerModes.Resume) { _events.Enqueue("wake"); }
        }
    }
}
'@
    Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.dll' -ErrorAction Stop
    $script:Bridge = New-Object FdnAutosyncTray.NodeBridge
}

function Start-NodeProcess {
    param([string]$NodeExe)

    $arguments = Get-NodeArguments

    # PROTOCOL.md §1.1：协议两个方向都按 UTF-8 处理（宿主写出的 JSON 本身已经是纯 ASCII）
    try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

    $process = New-Object System.Diagnostics.Process
    $startInfo = $process.StartInfo
    $startInfo.FileName = $NodeExe
    $startInfo.Arguments = $arguments
    $startInfo.WorkingDirectory = $script:ScriptDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $startInfo.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    if (-not $process.Start()) { throw 'Node 进程启动失败' }

    Initialize-NodeBridge
    $script:Bridge.Attach($process)
    $script:NodeProcess = $process
    $script:NodeExitHandled = $false
    $script:NodeExited = $false
    Write-TrayLog ('已启动 Node：' + $NodeExe + ' ' + $arguments + '（工作目录 ' + $script:ScriptDir + '）')
}

# 日志里只写「信封」（type/id/name/target/... 这些非敏感字段），
# 绝不写 password、config（含凭据）、data 等载荷——日志不能出现任何凭据值。
function Get-OutgoingSummary {
    param($Message)
    $parts = New-Object System.Collections.ArrayList
    foreach ($key in @('type', 'id', 'name', 'target', 'enabled', 'exists', 'ok', 'path', 'message')) {
        if ($Message.Contains($key)) {
            $value = $Message[$key]
            if ($null -eq $value) { continue }
            $text = [string]$value
            if ([string]::IsNullOrEmpty($text)) { continue }
            [void]$parts.Add($key + '=' + (Format-TextForLog $text 200))
        }
    }
    if ($Message.Contains('password')) { [void]$parts.Add('password=********') }
    if ($Message.Contains('config')) { [void]$parts.Add('config=<省略>') }
    if ($Message.Contains('data')) { [void]$parts.Add('data=<省略>') }
    return ($parts -join ' ')
}

function Send-NodeMessage {
    param($Message)
    if ($null -eq $script:NodeProcess -or $script:NodeExited) { return $false }
    try {
        $json = ConvertTo-ProtocolJson $Message
        $stdin = $script:NodeProcess.StandardInput
        if ($null -eq $stdin) { return $false }
        $stdin.WriteLine($json)
        $stdin.Flush()
        Write-TrayLog ('→ ' + (Get-OutgoingSummary $Message)) 'DEBUG'
        return $true
    }
    catch {
        Write-TrayLog ('写入 Node stdin 失败：' + $_.Exception.Message) 'ERROR'
        return $false
    }
}

function Send-NodeCommand {
    param([string]$Name, [hashtable]$Extra = $null)
    $message = [ordered]@{
        type = 'command'
        id   = (New-MessageId 'c')
        name = $Name
    }
    if ($null -ne $Extra) {
        foreach ($key in $Extra.Keys) { $message[[string]$key] = $Extra[$key] }
    }
    $ok = Send-NodeMessage $message
    if ($ok) {
        # 只记录命令名，绝不记录 password 等字段
        Write-TrayLog ('→ command ' + $Name + ' (id ' + $message['id'] + ')') 'DEBUG'
    }
    return $message['id']
}

function Send-NodeEvent {
    param([string]$Name, [hashtable]$Extra = $null)
    $message = [ordered]@{
        type = 'event'
        name = $Name
    }
    if ($null -ne $Extra) {
        foreach ($key in $Extra.Keys) { $message[[string]$key] = $Extra[$key] }
    }
    [void](Send-NodeMessage $message)
    Write-TrayLog ('→ event ' + $Name) 'DEBUG'
}

function Send-NodeAck {
    param([string]$Id, [bool]$Ok = $true, [string]$Message = '', $ErrorText = $null, $Data = $null)
    $ack = [ordered]@{
        type    = 'ack'
        id      = $Id
        ok      = $Ok
        message = $Message
        error   = $ErrorText
    }
    if ($null -ne $Data) { $ack['data'] = $Data }
    [void](Send-NodeMessage $ack)
}

# 等一条 ack：绝不阻塞读取线程（读取由 WinForms 定时器在 UI 线程完成），只泵 UI 消息
function Wait-NodeAck {
    param([string]$Id, [int]$TimeoutMs = 10000)
    if ([string]::IsNullOrWhiteSpace($Id)) { return $null }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($script:AckTable.ContainsKey($Id)) {
            $entry = $script:AckTable[$Id]
            [void]$script:AckTable.Remove($Id)
            return $entry
        }
        if ($script:NodeExited) { return $null }
        try { [System.Windows.Forms.Application]::DoEvents() } catch { }
        Start-Sleep -Milliseconds 30
    }
    Write-TrayLog ('等待 ack 超时：' + $Id + '（' + $TimeoutMs + 'ms）') 'WARN'
    return $null
}

# 发命令并等 ack（需要 UI 反馈的命令都走这里）
function Invoke-NodeCommand {
    param([string]$Name, [hashtable]$Extra = $null, [int]$TimeoutMs = 10000)
    $id = Send-NodeCommand -Name $Name -Extra $Extra
    if ([string]::IsNullOrWhiteSpace($id)) { return $null }
    return (Wait-NodeAck -Id $id -TimeoutMs $TimeoutMs)
}

function Wait-NodeState {
    param([scriptblock]$Condition, [int]$TimeoutMs = 8000)
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            if (& $Condition) { return $true }
        }
        catch {
        }
        if ($script:NodeExited) { return $false }
        try { [System.Windows.Forms.Application]::DoEvents() } catch { }
        Start-Sleep -Milliseconds 50
    }
    return $false
}

function Get-AckErrorText {
    param($Ack)
    if ($null -eq $Ack) { return 'Node 未响应（超时）' }
    $errorText = [string](Get-ObjectField $Ack 'error' '')
    $messageText = [string](Get-ObjectField $Ack 'message' '')
    if (-not [string]::IsNullOrWhiteSpace($messageText)) {
        if (-not [string]::IsNullOrWhiteSpace($errorText) -and $errorText -ne $messageText) {
            return ($messageText + '（' + $errorText + '）')
        }
        return $messageText
    }
    if (-not [string]::IsNullOrWhiteSpace($errorText)) { return $errorText }
    return '操作失败（Node 未给出原因）'
}

function Get-AckOk {
    param($Ack)
    if ($null -eq $Ack) { return $false }
    return [bool](Get-ObjectField $Ack 'ok' $false)
}

# ============================ 消息泵 ============================

function Test-NodeAlive {
    if ($null -eq $script:NodeProcess) { return $false }
    try { return (-not $script:NodeProcess.HasExited) }
    catch { return $false }
}

function Invoke-HostPump {
    # 防止 DoEvents 递归重入（等待 ack / 弹窗里的 DoEvents 会再次触发定时器）
    if ($script:PumpInProgress) { return }
    $script:PumpInProgress = $true
    try {
        if ($null -ne $script:Bridge) {
            foreach ($hostEvent in ($script:Bridge.DrainEvents())) {
                try { Handle-HostEvent $hostEvent }
                catch { Write-TrayLog ('处理系统事件异常：' + $_.Exception.Message) 'ERROR' }
            }
            foreach ($line in ($script:Bridge.DrainStderr())) {
                if (-not [string]::IsNullOrWhiteSpace($line)) {
                    Write-TrayLog ('[node] ' + (Format-TextForLog $line 1000)) 'INFO'
                }
            }
            foreach ($line in ($script:Bridge.DrainStdout())) {
                try { Read-NodeStdoutLine $line }
                catch { Write-TrayLog ('处理协议行异常：' + $_.Exception.Message) 'ERROR' }
            }
        }

        if (-not $script:SeenFirstState -and $script:AutostartStatusSent -eq $false -and (Test-NodeAlive)) {
            # Node 已启动但还没发首条 state：autostart-status 仍然尽早发出（stdin 有管道缓冲）
        }

        if (-not $script:NodeExitHandled) {
            if ($script:NodeProcess -and $script:NodeProcess.HasExited) {
                Handle-NodeExited
            }
        }

        # 延迟动作（不能在「正在处理消息」的栈里阻塞等待 ack；这里只发命令不等待）
        if ($script:PendingConfigFlagsRefresh) {
            $script:PendingConfigFlagsRefresh = $false
            try { Refresh-HostConfigFlags } catch { Write-TrayLog ('读取配置标志失败：' + $_.Exception.Message) 'WARN' }
        }

        # 配置标志请求超时（例如 Node 忙）：清掉在途标记，后续状态变化会重试
        if (-not [string]::IsNullOrEmpty($script:ConfigFlagsRequestId) -and $null -ne $script:ConfigFlagsRequestAt) {
            if (((Get-Date) - $script:ConfigFlagsRequestAt).TotalSeconds -gt 10) {
                Write-TrayLog ('读取配置标志超时，放弃本次请求（' + $script:ConfigFlagsRequestId + '）') 'DEBUG'
                $script:ConfigFlagsRequestId = ''
                $script:ConfigFlagsRequestAt = $null
            }
        }

        # 清理没人取走的 ack（例如 -NoTray 自检命令），避免无限增长
        if ($null -ne $script:AckTable -and $script:AckTable.Count -gt 0) {
            $expireBefore = (Get-Date).AddMinutes(-5)
            $stale = @()
            foreach ($key in @($script:AckTable.Keys)) {
                $entry = $script:AckTable[$key]
                if ($null -ne $entry -and [datetime]$entry.At -lt $expireBefore) { $stale += $key }
            }
            foreach ($key in $stale) { [void]$script:AckTable.Remove($key) }
        }
    }
    catch {
        Write-TrayLog ('消息泵异常：' + $_.Exception.Message) 'ERROR'
    }
    finally {
        $script:PumpInProgress = $false
    }
}

function Handle-HostEvent {
    param([string]$Name)
    switch ($Name) {
        'wake' {
            Write-TrayLog '系统从休眠恢复，通知 Node 核对计划时间'
            Send-NodeEvent 'wake'
        }
        default {
            Write-TrayLog ('未知宿主事件：' + $Name) 'WARN'
        }
    }
}

function Handle-NodeExited {
    if ($script:NodeExitHandled) { return }
    $script:NodeExitHandled = $true
    $script:NodeExited = $true
    $exitCode = -1
    try { $exitCode = $script:NodeProcess.ExitCode } catch { }

    if ($null -ne $script:Bridge -and $null -ne $script:NodeProcess) {
        try { $script:Bridge.Detach($script:NodeProcess) } catch { }
    }

    if ([string]::IsNullOrEmpty($script:CloseIntent) -and -not $script:SeenFirstState) {
        # PROTOCOL.md §1：Node 判定已有实例时立即 exit 0 且不输出任何消息 → 宿主静默退出
        Write-TrayLog ('Node 未发送任何状态即退出（退出码 ' + $exitCode + '），判定为已有实例在运行，宿主静默退出')
        Stop-TrayHost
        return
    }

    switch ($script:CloseIntent) {
        'restart' {
            Write-TrayLog ('Node 已退出（退出码 ' + $exitCode + '），准备重启托盘')
            if ($script:NoTrayMode) {
                Write-TrayLog '-NoTray 测试模式：不真的重启，只写日志'
            }
            else {
                Start-NewTrayInstance
            }
            Stop-TrayHost
        }
        'exit' {
            Write-TrayLog ('Node 已退出（退出码 ' + $exitCode + '），宿主退出')
            Stop-TrayHost
        }
        default {
            Write-TrayLog ('Node 意外退出（退出码 ' + $exitCode + '）') 'ERROR'
            Show-TrayBalloon '自动同步已停止' '后台同步进程已意外退出，托盘将关闭。请重新启动自动同步。' 'Error'
            Stop-TrayHost
        }
    }
}

# ============================ 协议消息处理 ============================

# 把一条协议消息压成一行可读摘要（中文原样，便于看日志排障）
function Get-MessageSummary {
    param($Message, [string]$Type)
    switch ($Type) {
        'state' {
            $data = Get-ObjectField $Message 'data' $null
            $lines = Get-ObjectField $data 'statusLines' $null
            $statusText = ''
            if ($null -ne $lines) {
                $parts = @()
                foreach ($line in $lines) { $parts += [string]$line }
                $statusText = ($parts -join ' / ')
            }
            return ('state 锁定=' + [bool](Get-ObjectField $data 'locked' $false) +
                ' 运行=' + [bool](Get-ObjectField $data 'running' $false) +
                ' 暂停=' + [bool](Get-ObjectField $data 'paused' $false) +
                ' 状态行：' + (Format-TextForLog $statusText 400))
        }
        'icon' {
            return ('icon ' + [string](Get-ObjectField $Message 'path' ''))
        }
        'notify' {
            return ('notify ' + (Format-TextForLog ([string](Get-ObjectField $Message 'title' '')) 60) +
                ' / ' + (Format-TextForLog ([string](Get-ObjectField $Message 'text' '')) 220))
        }
        'ack' {
            return ('ack ' + [string](Get-ObjectField $Message 'id' '') + ' ok=' + [bool](Get-ObjectField $Message 'ok' $false))
        }
        'action' {
            return ('action ' + [string](Get-ObjectField $Message 'name' '') + ' (id ' + [string](Get-ObjectField $Message 'id' '') + ')')
        }
        default {
            # 未知类型的载荷不落日志（可能含凭据），只记类型
            return ($Type + ' <未知类型，载荷不记录>')
        }
    }
}

function Read-NodeStdoutLine {
    param([string]$Line)
    if ([string]::IsNullOrWhiteSpace($Line)) { return }

    $message = $null
    try {
        $message = $Line | ConvertFrom-Json
    }
    catch {
        Write-TrayLog ('收到非法 JSON（已忽略）：' + (Format-TextForLog $Line 200)) 'WARN'
        return
    }
    if ($null -eq $message) {
        Write-TrayLog ('收到空 JSON（已忽略）：' + (Format-TextForLog $Line 200)) 'WARN'
        return
    }
    if ($message -is [System.Array]) {
        Write-TrayLog '收到 JSON 数组（协议要求单对象，已忽略）' 'WARN'
        return
    }

    $type = [string](Get-ObjectField $message 'type' '')
    if ([string]::IsNullOrWhiteSpace($type)) {
        Write-TrayLog ('收到缺少 type 的消息（已忽略）：' + (Format-TextForLog $Line 200)) 'WARN'
        return
    }

    # 可读摘要进日志（中文原样）；原始 JSON 行只在 -VerboseLog 下记 DEBUG，
    # 且只在「不含载荷的简单消息」上记（state/icon/notify/ack/action 的字段都是非敏感的）
    Write-ProtocolLog ('收到 ' + (Format-TextForLog (Get-MessageSummary $message $type) 900))
    if ($type -ne 'state' -and $type -ne 'icon' -and $type -ne 'notify' -and $type -ne 'ack' -and $type -ne 'action') {
        Write-TrayLog ('收到原始 JSON（未知类型）：' + (Format-TextForLog $Line 400)) 'DEBUG'
    }

    switch ($type) {
        'state' { Handle-StateMessage $message }
        'icon' { Handle-IconMessage $message }
        'notify' { Handle-NotifyMessage $message }
        'ack' { Handle-AckMessage $message }
        'action' { Handle-ActionMessage $message }
        default {
            Write-TrayLog ('忽略未知消息类型：' + $type) 'WARN'
        }
    }
}

function Handle-StateMessage {
    param($Message)
    $data = Get-ObjectField $Message 'data' $null
    if ($null -eq $data) {
        Write-TrayLog 'state 消息缺少 data（已忽略）' 'WARN'
        return
    }
    $script:State = $data
    if (-not $script:SeenFirstState) {
        $script:SeenFirstState = $true
        Write-TrayLog ('收到首条状态：锁定=' + (Get-IsLocked) + ' 运行=' + [bool](Get-StateField 'running' $false) + ' 暂停=' + [bool](Get-StateField 'paused' $false))
        # 首条状态到达后再补一次自启动探测结果（Node 可能启动很慢）
        if (-not $script:AutostartStatusSent) {
            Send-NodeEvent 'autostart-status' @{ exists = [bool]$script:AutostartExists }
            $script:AutostartStatusSent = $true
        }
        if ($script:NoTrayMode) {
            # 开发/自测模式（-NoTray）：主动发一条 get-status，把 command → ack 往返也跑一遍
            $selfCheckId = Send-NodeCommand -Name 'get-status'
            Write-TrayLog ('-NoTray 自检：已发送 get-status（id ' + $selfCheckId + '），等待 ack')
        }
    }

    Update-TrayTooltip

    if (-not $script:ConfigFlagsKnown -and -not (Get-IsLocked) -and (Test-NodeAlive)) {
        # 不能在这里同步等 ack（会卡住消息泵），交给下一轮定时器
        $script:PendingConfigFlagsRefresh = $true
    }

    if (-not $script:NoTrayMode -and $null -ne $script:Menu) {
        try {
            if (-not $script:Menu.Visible) { Build-TrayMenu }
        }
        catch {
            Write-TrayLog ('重建托盘菜单失败：' + $_.Exception.Message) 'ERROR'
        }
    }
}

function Handle-IconMessage {
    param($Message)
    $path = [string](Get-ObjectField $Message 'path' '')
    $tooltip = [string](Get-ObjectField $Message 'tooltip' '')
    if (-not [string]::IsNullOrWhiteSpace($tooltip)) {
        Set-TrayTooltip $tooltip
    }
    if ([string]::IsNullOrWhiteSpace($path)) {
        Write-TrayLog 'icon 消息没有 path（已忽略）' 'WARN'
        return
    }
    Set-TrayIconFromPath $path
}

function Handle-NotifyMessage {
    param($Message)
    $id = [string](Get-ObjectField $Message 'id' '')
    $title = [string](Get-ObjectField $Message 'title' $script:AppName)
    $text = [string](Get-ObjectField $Message 'text' '')

    # -NoTray 是开发/联调模式：不弹 Toast、不弹气泡，用日志代替（避免打扰正在使用旧托盘的用户）
    if ($script:NoTrayMode) {
        Write-TrayLog ('-NoTray 模式：通知仅记日志 → ' + (Format-TextForLog $title 60) + ' / ' + (Format-TextForLog $text 220)) 'INFO'
        if (-not [string]::IsNullOrWhiteSpace($id)) { Send-NodeAck -Id $id -Ok $true -Message '-NoTray: logged' }
        return
    }

    $ok = $false
    $errorText = $null
    try {
        $ok = Show-TrayToast $title $text
        if (-not $ok) {
            # Toast 不可用 → 退化成托盘气泡
            $ok = Show-TrayBalloon $title $text 'Info'
            if (-not $ok) { $errorText = 'no-toast-and-no-balloon' }
        }
    }
    catch {
        $errorText = $_.Exception.Message
        Write-TrayLog ('显示通知失败：' + $_.Exception.Message) 'WARN'
    }

    if ([string]::IsNullOrWhiteSpace($id)) {
        Write-TrayLog 'notify 消息没有 id，无法回 ack' 'WARN'
        return
    }
    # 无论成功失败都要回 ack：Node 只在 ok=true 时清零累积计数
    Send-NodeAck -Id $id -Ok ([bool]$ok) -Message '' -ErrorText $errorText
}

function Handle-AckMessage {
    param($Message)
    $id = [string](Get-ObjectField $Message 'id' '')
    if ([string]::IsNullOrWhiteSpace($id)) {
        Write-TrayLog '收到缺少 id 的 ack（已忽略）' 'WARN'
        return
    }
    $entry = @{
        Ok      = [bool](Get-ObjectField $Message 'ok' $false)
        Message = [string](Get-ObjectField $Message 'message' '')
        Error   = [string](Get-ObjectField $Message 'error' '')
        Data    = (Get-ObjectField $Message 'data' $null)
        At      = (Get-Date)
    }
    $script:AckTable[$id] = $entry
    # 摘要行已由 Read-NodeStdoutLine 记过，这里只补 DEBUG 明细
    Write-TrayLog ('ack 明细 ' + $id + ' ok=' + $entry.Ok + ' error=' + (Format-TextForLog $entry.Error 120)) 'DEBUG'

    # get-config 的回执：解析出「开机自启动 / 是否已设锁定密码」两个标志（不保留凭据）
    if (-not [string]::IsNullOrEmpty($script:ConfigFlagsRequestId) -and $id -eq $script:ConfigFlagsRequestId) {
        $script:ConfigFlagsRequestId = ''
        $script:ConfigFlagsRequestAt = $null
        if ($entry.Ok) {
            try { Complete-HostConfigFlags $Message }
            catch { Write-TrayLog ('解析配置标志失败：' + $_.Exception.Message) 'WARN' }
        }
    }
}

function Handle-ActionMessage {
    param($Message)
    $id = [string](Get-ObjectField $Message 'id' '')
    $name = [string](Get-ObjectField $Message 'name' '')

    if ($script:Stopping) {
        # 宿主正在退出：立即 ack，避免 Node 白等 5 秒
        if (-not [string]::IsNullOrWhiteSpace($id)) { Send-NodeAck -Id $id -Ok $true -Message '宿主正在退出' }
        return
    }

    $ok = $false
    $message = ''
    $errorText = $null
    $data = $null

    try {
        switch ($name) {
            'open-path' {
                $path = [string](Get-ObjectField $Message 'path' '')
                $opened = Open-PathSilent $path
                $ok = $opened
                if (-not $opened) { $errorText = 'not-found'; $message = '目标不存在' }
            }
            'restart' {
                $script:CloseIntent = 'restart'
                $ok = $true
                $message = '宿主准备重启'
                Write-TrayLog '收到 action restart：Node 已收尾，等进程退出后重启'
                Add-DeferredHostClose 'restart'
            }
            'exit' {
                $script:CloseIntent = 'exit'
                $ok = $true
                $message = '宿主准备退出'
                Write-TrayLog '收到 action exit：Node 已收尾，等进程退出后退出'
                Add-DeferredHostClose 'exit'
            }
            'repair-autostart' {
                # 幂等：enabled=true 时确保快捷方式存在，false 时确保不存在
                $enabled = [bool](Get-ObjectField $Message 'enabled' $true)
                $result = Set-Autostart $enabled
                $ok = [bool]$result.Ok
                $message = '开机自启动已更新'
                if (-not $ok) {
                    $errorText = [string]$result.Error
                    $message = '开机自启动更新失败'
                }
                $data = @{ exists = [bool]$script:AutostartExists }
            }
            'show-detail' {
                # 协议保留动作：详情窗口由宿主自己用 get-detail 的 ack 显示，这里只兼容性 ack
                $ok = $true
                $message = 'show-detail 由宿主自行处理'
            }
            default {
                $ok = $false
                $errorText = 'unknown-action'
                $message = ('未知动作：' + $name)
                Write-TrayLog ('收到未知 action：' + $name) 'WARN'
            }
        }
    }
    catch {
        $ok = $false
        $errorText = $_.Exception.Message
        $message = '宿主处理动作失败'
        Write-TrayLog ('处理 action 失败：' + $name + ' / ' + $_.Exception.Message) 'ERROR'
    }

    if (-not [string]::IsNullOrWhiteSpace($id)) {
        Send-NodeAck -Id $id -Ok ([bool]$ok) -Message $message -ErrorText $errorText -Data $data
    }

    if (-not [string]::IsNullOrEmpty($script:CloseIntent) -and ($name -eq 'exit' -or $name -eq 'restart')) {
        # Node 收到 ack 后会自己退出；宿主等进程退出事件，再收尾（不强杀）
        Write-TrayLog ('已 ack 关闭请求，等待 Node 自行退出（' + $name + '）')
    }
}

# ============================ 图标 ============================

# 图标全部由 Node 端合成（PROTOCOL.md §8），宿主只负责「加载 + 换上 + 释放旧的」。
# Node 写到缓存里的是传统 32bpp DIB 条目 ICO（icon-compose.ps1 -OutIco），
# 所以这里用最朴素的 System.Drawing.Icon 加载即可，宿主不再维护任何 ICO 解码逻辑。
function New-TrayIconFromFile {
    param([string]$Path)
    return (New-Object System.Drawing.Icon($Path))
}
function Set-TrayTooltip {
    param([string]$Text)
    if ($script:NoTrayMode -or $null -eq $script:NotifyIcon) { return }
    $tooltip = $Text
    if ([string]::IsNullOrWhiteSpace($tooltip)) { $tooltip = $script:AppName }
    $tooltip = $tooltip -replace '[\r\n\t]+', ' '
    if ($tooltip.Length -gt 63) { $tooltip = $tooltip.Substring(0, 62) + '…' }
    try {
        $script:NotifyIcon.Text = $tooltip
    }
    catch {
        try { $script:NotifyIcon.Text = $script:AppName } catch { }
    }
}

function Update-TrayTooltip {
    $tooltip = [string](Get-StateField 'tooltip' '')
    if ([string]::IsNullOrWhiteSpace($tooltip)) {
        if (Get-IsLocked) { $tooltip = $script:AppName + '（已锁定）' } else { $tooltip = $script:AppName }
    }
    Set-TrayTooltip $tooltip
}

function Set-TrayIconFromPath {
    param([string]$Path)
    if ($script:NoTrayMode -or $null -eq $script:NotifyIcon) { return }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-TrayLog ('图标文件不存在，保留上一张：' + $Path) 'WARN'
        return
    }
    $icon = $null
    try {
        $icon = New-TrayIconFromFile $Path
    }
    catch {
        Write-TrayLog ('加载图标失败，保留上一张：' + $Path + ' / ' + $_.Exception.Message) 'WARN'
        if ($null -ne $icon) { try { $icon.Dispose() } catch { } }
        return
    }
    if ($null -eq $icon) {
        Write-TrayLog ('图标解码为空，保留上一张：' + $Path) 'WARN'
        return
    }
    $old = $script:CurrentIcon
    try {
        $script:NotifyIcon.Icon = $icon
        $script:CurrentIcon = $icon
        Write-TrayLog ('托盘图标已更新：' + $Path) 'DEBUG'
    }
    catch {
        Write-TrayLog ('设置托盘图标失败：' + $_.Exception.Message) 'ERROR'
        try { $icon.Dispose() } catch { }
        return
    }
    if ($null -ne $old -and -not [object]::ReferenceEquals($old, $icon)) {
        try { $old.Dispose() } catch { }
    }
}

# ============================ Toast / 气泡 ============================

function Test-ToastAvailable {
    if ($null -ne $script:ToastReady) { return $script:ToastReady }
    $script:ToastReady = $false
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $script:ToastReady = $true
    }
    catch {
        Write-TrayLog ('WinRT Toast 不可用，将退化为气泡提示：' + $_.Exception.Message) 'WARN'
        $script:ToastReady = $false
    }
    return $script:ToastReady
}

function Show-TrayToast {
    param([string]$Title, [string]$Text)
    if (-not (Test-ToastAvailable)) { return $false }

    $safeTitle = [System.Security.SecurityElement]::Escape([string]$Title)
    $safeText = [System.Security.SecurityElement]::Escape([string]$Text)
    if ([string]::IsNullOrWhiteSpace($safeText)) {
        $xml = '<toast><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text></binding></visual></toast>'
    }
    else {
        $xml = '<toast><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text><text>' + $safeText + '</text></binding></visual></toast>'
    }

    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $document
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($script:ToastAppId)
    $notifier.Show($toast)
    Write-TrayLog ('已显示 Toast：' + (Format-TextForLog $Title 60) + ' / ' + (Format-TextForLog $Text 120)) 'DEBUG'
    return $true
}

function Show-TrayBalloon {
    param([string]$Title, [string]$Text, [string]$Kind = 'Info')
    if ($null -eq $script:NotifyIcon) { return $false }
    $iconKind = [System.Windows.Forms.ToolTipIcon]::Info
    if ($Kind -eq 'Error') { $iconKind = [System.Windows.Forms.ToolTipIcon]::Error }
    elseif ($Kind -eq 'Warning') { $iconKind = [System.Windows.Forms.ToolTipIcon]::Warning }
    $body = [string]$Text
    if ($body.Length -gt 250) { $body = $body.Substring(0, 250) + '…' }
    try {
        $script:NotifyIcon.ShowBalloonTip(8000, [string]$Title, $body, $iconKind)
        return $true
    }
    catch {
        Write-TrayLog ('气泡提示失败：' + $_.Exception.Message) 'WARN'
        return $false
    }
}

# ============================ 对话框 ============================

function Show-InfoBox {
    param([string]$Text, [string]$Title = 'fdn-autosync-tray')
    try { [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) }
    catch { Write-TrayLog ('显示提示框失败：' + $_.Exception.Message) 'WARN' }
}

function Show-ErrorBox {
    param([string]$Text, [string]$Title = 'fdn-autosync-tray')
    try { [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) }
    catch { Write-TrayLog ('显示错误框失败：' + $_.Exception.Message) 'WARN' }
}

function Show-ConfirmBox {
    param([string]$Text, [string]$Title = 'fdn-autosync-tray')
    try {
        $result = [System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
        return ($result -eq [System.Windows.Forms.DialogResult]::Yes)
    }
    catch {
        Write-TrayLog ('显示确认框失败：' + $_.Exception.Message) 'WARN'
        return $false
    }
}

# 单行密码输入；取消返回 $null
function Show-PasswordDialog {
    param([string]$Prompt, [string]$Title = 'fdn-autosync-tray')
    $form = New-Object System.Windows.Forms.Form
    $label = New-Object System.Windows.Forms.Label
    $textBox = New-Object System.Windows.Forms.TextBox
    $okButton = New-Object System.Windows.Forms.Button
    $cancelButton = New-Object System.Windows.Forms.Button
    try {
        $form.Text = $Title
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.MinimizeBox = $false
        $form.MaximizeBox = $false
        $form.ShowInTaskbar = $false
        $form.TopMost = $true
        $form.ClientSize = New-Object System.Drawing.Size(420, 150)

        $label.Text = $Prompt
        $label.Location = New-Object System.Drawing.Point(14, 14)
        $label.Size = New-Object System.Drawing.Size(392, 44)
        $form.Controls.Add($label)

        $textBox.Location = New-Object System.Drawing.Point(14, 62)
        $textBox.Size = New-Object System.Drawing.Size(392, 24)
        $textBox.UseSystemPasswordChar = $true
        $form.Controls.Add($textBox)

        $okButton.Text = '确定'
        $okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $okButton.Location = New-Object System.Drawing.Point(240, 108)
        $okButton.Size = New-Object System.Drawing.Size(78, 28)
        $form.Controls.Add($okButton)

        $cancelButton.Text = '取消'
        $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $cancelButton.Location = New-Object System.Drawing.Point(328, 108)
        $cancelButton.Size = New-Object System.Drawing.Size(78, 28)
        $form.Controls.Add($cancelButton)

        $form.AcceptButton = $okButton
        $form.CancelButton = $cancelButton

        $result = $form.ShowDialog()
        if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
        return [string]$textBox.Text
    }
    catch {
        Write-TrayLog ('显示密码框失败：' + $_.Exception.Message) 'WARN'
        return $null
    }
    finally {
        $form.Dispose()
    }
}

# 设置锁定密码：两次输入必须一致且非空；取消返回 $null
function Show-NewPasswordDialog {
    $form = New-Object System.Windows.Forms.Form
    $label1 = New-Object System.Windows.Forms.Label
    $box1 = New-Object System.Windows.Forms.TextBox
    $label2 = New-Object System.Windows.Forms.Label
    $box2 = New-Object System.Windows.Forms.TextBox
    $hint = New-Object System.Windows.Forms.Label
    $okButton = New-Object System.Windows.Forms.Button
    $cancelButton = New-Object System.Windows.Forms.Button
    try {
        $form.Text = '设置锁定密码'
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.MinimizeBox = $false
        $form.MaximizeBox = $false
        $form.ShowInTaskbar = $false
        $form.TopMost = $true
        $form.ClientSize = New-Object System.Drawing.Size(430, 210)

        $label1.Text = '密码：'
        $label1.Location = New-Object System.Drawing.Point(14, 18)
        $label1.Size = New-Object System.Drawing.Size(110, 20)
        $form.Controls.Add($label1)

        $box1.Location = New-Object System.Drawing.Point(130, 16)
        $box1.Size = New-Object System.Drawing.Size(280, 24)
        $box1.UseSystemPasswordChar = $true
        $form.Controls.Add($box1)

        $label2.Text = '再次输入：'
        $label2.Location = New-Object System.Drawing.Point(14, 56)
        $label2.Size = New-Object System.Drawing.Size(110, 20)
        $form.Controls.Add($label2)

        $box2.Location = New-Object System.Drawing.Point(130, 54)
        $box2.Size = New-Object System.Drawing.Size(280, 24)
        $box2.UseSystemPasswordChar = $true
        $form.Controls.Add($box2)

        $hint.Text = '锁定时菜单只保留：状态摘要、查看详细状态、立即同步、解锁、浏览日志文件夹。' + "`r`n" + '锁定只限制托盘菜单，不阻止直接访问文件。'
        $hint.ForeColor = [System.Drawing.Color]::DimGray
        $hint.Location = New-Object System.Drawing.Point(14, 92)
        $hint.Size = New-Object System.Drawing.Size(396, 46)
        $form.Controls.Add($hint)

        $okButton.Text = '确定'
        $okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $okButton.Location = New-Object System.Drawing.Point(240, 158)
        $okButton.Size = New-Object System.Drawing.Size(82, 28)
        $form.Controls.Add($okButton)

        $cancelButton.Text = '取消'
        $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $cancelButton.Location = New-Object System.Drawing.Point(330, 158)
        $cancelButton.Size = New-Object System.Drawing.Size(82, 28)
        $form.Controls.Add($cancelButton)

        $form.AcceptButton = $okButton
        $form.CancelButton = $cancelButton

        $result = $form.ShowDialog()
        if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }

        $first = [string]$box1.Text
        $second = [string]$box2.Text
        if ([string]::IsNullOrEmpty($first)) {
            Show-ErrorBox '密码不能为空。'
            return $null
        }
        if ($first -cne $second) {
            Show-ErrorBox '两次输入的密码不一致，请重新设置。'
            return $null
        }
        return $first
    }
    catch {
        Write-TrayLog ('显示设置密码窗口失败：' + $_.Exception.Message) 'WARN'
        return $null
    }
    finally {
        $form.Dispose()
    }
}

# 只读多行窗口（详细状态用）
function Show-ReadOnlyTextWindow {
    param([string]$Title, [string]$Text)
    $form = New-Object System.Windows.Forms.Form
    $textBox = New-Object System.Windows.Forms.TextBox
    $closeButton = New-Object System.Windows.Forms.Button
    try {
        $form.Text = $Title
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.MinimizeBox = $false
        $form.ShowInTaskbar = $false
        $form.TopMost = $true
        $form.ClientSize = New-Object System.Drawing.Size(560, 420)
        $form.MinimumSize = New-Object System.Drawing.Size(420, 300)

        $textBox.Multiline = $true
        $textBox.ReadOnly = $true
        $textBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
        $textBox.WordWrap = $true
        $textBox.Dock = [System.Windows.Forms.DockStyle]::Fill
        $textBox.Font = New-Object System.Drawing.Font('Consolas', 9)
        $textBox.BackColor = [System.Drawing.Color]::White
        $textBox.Text = [string]$Text
        $form.Controls.Add($textBox)

        $panel = New-Object System.Windows.Forms.Panel
        $panel.Dock = [System.Windows.Forms.DockStyle]::Bottom
        $panel.Height = 46
        $form.Controls.Add($panel)

        $closeButton.Text = '关闭'
        $closeButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $closeButton.Anchor = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right
        $closeButton.Location = New-Object System.Drawing.Point(464, 9)
        $closeButton.Size = New-Object System.Drawing.Size(82, 28)
        $panel.Controls.Add($closeButton)
        $form.AcceptButton = $closeButton
        $form.CancelButton = $closeButton

        [void]$form.ShowDialog()
    }
    catch {
        Write-TrayLog ('显示详情窗口失败：' + $_.Exception.Message) 'WARN'
    }
    finally {
        $form.Dispose()
    }
}

# ============================ 开机自启动 ============================

function Initialize-StartupPaths {
    try {
        $script:StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    }
    catch {
        $script:StartupDir = ''
    }
    if ([string]::IsNullOrWhiteSpace($script:StartupDir)) {
        try {
            $script:StartupDir = [Environment]::GetFolderPath('Startup')
        }
        catch {
            $script:StartupDir = ''
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($script:StartupDir)) {
        $script:StartupShortcut = Join-Path $script:StartupDir $script:StartupShortcutName
    }
    else {
        $script:StartupShortcut = ''
    }
}

function Test-AutostartShortcut {
    if ([string]::IsNullOrWhiteSpace($script:StartupShortcut)) { return $false }
    return (Test-Path -LiteralPath $script:StartupShortcut -PathType Leaf)
}

function Remove-LegacyShortcuts {
    if ([string]::IsNullOrWhiteSpace($script:StartupDir)) { return }
    foreach ($name in $script:LegacyShortcutNames) {
        $path = Join-Path $script:StartupDir $name
        try {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                Remove-Item -LiteralPath $path -Force -ErrorAction Stop
                Write-TrayLog ('已删除旧版开机启动快捷方式：' + $name)
            }
        }
        catch {
            Write-TrayLog ('删除旧版快捷方式失败：' + $name + ' / ' + $_.Exception.Message) 'WARN'
        }
    }
}

# 返回 @{ Ok = bool; Error = string|null }
function Install-AutostartShortcut {
    $result = @{ Ok = $false; Error = $null }
    if ([string]::IsNullOrWhiteSpace($script:StartupShortcut)) {
        $result.Error = '找不到当前用户 Startup 文件夹'
        return $result
    }
    if (-not (Test-Path -LiteralPath $script:StartVbsPath -PathType Leaf)) {
        $result.Error = 'start.vbs 不存在'
        return $result
    }
    $shell = $null
    try {
        Remove-LegacyShortcuts
        $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($script:StartupShortcut)
        $link.TargetPath = $wscript
        $link.Arguments = '"' + $script:StartVbsPath + '"'
        $link.WorkingDirectory = $script:ScriptDir
        $link.WindowStyle = 7
        $link.Description = 'fdn-autosync-tray（自动同步托盘）'
        if (Test-Path -LiteralPath $script:DefaultIconPath -PathType Leaf) {
            $link.IconLocation = $script:DefaultIconPath + ',0'
        }
        $link.Save()
        $result.Ok = $true
        Write-TrayLog ('已创建开机自启动快捷方式：' + $script:StartupShortcut)
    }
    catch {
        $result.Error = $_.Exception.Message
        Write-TrayLog ('创建开机自启动快捷方式失败：' + $_.Exception.Message) 'ERROR'
    }
    finally {
        if ($null -ne $shell) {
            try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch { }
        }
    }
    return $result
}

function Remove-AutostartShortcut {
    $result = @{ Ok = $false; Error = $null }
    try {
        if ((-not [string]::IsNullOrWhiteSpace($script:StartupShortcut)) -and (Test-Path -LiteralPath $script:StartupShortcut -PathType Leaf)) {
            Remove-Item -LiteralPath $script:StartupShortcut -Force -ErrorAction Stop
        }
        Remove-LegacyShortcuts
        $result.Ok = $true
        Write-TrayLog '已删除开机自启动快捷方式'
    }
    catch {
        $result.Error = $_.Exception.Message
        Write-TrayLog ('删除开机自启动快捷方式失败：' + $_.Exception.Message) 'ERROR'
    }
    return $result
}

# 创建/删除快捷方式，并把真实结果回给 Node（event autostart-changed）
function Set-Autostart {
    param([bool]$Enabled)
    $result = $null
    if ($Enabled) { $result = Install-AutostartShortcut }
    else { $result = Remove-AutostartShortcut }

    $script:AutostartExists = Test-AutostartShortcut
    $script:ConfigStartupEnabled = $script:AutostartExists
    Send-NodeEvent 'autostart-changed' @{
        enabled = [bool]$script:AutostartExists
        ok      = [bool]$result.Ok
        error   = $(if ($result.Ok) { $null } else { [string]$result.Error })
    }
    return $result
}

# ============================ 打开路径 / 详情 / 配置 ============================

function Open-PathSilent {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            Write-TrayLog ('打开失败（目标不存在）：' + $Path) 'WARN'
            return $false
        }
        Start-Process -FilePath $Path
        Write-TrayLog ('已打开：' + $Path) 'DEBUG'
        return $true
    }
    catch {
        Write-TrayLog ('打开失败：' + $Path + ' / ' + $_.Exception.Message) 'WARN'
        return $false
    }
}

# 打开命令统一走 Node 解析目标路径（宿主不自己拼业务路径）
function Invoke-OpenTarget {
    param([string]$Target)
    $ack = Invoke-NodeCommand -Name 'open' -Extra @{ target = $Target } -TimeoutMs 8000
    if (-not (Get-AckOk $ack)) {
        Show-ErrorBox ('无法打开「' + $Target + '」：' + (Get-AckErrorText $ack))
        return
    }
    $data = Get-ObjectField $ack 'data' $null
    $path = [string](Get-ObjectField $data 'path' '')
    if ([string]::IsNullOrWhiteSpace($path)) {
        Write-TrayLog ('open 的 ack 没有返回路径（target=' + $Target + '）') 'WARN'
        return
    }
    if (-not (Open-PathSilent $path)) { Show-ErrorBox ('目标不存在或无法打开：' + $path) }
}

function Format-DetailText {
    param($Detail)
    $lines = New-Object System.Collections.ArrayList
    if ($null -eq $Detail) {
        [void]$lines.Add('详细状态暂不可用（Node 未返回数据）。')
        return ($lines -join "`r`n")
    }
    [void]$lines.Add('当前状态：' + [string](Get-ObjectField $Detail 'statusText' '未知'))
    [void]$lines.Add('当前阶段：' + ([string](Get-ObjectField $Detail 'stageText' '阶段：—') -replace '^阶段：', ''))
    [void]$lines.Add('自启动后运行次数：' + [string](Get-ObjectField $Detail 'totalRuns' 0))

    $lastRun = Get-ObjectField $Detail 'lastRun' $null
    if ($null -eq $lastRun) {
        [void]$lines.Add('上次同步：尚未同步')
    }
    else {
        [void]$lines.Add('上次开始：' + [string](Get-ObjectField $lastRun 'startText' '未知'))
        [void]$lines.Add('上次结束：' + [string](Get-ObjectField $lastRun 'endText' '未知'))
        [void]$lines.Add('耗时：' + [string](Get-ObjectField $lastRun 'durationText' '未知'))
        [void]$lines.Add('上次结果：' + [string](Get-ObjectField $lastRun 'statusText' '未知'))
        $summary = [string](Get-ObjectField $lastRun 'message' '')
        if (-not [string]::IsNullOrWhiteSpace($summary)) { [void]$lines.Add('结果说明：' + $summary) }
        $errorText = [string](Get-ObjectField $lastRun 'errorText' '')
        if (-not [string]::IsNullOrWhiteSpace($errorText)) { [void]$lines.Add('错误信息：' + $errorText) }
    }

    $counts = Get-ObjectField $Detail 'counts' $null
    if ($null -ne $counts) {
        [void]$lines.Add('累计次数：成功 ' + [string](Get-ObjectField $counts 'success' 0) +
            ' · 已是最新 ' + [string](Get-ObjectField $counts 'up-to-date' 0) +
            ' · 失败 ' + [string](Get-ObjectField $counts 'failure' 0) +
            ' · 内部错误 ' + [string](Get-ObjectField $counts 'internal-error' 0))
    }

    [void]$lines.Add('下次同步：' + [string](Get-ObjectField $Detail 'nextRunText' '未安排'))
    $locked = [bool](Get-ObjectField $Detail 'locked' $false)
    [void]$lines.Add('锁定状态：' + $(if ($locked) { '已锁定' } else { '未锁定' }))
    [void]$lines.Add('')
    [void]$lines.Add('（本窗口只读，不包含任何凭据。）')
    return ($lines -join "`r`n")
}

function Invoke-ShowDetail {
    $ack = Invoke-NodeCommand -Name 'get-detail' -Extra $null -TimeoutMs 8000
    $detail = $null
    if (Get-AckOk $ack) {
        $data = Get-ObjectField $ack 'data' $null
        $detail = Get-ObjectField $data 'detail' $null
    }
    else {
        Write-TrayLog ('获取详细状态失败：' + (Get-AckErrorText $ack)) 'WARN'
    }
    if ($null -eq $detail) {
        # 退路：用最近一条 state 的 statusLines 显示，保证锁定状态下也能看到状态
        $fallback = New-Object System.Collections.ArrayList
        $statusLines = Get-StateField 'statusLines' $null
        if ($null -ne $statusLines) {
            foreach ($line in $statusLines) { [void]$fallback.Add([string]$line) }
        }
        if ($fallback.Count -eq 0) { [void]$fallback.Add('详细状态暂不可用。') }
        [void]$fallback.Add('')
        [void]$fallback.Add('（本窗口只读，不包含任何凭据。）')
        Show-ReadOnlyTextWindow -Title ($script:AppName + ' · 详细状态') -Text ($fallback -join "`r`n")
        return
    }
    Show-ReadOnlyTextWindow -Title ($script:AppName + ' · 详细状态') -Text (Format-DetailText $detail)
}

function Refresh-HostConfigFlags {
    # 只取「开机自启动是否启用」「是否已设锁定密码」两个标志，不保留任何凭据。
    # 注意：这里是「发一次 get-config，ack 回来时在 Handle-AckMessage 里解析」的事件驱动写法，
    # 绝不能在消息泵里同步等待 ack（会把读取线程一起卡住）。
    if (Get-IsLocked) { return }
    if (-not [string]::IsNullOrEmpty($script:ConfigFlagsRequestId)) { return }
    $id = Send-NodeCommand -Name 'get-config'
    if ([string]::IsNullOrEmpty($id)) { return }
    $script:ConfigFlagsRequestId = $id
    $script:ConfigFlagsRequestAt = Get-Date
    Write-TrayLog ('正在读取配置标志（开机自启动 / 锁定密码）id=' + $id) 'DEBUG'
}

function Complete-HostConfigFlags {
    param($Ack)
    $data = Get-ObjectField $Ack 'data' $null
    $config = Get-ObjectField $data 'config' $null
    if ($null -eq $config) { return }
    $startup = Get-ObjectField $config 'startup' $null
    if ($null -ne $startup) { $script:ConfigStartupEnabled = [bool](Get-ObjectField $startup 'enabled' $false) }
    $security = Get-ObjectField $config 'security' $null
    if ($null -ne $security) {
        $password = [string](Get-ObjectField $security 'lockPassword' '')
        $script:ConfigHasLockPassword = -not [string]::IsNullOrEmpty($password)
    }
    $script:ConfigFlagsKnown = $true
    Write-TrayLog ('配置标志：开机自启动=' + $script:ConfigStartupEnabled + ' 已设锁定密码=' + $script:ConfigHasLockPassword) 'DEBUG'
}

# 从配置里读 startup.enabled（读不到返回 $null）
function Get-StartupEnabledFromConfig {
    param($Config)
    if ($null -eq $Config) { return $null }
    $startup = $null
    try {
        if ($Config -is [System.Collections.IDictionary] -and $Config.Contains('startup')) { $startup = $Config['startup'] }
        elseif ($Config -isnot [System.Collections.IDictionary]) { $startup = Get-ObjectField $Config 'startup' $null }
    }
    catch {
        $startup = $null
    }
    if ($null -eq $startup) { return $null }
    try {
        if ($startup -is [System.Collections.IDictionary]) {
            if ($startup.Contains('enabled')) { return [bool]$startup['enabled'] }
            return $null
        }
        $value = Get-ObjectField $startup 'enabled' $null
        if ($null -eq $value) { return $null }
        return [bool]$value
    }
    catch {
        return $null
    }
}

function Invoke-OpenSettings {
    if (Get-IsLocked) {
        Show-InfoBox '已锁定，配置窗口不可用。请先解锁。'
        return
    }
    if (-not (Test-Path -LiteralPath $script:SettingsScriptPath -PathType Leaf)) {
        Show-ErrorBox ('找不到配置窗口脚本：' + $script:SettingsScriptPath)
        Write-TrayLog ('找不到 settings.ps1：' + $script:SettingsScriptPath) 'ERROR'
        return
    }

    $ack = Invoke-NodeCommand -Name 'get-config' -Extra $null -TimeoutMs 10000
    if (-not (Get-AckOk $ack)) {
        Show-ErrorBox ('读取配置失败：' + (Get-AckErrorText $ack))
        return
    }
    $data = Get-ObjectField $ack 'data' $null
    $rawConfig = Get-ObjectField $data 'config' $null
    if ($null -eq $rawConfig) {
        Show-ErrorBox '读取配置失败：Node 没有返回配置内容。'
        return
    }
    $config = ConvertTo-OrderedHashtable $rawConfig

    try {
        . $script:SettingsScriptPath
    }
    catch {
        Show-ErrorBox ('加载配置窗口失败：' + $_.Exception.Message)
        Write-TrayLog ('dot-source settings.ps1 失败：' + $_.Exception.Message) 'ERROR'
        return
    }
    if (-not (Get-Command 'Show-SettingsWindow' -CommandType Function -ErrorAction SilentlyContinue)) {
        Show-ErrorBox 'settings.ps1 里没有找到 Show-SettingsWindow 函数。'
        Write-TrayLog 'settings.ps1 缺少 Show-SettingsWindow 函数' 'ERROR'
        return
    }

    while ($true) {
        $newConfig = $null
        try {
            $newConfig = Show-SettingsWindow $config
        }
        catch {
            Show-ErrorBox ('配置窗口出错：' + $_.Exception.Message)
            Write-TrayLog ('配置窗口异常：' + $_.Exception.Message) 'ERROR'
            return
        }
        if ($null -eq $newConfig) { return }   # 用户取消

        # settings.ps1 把「选择图片 / 重置默认图标」表达成两个临时键：
        #   _iconAction = 'set' | 'reset' | $null，_iconPath = 用户原始图片全路径。
        # 先取出意图，再用它导出的 Remove-SettingsTransientKeys 去掉临时键后发给 Node。
        $iconAction = ''
        $iconPath = ''
        try {
            if ($newConfig -is [System.Collections.IDictionary]) {
                if ($newConfig.Contains('_iconAction')) { $iconAction = [string]$newConfig['_iconAction'] }
                if ($newConfig.Contains('_iconPath')) { $iconPath = [string]$newConfig['_iconPath'] }
            }
        }
        catch {
        }
        $payload = $newConfig
        if (Get-Command -Name 'Remove-SettingsTransientKeys' -CommandType Function -ErrorAction SilentlyContinue) {
            try { $payload = Remove-SettingsTransientKeys $newConfig } catch { $payload = $newConfig }
        }

        $saveAck = Invoke-NodeCommand -Name 'save-config' -Extra @{ config = $payload } -TimeoutMs 20000
        if (-not (Get-AckOk $saveAck)) {
            # 保留用户输入重开窗口；ack.message 是 Node 的中文校验错误
            $config = $newConfig
            Show-ErrorBox ('保存配置失败：' + (Get-AckErrorText $saveAck))
            continue
        }

        # ---- 保存成功：刷新宿主缓存的配置标志 ----
        $savedData = Get-ObjectField $saveAck 'data' $null
        $savedConfig = Get-ObjectField $savedData 'config' $null
        $effective = $payload
        if ($null -ne $savedConfig) { $effective = $savedConfig }
        $startupFlag = Get-StartupEnabledFromConfig $effective
        if ($null -ne $startupFlag) { $script:ConfigStartupEnabled = [bool]$startupFlag }
        $security = Get-ObjectField $effective 'security' $null
        if ($null -ne $security) {
            $password = [string](Get-ObjectField $security 'lockPassword' '')
            $script:ConfigHasLockPassword = -not [string]::IsNullOrEmpty($password)
        }
        $script:ConfigFlagsKnown = $true

        # ---- 开机自启动：窗口里改了就以真实快捷方式为准落实 ----
        if ($null -ne $startupFlag) {
            if ([bool]$startupFlag -ne [bool]$script:AutostartExists) {
                $autoResult = Set-Autostart ([bool]$startupFlag)
                if (-not $autoResult.Ok) {
                    Show-ErrorBox ('开机自启动设置失败：' + [string]$autoResult.Error + "`r`n`r`n" + '菜单里的勾选状态已按快捷方式的实际存在情况恢复。')
                }
            }
        }
        else {
            $script:AutostartExists = Test-AutostartShortcut
        }

        # ---- 图标意图：save-config 成功后再发 set-icon / reset-icon ----
        if ($iconAction -eq 'set') {
            if ([string]::IsNullOrWhiteSpace($iconPath)) {
                Show-ErrorBox '没有收到要使用的图片路径，图标未更改。'
            }
            else {
                $iconAck = Invoke-NodeCommand -Name 'set-icon' -Extra @{ path = $iconPath } -TimeoutMs 20000
                if (Get-AckOk $iconAck) { Write-TrayLog ('已更换托盘图标：' + $iconPath) }
                else { Show-ErrorBox ('更换图标失败：' + (Get-AckErrorText $iconAck)) }
            }
        }
        elseif ($iconAction -eq 'reset') {
            $iconAck = Invoke-NodeCommand -Name 'reset-icon' -Extra $null -TimeoutMs 15000
            if (Get-AckOk $iconAck) { Write-TrayLog '已恢复默认托盘图标' }
            else { Show-ErrorBox ('恢复默认图标失败：' + (Get-AckErrorText $iconAck)) }
        }

        Show-InfoBox '配置已保存。'
        return
    }
}

# ============================ 命令动作 ============================

function Invoke-SyncNow {
    if ([bool](Get-StateField 'running' $false)) { return }
    $ack = Invoke-NodeCommand -Name 'sync-now' -Extra $null -TimeoutMs 15000
    if (-not (Get-AckOk $ack)) {
        # 同步中重复触发、锁定等都属于正常控制结果，不弹框打断用户
        Write-TrayLog ('立即同步未被接受：' + (Get-AckErrorText $ack)) 'INFO'
    }
}

function Invoke-PauseToggle {
    $paused = [bool](Get-StateField 'paused' $false)
    $name = 'pause'
    if ($paused) { $name = 'resume' }
    $ack = Invoke-NodeCommand -Name $name -Extra $null -TimeoutMs 10000
    if (-not (Get-AckOk $ack)) {
        Show-ErrorBox ('操作失败：' + (Get-AckErrorText $ack))
        return
    }
    if ($paused) { Write-TrayLog '已请求恢复自动同步' } else { Write-TrayLog '已请求暂停自动同步' }
}

function Invoke-Lock {
    if (Get-IsLocked) { return }

    $password = ''
    $needsPassword = $false
    if ($null -eq $script:ConfigHasLockPassword) {
        # 还不知道有没有密码：先按空密码发一次，Node 会回 no-password
        $needsPassword = $true
    }
    elseif ($script:ConfigHasLockPassword -eq $false) {
        $needsPassword = $true
    }

    if ($needsPassword) {
        $ack = Invoke-NodeCommand -Name 'lock' -Extra @{ password = '' } -TimeoutMs 10000
        if (Get-AckOk $ack) {
            $script:ConfigHasLockPassword = $true
            return
        }
        $errorCode = [string](Get-ObjectField $ack 'error' '')
        if ($null -ne $ack -and $errorCode -ne 'no-password') {
            Show-ErrorBox ('锁定失败：' + (Get-AckErrorText $ack))
            return
        }
        # 没有密码：先让用户设置（两次一致、非空），再随 lock 命令发出
        $password = Show-NewPasswordDialog
        if ($null -eq $password) { return }
        $ack = Invoke-NodeCommand -Name 'lock' -Extra @{ password = $password } -TimeoutMs 10000
        if (-not (Get-AckOk $ack)) {
            Show-ErrorBox ('锁定失败：' + (Get-AckErrorText $ack))
            return
        }
        $script:ConfigHasLockPassword = $true
        $script:ConfigFlagsKnown = $true
        Write-TrayLog '已设置锁定密码并锁定托盘菜单'
        return
    }

    $ack = Invoke-NodeCommand -Name 'lock' -Extra @{ password = '' } -TimeoutMs 10000
    if (-not (Get-AckOk $ack)) {
        Show-ErrorBox ('锁定失败：' + (Get-AckErrorText $ack))
        return
    }
    Write-TrayLog '已锁定托盘菜单'
}

function Invoke-Unlock {
    $password = Show-PasswordDialog -Prompt '请输入锁定密码（取消 = 不解锁）。' -Title '解锁'
    if ($null -eq $password) { return }
    $ack = Invoke-NodeCommand -Name 'unlock' -Extra @{ password = $password } -TimeoutMs 10000
    if (Get-AckOk $ack) {
        Write-TrayLog '菜单已解锁'
        return
    }
    $errorCode = [string](Get-ObjectField $ack 'error' '')
    if ($errorCode -eq 'bad-password') { Show-ErrorBox '密码错误。' }
    else { Show-ErrorBox ('解锁失败：' + (Get-AckErrorText $ack)) }
}

function Invoke-RepairAutostart {
    $enabled = $true
    if ($null -ne $script:ConfigStartupEnabled) { $enabled = [bool]$script:ConfigStartupEnabled }
    $result = Set-Autostart $enabled
    if (-not $result.Ok) {
        Show-ErrorBox ('修复开机自启动失败：' + [string]$result.Error)
        return
    }
    Show-InfoBox $(if ($script:AutostartExists) { '已重建开机自启动快捷方式。' } else { '已清除失效的开机自启动快捷方式。' })
}

function Invoke-ToggleAutostart {
    $target = -not $script:AutostartExists
    $result = Set-Autostart $target
    if (-not $result.Ok) {
        Show-ErrorBox ('设置开机自启动失败：' + [string]$result.Error)
        return
    }
    if ($script:AutostartExists) { Write-TrayLog '开机自启动已启用' } else { Write-TrayLog '开机自启动已禁用' }
}

function Add-DeferredHostClose {
    param([string]$Mode)
    $script:CloseIntent = $Mode
}

function Invoke-TrayClose {
    param([string]$Mode)   # exit | restart
    if (Get-IsLocked) { return }

    $verb = '退出'
    if ($Mode -eq 'restart') { $verb = '重启' }

    $running = [bool](Get-StateField 'running' $false)
    if ($running) {
        $question = '正在同步，暂时不能' + $verb + '。' + "`r`n`r`n" + '是否取消当前同步，然后再' + $verb + '？' + "`r`n" + '（取消同步会在同步结果里记为失败，不会记为成功。）'
        if (-not (Show-ConfirmBox $question)) { return }
        $cancelAck = Invoke-NodeCommand -Name 'sync-cancel' -Extra $null -TimeoutMs 10000
        if (-not (Get-AckOk $cancelAck)) {
            Show-ErrorBox ('取消同步失败：' + (Get-AckErrorText $cancelAck))
            return
        }
        $settled = Wait-NodeState -Condition { -not [bool](Get-StateField 'running' $false) } -TimeoutMs 15000
        if (-not $settled) {
            Show-ErrorBox '同步仍在收尾，请稍后再' + $verb + '。'
            return
        }
    }
    else {
        $question = '确定要退出自动同步吗？退出后不会再自动同步。'
        if ($Mode -eq 'restart') { $question = '确定要重启自动同步托盘吗？配置、状态和锁定状态都会保留。' }
        if (-not (Show-ConfirmBox $question)) { return }
    }

    $script:CloseIntent = $Mode
    $ack = Invoke-NodeCommand -Name $Mode -Extra $null -TimeoutMs 15000
    if ($ack -and -not (Get-AckOk $ack)) {
        $script:CloseIntent = ''
        Show-ErrorBox ($verb + '失败：' + (Get-AckErrorText $ack))
        return
    }
    if ($null -eq $ack) {
        # Node 没回 ack：可能已经退出或卡住，等进程退出事件决定后续
        Write-TrayLog ($verb + '请求没有收到 ack（可能 Node 已经在退出）') 'WARN'
    }
    Write-TrayLog ('已请求' + $verb + '，等待 Node 收尾退出')
}

# ============================ 托盘菜单 ============================

function New-MenuItem {
    param(
        [string]$Text,
        [scriptblock]$OnClick = $null,
        [bool]$Enabled = $true,
        [bool]$Checked = $false,
        [bool]$CheckOnClick = $false
    )
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Text = $Text
    $item.Enabled = $Enabled
    if ($CheckOnClick) {
        $item.Checked = $Checked
        $item.CheckOnClick = $false
    }
    if ($null -ne $OnClick) { $item.Add_Click($OnClick) }
    return $item
}

function Add-MenuSeparator {
    param($Menu)
    [void]$Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
}

function Add-InfoItem {
    param($Menu, [string]$Text)
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Text = $Text
    $item.Enabled = $false   # 状态区只读
    [void]$Menu.Items.Add($item)
}

function Get-StatusLines {
    $lines = Get-StateField 'statusLines' $null
    if ($null -eq $lines) { return @() }
    $result = New-Object System.Collections.ArrayList
    foreach ($line in $lines) {
        $text = [string]$line
        if (-not [string]::IsNullOrWhiteSpace($text)) { [void]$result.Add($text) }
    }
    return $result
}

# 两套菜单（PROTOCOL.md §6.1 / §6.2）：每次打开都按当前 state 重建，不缓存陈旧状态
function Build-TrayMenu {
    if ($script:NoTrayMode -or $null -eq $script:Menu) { return }
    $menu = $script:Menu
    $menu.Items.Clear()

    $locked = Get-IsLocked
    $running = [bool](Get-StateField 'running' $false)
    $paused = [bool](Get-StateField 'paused' $false)
    $statusLines = @(Get-StatusLines)

    # ---- 标题 ----
    $title = $script:AppName
    if ($locked) { $title = $script:AppName + '（已锁定）' }
    Add-InfoItem $menu $title
    Add-MenuSeparator $menu

    # ---- 状态区（只读，文本原样取 Node 排好的 statusLines）----
    if ($statusLines.Count -gt 0) {
        foreach ($line in $statusLines) { Add-InfoItem $menu $line }
    }
    else {
        Add-InfoItem $menu '尚未收到状态'
    }
    Add-MenuSeparator $menu

    if ($locked) {
        # 锁定：只保留 状态摘要 / 查看详细状态 / 立即同步 / 解锁 / 浏览日志文件夹
        [void]$menu.Items.Add((New-MenuItem '查看详细状态' { Invoke-SafeAction 'show-detail' { Invoke-ShowDetail } }))
        Add-MenuSeparator $menu

        $syncText = '立即同步'
        $syncEnabled = $true
        if ($running) { $syncText = '同步中…'; $syncEnabled = $false }
        [void]$menu.Items.Add((New-MenuItem $syncText { Invoke-SafeAction 'sync-now' { Invoke-SyncNow } } $syncEnabled))
        [void]$menu.Items.Add((New-MenuItem '解锁' { Invoke-SafeAction 'unlock' { Invoke-Unlock } }))
        [void]$menu.Items.Add((New-MenuItem '浏览日志文件夹' { Invoke-SafeAction 'open-log-folder' { Invoke-OpenTarget 'log-folder' } }))
        return
    }

    # ---- 未锁定 ----
    [void]$menu.Items.Add((New-MenuItem '查看详细状态' { Invoke-SafeAction 'show-detail' { Invoke-ShowDetail } }))
    Add-MenuSeparator $menu

    $syncText = '立即同步'
    $syncEnabled = $true
    if ($running) { $syncText = '同步中…'; $syncEnabled = $false }
    [void]$menu.Items.Add((New-MenuItem $syncText { Invoke-SafeAction 'sync-now' { Invoke-SyncNow } } $syncEnabled))

    $pauseText = '暂停自动同步'
    if ($paused) { $pauseText = '恢复自动同步' }
    [void]$menu.Items.Add((New-MenuItem $pauseText { Invoke-SafeAction 'pause-toggle' { Invoke-PauseToggle } }))

    [void]$menu.Items.Add((New-MenuItem '锁定' { Invoke-SafeAction 'lock' { Invoke-Lock } }))
    Add-MenuSeparator $menu

    # ---- 浏览 ----
    $browse = New-Object System.Windows.Forms.ToolStripMenuItem
    $browse.Text = '浏览'
    [void]$browse.DropDownItems.Add((New-MenuItem '项目目录' { Invoke-SafeAction 'open-project' { Invoke-OpenTarget 'project-dir' } }))
    [void]$browse.DropDownItems.Add((New-MenuItem '下载数据目录' { Invoke-SafeAction 'open-data' { Invoke-OpenTarget 'data-dir' } }))
    [void]$browse.DropDownItems.Add((New-MenuItem '自动同步目录' { Invoke-SafeAction 'open-sync' { Invoke-OpenTarget 'sync-dir' } }))
    [void]$browse.DropDownItems.Add((New-MenuItem '最新日志' { Invoke-SafeAction 'open-latest-log' { Invoke-OpenTarget 'latest-log' } }))
    [void]$browse.DropDownItems.Add((New-MenuItem '日志文件夹' { Invoke-SafeAction 'open-log-folder' { Invoke-OpenTarget 'log-folder' } }))
    [void]$menu.Items.Add($browse)
    Add-MenuSeparator $menu

    [void]$menu.Items.Add((New-MenuItem '配置文件' { Invoke-SafeAction 'open-config' { Invoke-OpenTarget 'config-file' } }))
    [void]$menu.Items.Add((New-MenuItem '日志文件夹' { Invoke-SafeAction 'open-log-folder' { Invoke-OpenTarget 'log-folder' } }))
    [void]$menu.Items.Add((New-MenuItem '配置…' { Invoke-SafeAction 'settings' { Invoke-OpenSettings } }))

    # 开机自启动：勾选状态 = 快捷方式是否真实存在
    $autostartItem = New-MenuItem '开机自启动' { Invoke-SafeAction 'autostart-toggle' { Invoke-ToggleAutostart } } $true $true
    $autostartItem.Checked = [bool]$script:AutostartExists
    [void]$menu.Items.Add($autostartItem)

    # 修复自启动：仅当配置里启用但快捷方式不存在时显示
    $expected = $script:ConfigStartupEnabled
    if ($null -eq $expected) { $expected = $script:AutostartExists }
    if ((-not $script:AutostartExists) -and [bool]$expected) {
        [void]$menu.Items.Add((New-MenuItem '修复自启动' { Invoke-SafeAction 'repair-autostart' { Invoke-RepairAutostart } }))
    }

    Add-MenuSeparator $menu
    [void]$menu.Items.Add((New-MenuItem '重启' { Invoke-SafeAction 'restart' { Invoke-TrayClose 'restart' } }))
    [void]$menu.Items.Add((New-MenuItem '退出' { Invoke-SafeAction 'exit' { Invoke-TrayClose 'exit' } }))
}

# 菜单点击统一入口：任何异常都只写日志，不让托盘崩掉
function Invoke-SafeAction {
    param([string]$Name, [scriptblock]$Action)
    try {
        if ($null -ne $Action) { & $Action }
    }
    catch {
        Write-TrayLog ('菜单动作异常（' + $Name + '）：' + $_.Exception.Message) 'ERROR'
    }
}

# ============================ 启动 / 收尾 ============================

function Start-NewTrayInstance {
    $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
    try {
        if (-not (Test-Path -LiteralPath $script:StartVbsPath -PathType Leaf)) {
            Write-TrayLog '重启失败：找不到 start.vbs' 'ERROR'
            return
        }
        Start-Process -FilePath $wscript -ArgumentList ('"' + $script:StartVbsPath + '"') -WorkingDirectory $script:ScriptDir
        Write-TrayLog '已启动新的托盘实例'
    }
    catch {
        Write-TrayLog ('重启失败：' + $_.Exception.Message) 'ERROR'
    }
}

function Stop-TrayHost {
    if ($script:Stopping) { return }
    $script:Stopping = $true
    Write-TrayLog '宿主准备退出：停止消息泵、隐藏托盘图标'

    try { if ($null -ne $script:PumpTimer) { $script:PumpTimer.Stop() } } catch { }

    # 关掉 Node 的 stdin：正常流程下 Node 早已退出；这里只是兜底，不发 EOF 之外的信号
    try {
        if ($null -ne $script:NodeProcess -and -not $script:NodeExited) {
            try { $script:NodeProcess.StandardInput.Close() } catch { }
            Write-TrayLog '已关闭 Node stdin（让 Node 走 EOF 收尾）' 'DEBUG'
        }
    }
    catch { }

    try { if ($null -ne $script:NotifyIcon) { $script:NotifyIcon.Visible = $false } } catch { }
    try { if ($null -ne $script:AppContext) { $script:AppContext.ExitThread() } } catch { }
}

function Clear-HostResources {
    try { if ($null -ne $script:PumpTimer) { $script:PumpTimer.Dispose() } } catch { }
    $script:PumpTimer = $null

    try {
        if ($null -ne $script:NotifyIcon) {
            $script:NotifyIcon.Visible = $false
            $script:NotifyIcon.ContextMenuStrip = $null
            $script:NotifyIcon.Dispose()
        }
    }
    catch { }
    $script:NotifyIcon = $null

    try { if ($null -ne $script:Menu) { $script:Menu.Dispose() } } catch { }
    $script:Menu = $null

    try { if ($null -ne $script:CurrentIcon) { $script:CurrentIcon.Dispose() } } catch { }
    $script:CurrentIcon = $null

    try {
        if ($null -ne $script:Bridge) {
            $script:Bridge.UnwirePowerEvents()
            if ($null -ne $script:NodeProcess) { $script:Bridge.Detach($script:NodeProcess) }
        }
    }
    catch { }

    try { if ($null -ne $script:NodeProcess) { $script:NodeProcess.Dispose() } } catch { }
    $script:NodeProcess = $null
    $script:AppContext = $null
}

function Initialize-HostEnvironment {
    # WinForms / GDI+ / 系统事件
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -AssemblyName System.Core -ErrorAction Stop

    try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }

    # 后台托盘不应该因为一次 UI 异常就弹框或退出
    try {
        [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
        [System.Windows.Forms.Application]::add_ThreadException({
                param($sender, $eventArgs)
                try {
                    $message = ''
                    if ($null -ne $eventArgs -and $null -ne $eventArgs.Exception) { $message = $eventArgs.Exception.Message }
                    Write-TrayLog ('界面线程异常：' + $message) 'ERROR'
                }
                catch { }
            })
    }
    catch {
        Write-TrayLog ('注册全局异常处理失败：' + $_.Exception.Message) 'WARN'
    }

    Initialize-StartupPaths
    $script:AutostartExists = Test-AutostartShortcut

    # 只有当新的开机启动项已经就位（或已由本程序接管）时，才清理旧版快捷方式，
    # 避免用户还没启用新版自启动就把原来的自启动项删掉。
    if ($script:AutostartExists) { Remove-LegacyShortcuts }
}

function Start-HostUi {
    $script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $script:NotifyIcon.Text = $script:AppName
    $script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
    $script:NotifyIcon.ContextMenuStrip = $script:Menu

    # 先用默认底图顶上；之后的图标一律用 Node 发来的 icon.path
    if (Test-Path -LiteralPath $script:DefaultIconPath -PathType Leaf) {
        try { Set-TrayIconFromPath $script:DefaultIconPath }
        catch { Write-TrayLog ('加载默认图标失败：' + $_.Exception.Message) 'WARN' }
    }
    else {
        Write-TrayLog ('默认图标不存在：' + $script:DefaultIconPath) 'WARN'
    }

    $script:Menu.Add_Opening({
            try { Build-TrayMenu }
            catch { Write-TrayLog ('打开菜单时重建失败：' + $_.Exception.Message) 'ERROR' }
        })

    # 预构建一次：ContextMenuStrip 首次弹出时若在 Opening 里清空重建，可能来不及显示
    try { Build-TrayMenu } catch { }

    $script:NotifyIcon.Visible = $true
}

function Invoke-TrayHost {
    Initialize-HostEnvironment

    $script:NodeExe = Resolve-NodeExecutable
    if ([string]::IsNullOrWhiteSpace($script:NodeExe)) {
        Write-TrayLog '未找到 Node.js，托盘无法启动' 'ERROR'
        $message = '未找到 Node.js。' + "`r`n`r`n" + '自动同步托盘需要 Node.js 18 或更高版本。' + "`r`n" + '请安装 Node.js，或在 config.json 的 runtime.nodePath 里填写 node.exe 的完整路径。'
        try { [void][System.Windows.Forms.MessageBox]::Show($message, 'fdn-autosync-tray', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) } catch { }
        $script:ExitCode = 3
        return
    }
    Write-TrayLog ('Node 可执行文件：' + $script:NodeExe)

    try {
        Initialize-NodeBridge
        $script:Bridge.WirePowerEvents()
    }
    catch {
        Write-TrayLog ('初始化 Node 桥接失败：' + $_.Exception.Message) 'ERROR'
    }

    $script:AckTable = New-Object System.Collections.Hashtable

    if (-not $script:NoTrayMode) { Start-HostUi }
    else { Write-TrayLog '-NoTray 模式：不创建托盘图标与菜单，仅运行协议循环' }

    try {
        Start-NodeProcess $script:NodeExe
    }
    catch {
        Write-TrayLog ('启动 Node 失败：' + $_.Exception.Message) 'ERROR'
        try { [void][System.Windows.Forms.MessageBox]::Show(('启动 Node 失败：' + $_.Exception.Message + "`r`n`r`n" + $script:NodeExe), 'fdn-autosync-tray', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) } catch { }
        $script:ExitCode = 4
        Clear-HostResources
        return
    }

    # 开机自启动真实状态（Node 据此把配置与真实状态对齐）
    Send-NodeEvent 'autostart-status' @{ exists = [bool]$script:AutostartExists }
    $script:AutostartStatusSent = $true

    # 消息泵：WinForms 定时器在 UI 线程取 stdout/stderr/系统事件，
    # 既满足「BeginOutputReadLine 异步读」，又不需要在非 PowerShell 线程里跑脚本块。
    $script:PumpTimer = New-Object System.Windows.Forms.Timer
    $script:PumpTimer.Interval = 120
    $script:PumpTimer.Add_Tick({ try { Invoke-HostPump } catch { } })
    $script:PumpTimer.Start()

    $script:AppContext = New-Object System.Windows.Forms.ApplicationContext
    Write-TrayLog ('托盘宿主已启动｜脚本目录 ' + $script:ScriptDir + '｜自启动 ' + $script:AutostartExists)

    try {
        [System.Windows.Forms.Application]::Run($script:AppContext)
    }
    finally {
        Write-TrayLog '消息循环已退出'
        Clear-HostResources
    }
}

# ============================ 入口 ============================

function Invoke-InstallOrUninstall {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Initialize-StartupPaths

    if ($Install) {
        $result = Install-AutostartShortcut
        if (-not $result.Ok) {
            try { [void][System.Windows.Forms.MessageBox]::Show(('创建开机自启动快捷方式失败：' + [string]$result.Error), 'fdn-autosync-tray', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) } catch { }
            $script:ExitCode = 1
            return
        }
        Write-TrayLog ('-Install 完成：' + $script:StartupShortcut)
        return
    }

    $result = Remove-AutostartShortcut
    if (-not $result.Ok) {
        try { [void][System.Windows.Forms.MessageBox]::Show(('删除开机自启动快捷方式失败：' + [string]$result.Error), 'fdn-autosync-tray', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) } catch { }
        $script:ExitCode = 1
        return
    }
    Write-TrayLog '-Uninstall 完成：已删除开机自启动快捷方式'
}

$script:StartedAt = Get-Date

try {
    if ($Install -or $Uninstall) {
        Invoke-InstallOrUninstall
    }
    else {
        Invoke-TrayHost
    }
}
catch {
    $script:ExitCode = 1
    try {
        Write-TrayLog ('宿主未捕获异常：' + $_.Exception.Message + ' / ' + $_.ScriptStackTrace) 'ERROR'
    }
    catch { }
    try { Clear-HostResources } catch { }
}

try { Write-TrayLog ('宿主进程结束（退出码 ' + $script:ExitCode + '）') } catch { }
exit $script:ExitCode
