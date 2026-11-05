# tray.ps1 — 线路1 自动同步 · Windows 本地托盘版
#
# 作用：常驻系统托盘，按自定义间隔在后台运行 `scripts/auto-sync/sync.mjs` 的**完整流程**
#      （预探测 → 登录网盘 → 离线下载 → 取直链 → 写 data/down JSON → 分软件提交 → push）。
#
# 特点：
#   · 全程无窗口：同步在隐藏子进程中运行，输出只进日志文件；只有点菜单时才弹出小对话框
#   · 托盘菜单：立即同步 / 暂停恢复 / 更新间隔（预设 + 自定义）/ 开机启动 / 打开日志 / 会话剩余天数 / 退出
#   · 单实例：重复启动会被静默忽略
#   · 日志：scripts/auto-sync/local/logs/（每次同步一个 sync-*.log，托盘自身写 tray.log）
#   · 配置：scripts/auto-sync/local/config.json（首次运行自动生成，**不入库**）
#
# 用法（详见 scripts/auto-sync/README.md「本地版（Windows 托盘）」）：
#   直接双击 start.vbs 即可（无窗口）。开机自启可在托盘菜单里勾选，或执行
#     powershell -ExecutionPolicy Bypass -File scripts\auto-sync\local\tray.ps1 -Install
#   取消开机自启：
#     powershell -ExecutionPolicy Bypass -File scripts\auto-sync\local\tray.ps1 -Uninstall
#
# ⚠ 本地版会真的 commit + push 到当前仓库的 origin。请确保：
#   · 本机 git 已配置可推送的凭据（SSH key 或 credential helper）
#   · 与 GitHub Actions 的自动同步不要同时开启，否则两边可能互相顶掉
#
# 依赖：Windows PowerShell 5.1+（系统自带）、Node.js 18+、git。

param(
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Continue'

# ============================ 路径与默认配置 ============================

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..\..\..')).Path
$SyncScript = Join-Path $RepoRoot 'scripts\auto-sync\sync.mjs'
$SessionScript = Join-Path $ScriptDir 'session-status.mjs'
$ConfigPath = Join-Path $ScriptDir 'config.json'
$LogDir = Join-Path $ScriptDir 'logs'
$StartupDir = [Environment]::GetFolderPath('Startup')
if (-not $StartupDir) {
  # 少数环境拿不到特殊文件夹时退回默认位置
  $StartupDir = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs\Startup'
}
$StartupShortcut = Join-Path $StartupDir '线路1自动同步.lnk'

$script:Defaults = [ordered]@{
  intervalMinutes    = 60      # 同步间隔（分钟）
  runOnStart         = $true   # 托盘启动后立即同步一次
  nodePath           = ''      # 留空 = 自动在 PATH 里找 node
  session            = ''      # huang1111 会话 cookie；留空则读环境变量 H1111_SESSION
  githubToken        = ''      # GitHub 只读 token（建议配，避免 60 次/小时的匿名限额）
  syncTimeoutMinutes = 120     # 单次同步硬超时，超时终止子进程
}

$script:cfg = $null
$script:nodeExe = $null
$script:notify = $null
$script:menu = $null
$script:iconIdle = $null
$script:iconBusy = $null
$script:iconError = $null
$script:iconBitmaps = @()

$script:running = $false
$script:proc = $null
$script:runStartedAt = $null
$script:runLog = ''
$script:lastRunAt = $null
$script:lastResult = ''
$script:nextRunAt = $null
$script:paused = $false
$script:sessionText = '会话：未检查'
$script:sessionDaysLeft = $null
$script:exiting = $false
$script:lastTip = ''

# ============================ 基础工具 ============================

function Write-TrayLog([string]$Message) {
  try {
    if (-not (Test-Path -LiteralPath $LogDir)) {
      New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    # 显式 UTF-8 无 BOM：避免 PowerShell 5.1 的 Add-Content 在追加时重复写 BOM
    [System.IO.File]::AppendAllText(
      (Join-Path $LogDir 'tray.log'),
      $line + "`r`n",
      (New-Object System.Text.UTF8Encoding -ArgumentList $false)
    )
  } catch { }
}

function Read-Config {
  $cfg = @{}
  foreach ($k in $script:Defaults.Keys) { $cfg[$k] = $script:Defaults[$k] }
  if (Test-Path -LiteralPath $ConfigPath) {
    try {
      $obj = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($k in $script:Defaults.Keys) {
        $prop = $obj.PSObject.Properties[$k]
        if ($prop -and $null -ne $prop.Value) { $cfg[$k] = $prop.Value }
      }
    } catch {
      Write-TrayLog "config.json 解析失败：$($_.Exception.Message)"
      # 托盘运行中用户可能正编辑配置文件（比如粘贴新 cookie），不要用默认值把内存里的配置冲掉；
      # 首次启动就损坏时返回默认值（不覆盖用户的文件，便于其自行修复）
      if ($script:cfg) { return $script:cfg }
    }
  } else {
    Save-Config $cfg
  }
  # 配置里手改出 0/负数/非数字时兜底，避免变成“立刻再跑一次”的死循环
  try {
    $cfg.intervalMinutes = [math]::Max(1, [double]$cfg.intervalMinutes)
    $cfg.syncTimeoutMinutes = [math]::Max(1, [double]$cfg.syncTimeoutMinutes)
  } catch {
    $cfg.intervalMinutes = $script:Defaults.intervalMinutes
    $cfg.syncTimeoutMinutes = $script:Defaults.syncTimeoutMinutes
  }
  return $cfg
}

function Save-Config($cfg) {
  try {
    $obj = [ordered]@{}
    foreach ($k in $script:Defaults.Keys) { $obj[$k] = $cfg[$k] }
    $json = $obj | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText(
      $ConfigPath,
      $json,
      (New-Object System.Text.UTF8Encoding -ArgumentList $false)
    )
  } catch {
    Write-TrayLog "写入 config.json 失败：$($_.Exception.Message)"
  }
}

function Resolve-NodeExe {
  $configured = [string]$script:cfg.nodePath
  if ($configured) {
    if (Test-Path -LiteralPath $configured) { return (Resolve-Path -LiteralPath $configured).Path }
    $cmd = Get-Command $configured -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  foreach ($name in @('node.exe', 'node')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

# ============================ 托盘图标（运行时绘制，无需素材文件） ============================

function New-TrayIcon([System.Drawing.Color]$Color) {
  $size = 32
  $bmp = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $brush = [System.Drawing.SolidBrush]::new($Color)
  $g.FillEllipse($brush, 1, 1, $size - 2, $size - 2)
  $brush.Dispose()

  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 3)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($pen, 16, 7, 16, 20)   # 竖线
  $g.DrawLine($pen, 10, 14, 16, 20)  # 左斜
  $g.DrawLine($pen, 22, 14, 16, 20)  # 右斜
  $g.DrawLine($pen, 9, 25, 23, 25)   # 底部横线
  $pen.Dispose()
  $g.Dispose()

  # 保留 Bitmap 引用，避免句柄失效；进程内只创建 3 个，句柄泄漏可忽略
  $script:iconBitmaps += $bmp
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

function Update-TrayIcon([string]$State) {
  if (-not $script:notify) { return }
  switch ($State) {
    'busy' { $script:notify.Icon = $script:iconBusy }
    'error' { $script:notify.Icon = $script:iconError }
    default { $script:notify.Icon = $script:iconIdle }
  }
}

function Show-Balloon([string]$Title, [string]$Text, [string]$Kind = 'Info') {
  if (-not $script:notify) { return }
  $icon = [System.Windows.Forms.ToolTipIcon]::Info
  if ($Kind -eq 'Error') { $icon = [System.Windows.Forms.ToolTipIcon]::Error }
  elseif ($Kind -eq 'Warning') { $icon = [System.Windows.Forms.ToolTipIcon]::Warning }
  $text = [string]$Text
  if ($text.Length -gt 250) { $text = $text.Substring(0, 250) + '…' }
  try { $script:notify.ShowBalloonTip(8000, $Title, $text, $icon) } catch { }
}

# ============================ 会话寿命（离线推算，不联网） ============================

function Update-SessionInfo {
  if (-not $script:nodeExe) { $script:sessionText = '会话：未找到 Node.js'; return }
  $raw = ''
  try {
    $raw = (& $script:nodeExe $SessionScript 2>$null | Out-String).Trim()
    if (-not $raw) { throw '无输出' }
    $j = $raw | ConvertFrom-Json
    if (-not $j.present) {
      $script:sessionText = '会话：未配置（同步必定失败）'
      $script:sessionDaysLeft = $null
    } elseif (-not $j.valid) {
      $script:sessionText = "会话：已失效（$($j.reason)）"
      $script:sessionDaysLeft = 0
    } elseif ($null -eq $j.daysLeft) {
      $script:sessionText = '会话：已配置（无法解析签发时间）'
      $script:sessionDaysLeft = $null
    } else {
      $script:sessionText = "会话：剩余 $($j.remaining)（到期 $($j.expires)）"
      $script:sessionDaysLeft = [double]$j.daysLeft
    }
  } catch {
    $script:sessionText = '会话：读取失败'
    $script:sessionDaysLeft = $null
    Write-TrayLog "会话状态读取失败：$($_.Exception.Message) $raw"
  }
}

# ============================ 同步进程 ============================

function Start-SyncRun {
  if ($script:running) { return }

  # 每轮重新读配置：改 config.json（例如换会话 cookie / token / node 路径）后无需重启托盘即可生效
  $script:cfg = Read-Config
  if ([string]$script:cfg.session) { $env:H1111_SESSION = [string]$script:cfg.session }
  if ([string]$script:cfg.githubToken) { $env:GITHUB_TOKEN = [string]$script:cfg.githubToken }
  $script:nodeExe = Resolve-NodeExe

  if (-not $script:nodeExe) {
    Show-Balloon '无法启动同步' '未找到 Node.js。请安装 Node.js 18+，或在 config.json 的 nodePath 里写 node.exe 的完整路径。' 'Error'
    Write-TrayLog '启动同步失败：找不到 node'
    return
  }
  if (-not (Test-Path -LiteralPath $SyncScript)) {
    Show-Balloon '无法启动同步' "找不到同步脚本：$SyncScript" 'Error'
    Write-TrayLog "启动同步失败：找不到 $SyncScript"
    return
  }

  if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $script:runLog = Join-Path $LogDir "sync-$stamp.log"
  $errLog = Join-Path $LogDir "sync-$stamp.err.log"

  try {
    # -NoNewWindow 与重定向是唯一合法组合（-WindowStyle Hidden 与重定向冲突会报错）；
    # 托盘自身由 wscript 以隐藏窗口拉起，子进程复用这个不可见的控制台，因此全程无窗口
    $script:proc = Start-Process `
      -FilePath $script:nodeExe `
      -ArgumentList "`"$SyncScript`"" `
      -WorkingDirectory $RepoRoot `
      -NoNewWindow `
      -RedirectStandardOutput $script:runLog `
      -RedirectStandardError $errLog `
      -PassThru
    $script:running = $true
    $script:runStartedAt = Get-Date
    Update-TrayIcon 'busy'
    Write-TrayLog "开始同步（PID $($script:proc.Id)）→ $script:runLog"
  } catch {
    $script:proc = $null
    $script:running = $false
    Update-TrayIcon 'error'
    Show-Balloon '启动同步失败' $_.Exception.Message 'Error'
    Write-TrayLog "启动同步异常：$($_.Exception.Message)"
  }
}

function Get-RunSummary([string]$LogPath) {
  if (-not $LogPath -or -not (Test-Path -LiteralPath $LogPath)) { return '' }
  try {
    $lines = Get-Content -LiteralPath $LogPath -Encoding UTF8 -ErrorAction SilentlyContinue
    $hit = $lines | Where-Object { $_ -match '总用时|全部软件均已是最新|登录 huang1111 失败|push 失败|同步失败' } |
      Select-Object -Last 2
    return (($hit | ForEach-Object { ([string]$_).Trim() }) -join ' / ')
  } catch { return '' }
}

function Stop-ProcessTree([int]$ProcessId) {
  try { & taskkill.exe /PID $ProcessId /T /F | Out-Null } catch { }
}

function Complete-SyncRun([int]$ExitCode, [bool]$TimedOut = $false) {
  if ($script:proc) {
    try { $script:proc.Dispose() } catch { }
  }
  $script:proc = $null
  $script:running = $false
  $script:lastRunAt = Get-Date

  if ($TimedOut) {
    $script:lastResult = '❌ 超时已终止'
  } elseif ($ExitCode -eq 0) {
    $script:lastResult = '✅ 成功'
  } else {
    $script:lastResult = "❌ 失败（退出码 $ExitCode）"
  }

  $summary = Get-RunSummary $script:runLog
  $minutes = [double]$script:cfg.intervalMinutes
  $script:nextRunAt = (Get-Date).AddMinutes($minutes)

  if ($ExitCode -eq 0 -and -not $TimedOut) {
    Update-TrayIcon 'idle'
    Show-Balloon '线路1 自动同步完成' $(if ($summary) { $summary } else { '本次同步成功（退出码 0）' }) 'Info'
  } else {
    Update-TrayIcon 'error'
    Show-Balloon '线路1 自动同步失败' $(if ($summary) { $summary } else { '详见日志：' + $script:runLog }) 'Error'
  }
  Write-TrayLog "同步结束：$($script:lastResult)｜$summary"
  Update-SessionInfo
}

function Invoke-Tick {
  try {
    if ($script:running) {
      $p = $script:proc
      if ($p -and $p.HasExited) {
        Complete-SyncRun ([int]$p.ExitCode) $false
      } elseif ($script:runStartedAt -and $p) {
        $elapsedMin = ((Get-Date) - $script:runStartedAt).TotalMinutes
        if ($elapsedMin -gt [double]$script:cfg.syncTimeoutMinutes) {
          Write-TrayLog "同步超时（$([math]::Round($elapsedMin,1)) 分钟），终止 PID $($p.Id)"
          Stop-ProcessTree ([int]$p.Id)
          Complete-SyncRun -ExitCode -1 -TimedOut $true
        }
      }
    } elseif (-not $script:paused -and $script:nextRunAt -and (Get-Date) -ge $script:nextRunAt) {
      # 先排下一轮再启动：即便这次启动失败（如 node 丢失），也不会卡死不再重试
      $script:nextRunAt = (Get-Date).AddMinutes([double]$script:cfg.intervalMinutes)
      Start-SyncRun
    }
  } catch {
    Write-TrayLog "调度异常：$($_.Exception.Message)"
  }
  Update-Tooltip
}

function Update-Tooltip {
  if (-not $script:notify) { return }
  $text = ''
  if ($script:running -and $script:runStartedAt) {
    $mins = [int](((Get-Date) - $script:runStartedAt).TotalMinutes)
    $text = "线路1 自动同步 · 同步中 ${mins}m"
  } elseif ($script:paused) {
    $text = '线路1 自动同步 · 已暂停'
  } elseif ($script:nextRunAt) {
    $text = '线路1 自动同步 · 下次 ' + $script:nextRunAt.ToString('HH:mm')
  } else {
    $text = '线路1 自动同步'
  }
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  if ($text -ne $script:lastTip) {
    try { $script:notify.Text = $text } catch { }
    $script:lastTip = $text
  }
}

# ============================ 托盘菜单 ============================

function Set-Interval([double]$Minutes) {
  if ($Minutes -lt 1) { return }
  $script:cfg.intervalMinutes = $Minutes
  Save-Config $script:cfg
  $script:nextRunAt = (Get-Date).AddMinutes($Minutes)
  Write-TrayLog "更新间隔已设为 $Minutes 分钟"
}

function Format-Interval([double]$Minutes) {
  if ($Minutes -lt 60) { return "$([int]$Minutes) 分钟" }
  $h = $Minutes / 60
  if ($h -eq [math]::Floor($h)) { return "$([int]$h) 小时" }
  return "$([math]::Round($h,1)) 小时"
}

function Install-Autostart {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($StartupShortcut)
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $lnk.Arguments = '"' + (Join-Path $ScriptDir 'start.vbs') + '"'
    $lnk.WorkingDirectory = $ScriptDir
    $lnk.WindowStyle = 7
    $lnk.Description = '线路1 自动同步（Windows 托盘版）'
    $lnk.Save()
    Write-TrayLog '已写入开机启动快捷方式'
    return $true
  } catch {
    Write-TrayLog "写入开机启动失败：$($_.Exception.Message)"
    Show-Balloon '设置开机启动失败' $_.Exception.Message 'Error'
    return $false
  }
}

function Remove-Autostart {
  try {
    if (Test-Path -LiteralPath $StartupShortcut) { Remove-Item -LiteralPath $StartupShortcut -Force }
    Write-TrayLog '已移除开机启动快捷方式'
    return $true
  } catch {
    Write-TrayLog "移除开机启动失败：$($_.Exception.Message)"
    return $false
  }
}

function Test-Autostart { return (Test-Path -LiteralPath $StartupShortcut) }

function New-MenuItem([string]$Text, [scriptblock]$OnClick = $null, [bool]$Enabled = $true) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $Text
  $item.Enabled = $Enabled
  if ($OnClick) { $item.Add_Click($OnClick) }
  return $item
}

function Build-Menu {
  $menu = $script:menu
  $menu.Items.Clear()

  # ---- 状态区（只读）----
  $status = ''
  if ($script:running -and $script:runStartedAt) {
    $status = '状态：正在同步（已 ' + [int](((Get-Date) - $script:runStartedAt).TotalMinutes) + ' 分钟）'
  } elseif ($script:paused) {
    $status = '状态：已暂停'
  } elseif ($script:nextRunAt) {
    $status = '状态：下次 ' + $script:nextRunAt.ToString('MM-dd HH:mm')
  } else {
    $status = '状态：待启动'
  }
  [void]$menu.Items.Add((New-MenuItem $status $null $false))

  if ($script:lastRunAt) {
    [void]$menu.Items.Add((New-MenuItem ('上次：' + $script:lastRunAt.ToString('MM-dd HH:mm') + ' · ' + $script:lastResult) $null $false))
  } else {
    [void]$menu.Items.Add((New-MenuItem '上次：尚未运行' $null $false))
  }
  [void]$menu.Items.Add((New-MenuItem $script:sessionText $null $false))
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  # ---- 操作区 ----
  $nowText = '立即同步'
  if ($script:running) { $nowText = '立即同步（正在运行）' }
  $nowItem = New-MenuItem $nowText ({ Start-SyncRun }) (-not $script:running)
  [void]$menu.Items.Add($nowItem)

  $pauseText = '暂停自动同步'
  if ($script:paused) { $pauseText = '继续自动同步' }
  [void]$menu.Items.Add((New-MenuItem $pauseText ({
    $script:paused = -not $script:paused
    if ($script:paused) {
      Write-TrayLog '已暂停自动同步'
    } else {
      $script:nextRunAt = (Get-Date)
      Write-TrayLog '已恢复自动同步'
    }
  })))

  # ---- 更新间隔（预设 + 自定义）----
  $intervalItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $intervalItem.Text = '更新间隔（当前 ' + (Format-Interval ([double]$script:cfg.intervalMinutes)) + '）'
  foreach ($preset in @(15, 30, 60, 120, 240, 720)) {
    $v = $preset
    $click = { Set-Interval $v }.GetNewClosure()
    $sub = New-MenuItem (Format-Interval $v) $click
    if ([double]$script:cfg.intervalMinutes -eq [double]$v) { $sub.Checked = $true }
    [void]$intervalItem.DropDownItems.Add($sub)
  }
  [void]$intervalItem.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $custom = New-MenuItem '自定义…' ({
    try {
      Add-Type -AssemblyName Microsoft.VisualBasic
      $current = [string][int]$script:cfg.intervalMinutes
      $answer = [Microsoft.VisualBasic.Interaction]::InputBox('请输入自动同步间隔（分钟，最小 1）', '线路1 自动同步', $current)
      if ($answer) {
        $n = 0
        if ([int]::TryParse([string]$answer, [ref]$n) -and $n -ge 1) {
          Set-Interval $n
          Show-Balloon '更新间隔已修改' ('现在每 ' + (Format-Interval $n) + ' 自动同步一次。') 'Info'
        } else {
          Show-Balloon '输入无效' '请输入大于 0 的分钟数。' 'Warning'
        }
      }
    } catch {
      Write-TrayLog "自定义间隔对话框失败：$($_.Exception.Message)"
    }
  })
  [void]$intervalItem.DropDownItems.Add($custom)
  [void]$menu.Items.Add($intervalItem)

  # ---- 开机启动 ----
  $autoItem = New-MenuItem '开机启动' ({
    if (Test-Autostart) {
      if (Remove-Autostart) { Show-Balloon '开机启动已关闭' '下次登录 Windows 时不再自动启动托盘。' 'Info' }
    } else {
      if (Install-Autostart) { Show-Balloon '开机启动已开启' '下次登录 Windows 时会自动在托盘里启动。' 'Info' }
    }
  })
  $autoItem.Checked = Test-Autostart
  [void]$menu.Items.Add($autoItem)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  # ---- 日志 / 配置 ----
  [void]$menu.Items.Add((New-MenuItem '打开日志文件夹' ({
    try {
      if (-not (Test-Path -LiteralPath $script:LogDir)) { New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null }
      Start-Process explorer.exe -ArgumentList ('"' + $script:LogDir + '"')
    } catch { }
  })))

  [void]$menu.Items.Add((New-MenuItem '打开配置文件' ({
    try { Start-Process notepad.exe -ArgumentList ('"' + $script:ConfigPath + '"') } catch { }
  })))

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add((New-MenuItem '退出' ({
    $script:exiting = $true
    if ($script:running -and $script:proc) {
      # 正在同步时不强杀，等它跑完再退出托盘
      $script:paused = $true
    }
  })))
}

# ============================ 启动入口 ============================

# 开机启动 / 取消开机启动（不进入托盘循环）
if ($Install -or $Uninstall) {
  $script:cfg = Read-Config
  if ($Install) {
    if (Install-Autostart) { Write-Host '已开启开机启动：' $StartupShortcut }
    exit 0
  }
  if ($Uninstall) {
    if (Remove-Autostart) { Write-Host '已关闭开机启动。' }
    exit 0
  }
}

$script:cfg = Read-Config

# WinForms 需要 STA；PowerShell 7 默认 MTA，重新用 5.1 的 STA 拉起自己
# （必须在拿单实例锁之前，否则子进程会因锁被占用而直接退出）
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
  $ps51 = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $ps51) {
    Start-Process -FilePath $ps51 -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', ('"' + $MyInvocation.MyCommand.Path + '"')
    )
    exit 0
  }
}

# 单实例：已有托盘在跑时静默退出
$mutex = [System.Threading.Mutex]::new($false, 'Local\FCL-downsite-auto-sync-tray')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 原生进程输出是 UTF-8（node/git），把控制台解码也设为 UTF-8，避免中文变乱码
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# 环境变量：同步脚本只从环境读凭据（配置里的值优先，其次沿用系统环境）
if ([string]$script:cfg.session) { $env:H1111_SESSION = [string]$script:cfg.session }
if ([string]$script:cfg.githubToken) { $env:GITHUB_TOKEN = [string]$script:cfg.githubToken }
# 隐藏进程里没有可交互的终端：禁用 git 终端提示，缺凭据时直接失败而不是挂起
$env:GIT_TERMINAL_PROMPT = '0'
# 本地运行必须摘掉 GHA 上下文：否则 sync.mjs 会把 token 写进 git remote URL
Remove-Item Env:\GITHUB_REPOSITORY -ErrorAction SilentlyContinue
Remove-Item Env:\GITHUB_ACTIONS -ErrorAction SilentlyContinue
Remove-Item Env:\GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue
Remove-Item Env:\GITHUB_REF_NAME -ErrorAction SilentlyContinue

$script:nodeExe = Resolve-NodeExe
$script:iconIdle = New-TrayIcon ([System.Drawing.Color]::FromArgb(38, 132, 255))
$script:iconBusy = New-TrayIcon ([System.Drawing.Color]::FromArgb(255, 152, 0))
$script:iconError = New-TrayIcon ([System.Drawing.Color]::FromArgb(211, 47, 47))

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = $script:iconIdle
$script:notify.Text = '线路1 自动同步'
$script:notify.Visible = $true

$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:notify.ContextMenuStrip = $script:menu
$script:menu.Add_Opening({
  try { Build-Menu } catch { Write-TrayLog "构建托盘菜单失败：$($_.Exception.Message)" }
})
$script:notify.Add_MouseDoubleClick({
  if (-not $script:running) { Start-SyncRun } else {
    try { if ($script:runLog) { Start-Process notepad.exe -ArgumentList ('"' + $script:runLog + '"') } } catch { }
  }
})

Write-TrayLog "托盘已启动｜仓库 $RepoRoot｜间隔 $($script:cfg.intervalMinutes) 分钟｜node $script:nodeExe"
Update-SessionInfo
Update-Tooltip

if (-not $script:nodeExe) {
  Show-Balloon '未找到 Node.js' '请安装 Node.js 18+，或在 config.json 的 nodePath 里填写 node.exe 的完整路径。' 'Error'
} elseif (-not [string]$script:cfg.session -and -not $env:H1111_SESSION) {
  Show-Balloon '未配置会话 cookie' '同步需要 huang1111 会话。请在 config.json 的 session 里填写，或设置系统环境变量 H1111_SESSION。' 'Warning'
} elseif ($null -ne $script:sessionDaysLeft -and $script:sessionDaysLeft -le 10) {
  Show-Balloon '会话即将失效' ($script:sessionText + ' —— 请尽快更新 config.json 里的 session（或系统环境变量 H1111_SESSION）。') 'Warning'
}

if ($script:cfg.runOnStart) {
  Start-SyncRun
} else {
  $script:nextRunAt = (Get-Date).AddMinutes([double]$script:cfg.intervalMinutes)
}

# 无窗体消息循环：DoEvents 处理托盘/菜单消息，同时驱动定时检查
while (-not $script:exiting) {
  [System.Windows.Forms.Application]::DoEvents()
  Invoke-Tick
  Start-Sleep -Milliseconds 100
}

# 退出：正在同步则等它跑完（不打断，避免留下半截提交）
if ($script:running) {
  Write-TrayLog '退出请求：等待当前同步完成…'
  while ($script:running) {
    [System.Windows.Forms.Application]::DoEvents()
    Invoke-Tick
    Start-Sleep -Milliseconds 500
  }
}

try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
Write-TrayLog '托盘已退出'
try { $mutex.ReleaseMutex() } catch { }
