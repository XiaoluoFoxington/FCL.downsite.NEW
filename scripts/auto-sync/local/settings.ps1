# =============================================================================
# settings.ps1 — 自动同步托盘 · 设置窗口（WinForms 单文件）
# -----------------------------------------------------------------------------
# 契约来源：scripts/auto-sync/local/PROTOCOL.md §4（config.json schema v1，字段权威表）
#                              §7（设置窗口规范）
#            .tmp/fdn-autosync-tray-design.md §7.3 / §7.4（配置分组、快照语义）
#
# 这个文件 **只** 被 tray.ps1 dot-source（`. "$PSScriptRoot\settings.ps1"`），
# 不单独运行、不写任何文件、不调 Node 协议、不读写 config.json / state.json。
#
# 对外函数（tray.ps1 只调用这两个）：
#   Show-SettingsWindow([hashtable]$Config)
#       模态显示设置窗口。
#       取消 / 关闭 → 返回 $null（调用方不得保存）。
#       保存       → 返回**完整**新配置（[ordered] 字典，含全部未暴露字段），
#                    由 tray.ps1 发 {"type":"command","name":"save-config"} 给 Node。
#   New-SettingsForm([hashtable]$Config)
#       只创建并返回 Form（不 Show、不跑消息循环），供自测与 Show-SettingsWindow 复用。
#       调用方负责 Dispose()。
#
# 辅助函数（同样可被自测 / tray.ps1 复用）：
#   Get-SettingsFromForm($Form)        → 从当前控件读出一份完整配置（含 _iconAction/_iconPath）
#   Invoke-SettingsSave($Form)         → 保存动作（校验通过才写 $Form.Tag['Result']），返回 [bool]
#   Test-SettingsConfig($Config)       → 本地预校验，返回 [string[]] 错误（空 = 通过）
#   Remove-SettingsTransientKeys($Cfg) → 剔除 _iconAction / _iconPath 后的干净配置
#   New-SettingsDefaultConfig()        → PROTOCOL.md §4 的默认配置（[ordered]，不含任何真实凭据）
#
# -----------------------------------------------------------------------------
# 图标动作（「部署」页「选择图片…」/「重置默认图标」）约定：
#   本文件**不复制、不修改**任何图片文件，只记录用户意图。意图放在返回配置的
#   两个额外顶层键里（Get-SettingsFromForm / Show-SettingsWindow 的返回值）：
#       _iconAction : 'set'    → 用户在 _iconPath 里选了一张图片，请复制进 assets/ 并生效
#                     'reset'  → 恢复默认图标
#                     $null    → 本次没有改动图标
#       _iconPath   : 用户选中的**原始**文件全路径（'_iconAction' = 'set' 时非空）
#   tray.ps1 消费后应调用 Remove-SettingsTransientKeys 再发 save-config
#   （Node 的 normalizeConfig 只认 §4 字段表，多余顶层键会被忽略，但按约定剔除更干净）。
#   真正写 appearance.iconPath 的是 Node（save-config / set-icon / reset-icon）。
#
# -----------------------------------------------------------------------------
# 返回配置的保证：
#   · 字段名 / 嵌套结构与输入完全一致，**未在界面暴露的字段原样带回**
#     （appearance.iconPath 以及将来新增的未知字段都靠 deep-clone 透传）；
#   · version 保持 1；
#   · 任何密码 / Token 只从控件原值回填，不写日志、不写状态栏明文；
#   · 本文件不写 config.json（唯一写入者是 Node）。
#
# 编码：UTF-8 with BOM（Windows PowerShell 5.1 必需）。
# 兼容：Windows PowerShell 5.1 / .NET Framework 4.8；不用 PS7 语法。
# =============================================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# =============================================================================
# 区域 1：基础设施（路径读写 / 深拷贝 / 默认配置 / 字体）
# =============================================================================

# 解析界面字体：优先 Microsoft YaHei UI，逐级回退；拿不到就退回窗体默认字体。
function Get-SettingsUiFont {
  param([double]$Size = 9)

  $candidates = @('Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'Segoe UI')
  $installed = $null
  try {
    $installed = New-Object System.Drawing.Text.InstalledFontCollection
    $names = @{}
    foreach ($family in $installed.Families) { $names[[string]$family.Name] = $true }
    foreach ($name in $candidates) {
      if ($names.ContainsKey($name)) {
        return (New-Object System.Drawing.Font -ArgumentList @(
            $name,
            [single]$Size,
            [System.Drawing.FontStyle]::Regular,
            [System.Drawing.GraphicsUnit]::Point
          ))
      }
    }
  } catch {
    # 字体探测失败不是错误：走下面的兜底
  } finally {
    if ($null -ne $installed) { try { $installed.Dispose() } catch { } }
  }

  try {
    return (New-Object System.Drawing.Font -ArgumentList @(
        [System.Drawing.FontFamily]::GenericSansSerif,
        [single]$Size,
        [System.Drawing.FontStyle]::Regular,
        [System.Drawing.GraphicsUnit]::Point
      ))
  } catch {
    return $null
  }
}

# 递归深拷贝成 [ordered] 字典（hashtable / OrderedDictionary / PSCustomObject 都吃）。
# 这样「未在界面暴露的字段」能原样带回，且不会被扁平化。
function ConvertTo-SettingsOrdered {
  param($Value)

  if ($null -eq $Value) { return $null }
  if ($Value -is [bool] -or $Value -is [string]) { return $Value }

  if ($Value -is [System.Collections.IDictionary]) {
    $out = [ordered]@{}
    foreach ($key in @($Value.Keys)) {
      $out[[string]$key] = ConvertTo-SettingsOrdered $Value[$key]
    }
    return $out
  }

  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $out = [ordered]@{}
    foreach ($prop in $Value.PSObject.Properties) {
      $out[[string]$prop.Name] = ConvertTo-SettingsOrdered $prop.Value
    }
    return $out
  }

  if ($Value -is [System.Collections.IEnumerable]) {
    $list = New-Object System.Collections.ArrayList
    foreach ($item in $Value) { [void]$list.Add((ConvertTo-SettingsOrdered $item)) }
    return , $list.ToArray()
  }

  return $Value
}

# 按 "a.b.c" 取嵌套值；不存在返回 $null（绝不抛）。
function Get-SettingsPathValue {
  param($Root, [string]$Path)

  if ($null -eq $Root -or [string]::IsNullOrEmpty($Path)) { return $null }
  $current = $Root
  foreach ($key in $Path.Split('.')) {
    if ($null -eq $current) { return $null }
    if ($current -is [System.Collections.IDictionary]) {
      if (-not $current.Contains($key)) { return $null }
      $current = $current[$key]
    } elseif ($current -is [System.Management.Automation.PSCustomObject]) {
      $prop = $current.PSObject.Properties[$key]
      if ($null -eq $prop) { return $null }
      $current = $prop.Value
    } else {
      return $null
    }
  }
  return $current
}

# 按 "a.b.c" 写嵌套值（中间层缺失自动补 [ordered]，不破坏已有顺序）。
function Set-SettingsPathValue {
  param($Root, [string]$Path, $Value)

  if ($null -eq $Root -or [string]::IsNullOrEmpty($Path)) { return }
  if (-not ($Root -is [System.Collections.IDictionary])) { return }

  $keys = $Path.Split('.')
  $current = $Root
  for ($i = 0; $i -lt ($keys.Length - 1); $i++) {
    $key = $keys[$i]
    $next = $null
    if ($current.Contains($key)) { $next = $current[$key] }
    if (-not ($next -is [System.Collections.IDictionary])) {
      $next = [ordered]@{}
      $current[$key] = $next
    }
    $current = $next
  }
  $current[$keys[$keys.Length - 1]] = $Value
}

# 取 Tag 里的键（hashtable / OrderedDictionary 都支持）；不存在返回 $null。
function Get-SettingsTagValue {
  param($Tag, [string]$Name)

  if ($null -eq $Tag) { return $null }
  if (-not ($Tag -is [System.Collections.IDictionary])) { return $null }
  if ($Tag.Contains($Name)) { return $Tag[$Name] }
  return $null
}

# PROTOCOL.md §4 的默认配置（示例值一律为空串 / 默认枚举，绝不含真实凭据）。
function New-SettingsDefaultConfig {
  return [ordered]@{
    version   = 1
    runtime   = [ordered]@{
      nodePath             = ''
      syncTimeoutMinutes   = 120
      pullTimeoutMinutes   = 10
      pushTimeoutMinutes   = 5
    }
    startup   = [ordered]@{
      enabled    = $false
      runOnStart = $true
    }
    scheduler = [ordered]@{
      intervalMinutes = 10
      catchUpOnWake   = $true
    }
    wifi      = [ordered]@{
      enabled                = $false
      ssid                   = ''
      password               = ''
      useSavedFirst          = $true
      alwaysConnect          = $false
      skipOnFailure          = $true
      disconnectAfter        = $false
      disconnectEvenOnFailure = $true
      forgetOnDisconnect     = $false
    }
    stages    = [ordered]@{
      pull   = [ordered]@{ enabled = $true; strategy = 'rebase' }
      sync   = [ordered]@{ enabled = $true }
      commit = [ordered]@{ enabled = $true; identityMode = 'gha'; userName = ''; userEmail = '' }
      push   = [ordered]@{ enabled = $true }
    }
    credentials = [ordered]@{
      H1111_SESSION  = ''
      H1111_USER     = ''
      H1111_PASSWORD = ''
      GH_TOKEN       = ''
      PUSH_TOKEN     = ''
    }
    notifications = [ordered]@{
      mode       = 'standard'
      standard   = [ordered]@{
        success        = $true
        'up-to-date'   = $false
        failure        = $true
        'internal-error' = $true
      }
      cumulative = [ordered]@{
        everyRuns          = 7
        internalErrorMode = 'always'
      }
    }
    appearance = [ordered]@{
      iconPath = $null
    }
    logging    = [ordered]@{
      retentionDays = 90
    }
    security   = [ordered]@{
      lockPassword = ''
    }
  }
}

# =============================================================================
# 区域 2：本地预校验（最终仍由 Node 的 normalizeConfig 校验；这里只负责「本地先挡一遍」）
# =============================================================================

# 详细版校验：每项带 Path（用于把用户带到出错的页签）+ Message（给人看）。
function Test-SettingsConfigDetailed {
  param($Config)

  $errors = New-Object System.Collections.ArrayList
  function Add-Error {
    param([string]$Path, [string]$Message)
    [void]$errors.Add(@{ Path = $Path; Message = $Message })
  }

  # --- 整数 + 范围 ---
  $intRules = @(
    @{ Path = 'scheduler.intervalMinutes'; Label = '同步间隔（分钟）'; Min = 1; Max = 1440 },
    @{ Path = 'logging.retentionDays'; Label = '日志保留天数'; Min = 0; Max = 3650 },
    @{ Path = 'runtime.syncTimeoutMinutes'; Label = '同步超时（分钟）'; Min = 1; Max = 1440 },
    @{ Path = 'runtime.pullTimeoutMinutes'; Label = 'Pull 超时（分钟）'; Min = 1; Max = 120 },
    @{ Path = 'runtime.pushTimeoutMinutes'; Label = 'Push 超时（分钟）'; Min = 1; Max = 60 },
    @{ Path = 'notifications.cumulative.everyRuns'; Label = '累积通知次数'; Min = 1; Max = 100 }
  )
  foreach ($rule in $intRules) {
    $raw = Get-SettingsPathValue $Config $rule.Path
    $number = $null
    $ok = $false
    if ($null -ne $raw) {
      try {
        $double = [double]$raw
        if ([math]::Floor($double) -eq $double) {
          $number = [int]$double
          $ok = $true
        }
      } catch {
        $ok = $false
      }
    }
    if (-not $ok) {
      Add-Error $rule.Path ('{0}（{1}）必须是整数' -f $rule.Label, $rule.Path)
      continue
    }
    if ($number -lt [int]$rule.Min -or $number -gt [int]$rule.Max) {
      Add-Error $rule.Path ('{0}（{1}）必须是 {2}–{3} 的整数，当前是 {4}' -f $rule.Label, $rule.Path, $rule.Min, $rule.Max, $number)
    }
  }

  # --- 枚举 ---
  $enumRules = @(
    @{ Path = 'stages.pull.strategy'; Label = 'Pull 策略'; Values = @('rebase', 'ff-only') },
    @{ Path = 'stages.commit.identityMode'; Label = 'Git 身份'; Values = @('gha', 'default', 'custom') },
    @{ Path = 'notifications.mode'; Label = '通知模式'; Values = @('standard', 'cumulative') },
    @{ Path = 'notifications.cumulative.internalErrorMode'; Label = '内部错误通知'; Values = @('always', 'never') }
  )
  foreach ($rule in $enumRules) {
    $raw = Get-SettingsPathValue $Config $rule.Path
    $value = [string]$raw
    if (-not ($rule.Values -contains $value)) {
      Add-Error $rule.Path ('{0}（{1}）只能是 {2}，当前是「{3}」' -f $rule.Label, $rule.Path, ($rule.Values -join ' / '), $value)
    }
  }

  # --- 组合约束：自定义 Git 身份时用户名 / 邮箱必须有效 ---
  $identityMode = [string](Get-SettingsPathValue $Config 'stages.commit.identityMode')
  if ($identityMode -eq 'custom') {
    $userName = ([string](Get-SettingsPathValue $Config 'stages.commit.userName')).Trim()
    $userEmail = ([string](Get-SettingsPathValue $Config 'stages.commit.userEmail')).Trim()
    if ([string]::IsNullOrEmpty($userName)) {
      Add-Error 'stages.commit.userName' 'Git 身份为「自定义」时，用户名不能为空'
    }
    if ([string]::IsNullOrEmpty($userEmail)) {
      Add-Error 'stages.commit.userEmail' 'Git 身份为「自定义」时，邮箱不能为空'
    } elseif ($userEmail -notmatch '^[^\s@]+@[^\s@]+$') {
      Add-Error 'stages.commit.userEmail' ('Git 邮箱格式不正确：「{0}」' -f $userEmail)
    }
  }

  return $errors.ToArray()
}

# 返回 [string[]] 错误信息；空数组 = 通过。错误文案与 Node 的 config.mjs 风格一致。
function Test-SettingsConfig {
  param($Config)

  $messages = @()
  foreach ($item in (Test-SettingsConfigDetailed -Config $Config)) {
    $messages += [string]$item['Message']
  }
  return $messages
}

# =============================================================================
# 区域 3：Tag 与控件工厂
#
# 每个「配置字段」控件在 Tag 里放一张小 hashtable：
#   Path      : "scheduler.intervalMinutes" 之类的配置路径（必填）
#   Kind      : 'bool' | 'int' | 'enum' | 'enumBool' | 'string'
#   Invert    : Kind='bool' 时，控件 true → 配置 false（用于「跳过 XX 阶段」）
#   Values    : Kind='enum' 为配置取值数组；Kind='enumBool' 为 @(勾选值, 未勾选值)
#   EnableIf  : 可选，@{ Path = '...'; Values = @(...) }，仅当该路径当前值命中才启用
# =============================================================================

function New-SettingsTag {
  param([string]$Path, [string]$Kind, [hashtable]$Extra = $null)

  $tag = @{ Path = $Path; Kind = $Kind }
  if ($null -ne $Extra) {
    foreach ($key in $Extra.Keys) { $tag[[string]$key] = $Extra[$key] }
  }
  return $tag
}

# 新建一页：TabPage(AutoScroll) + 3 列 TableLayoutPanel（标签 / 控件 / 尾部）
function New-SettingsPageTable {
  param($Tabs, [string]$Title)

  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = $Title
  $page.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)
  $page.AutoScroll = $true
  try { $page.UseVisualStyleBackColor = $true } catch { }

  $table = New-Object System.Windows.Forms.TableLayoutPanel
  $table.Dock = 'Top'
  $table.AutoSize = $true
  $table.AutoSizeMode = 'GrowAndShrink'
  $table.ColumnCount = 3
  [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 176)))
  [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
  [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 86)))

  $page.Controls.Add($table)
  [void]$Tabs.TabPages.Add($page)
  return $table
}

# 占一行：扩行数 + 补 AutoSize 行样式，返回行号
function New-SettingsRowIndex {
  param($Table)

  $row = [int]$Table.RowCount
  if ($row -lt 0) { $row = 0 }
  while ($Table.RowStyles.Count -lt ($row + 1)) {
    [void]$Table.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
  }
  $Table.RowCount = $row + 1
  return $row
}

# 普通行：列 0 中文标签，列 1 控件，列 2 可选尾部控件
function Add-SettingsRow {
  param($Table, [string]$LabelText, $Control, $Trailing = $null)

  $row = New-SettingsRowIndex $Table

  $label = New-Object System.Windows.Forms.Label
  $label.Text = $LabelText
  $label.AutoSize = $false
  $label.Dock = 'Fill'
  $label.TextAlign = 'MiddleLeft'
  $label.Margin = New-Object System.Windows.Forms.Padding(0, 4, 8, 4)
  $Table.Controls.Add($label, 0, $row)
  $Table.Controls.Add($Control, 1, $row)
  if ($null -ne $Trailing) { $Table.Controls.Add($Trailing, 2, $row) }
  try {
    if ($Control.Tag -is [System.Collections.IDictionary]) {
      $Control.Tag['_SettingsRowTable'] = $Table
      $Control.Tag['_SettingsRow'] = $row
    }
  } catch { }
}

# 设置一整行的可见性。WinForms 只隐藏控件会留下空白行，因此同步把行高设为 0。
function Set-SettingsRowVisible {
  param($Table, [int]$Row, [bool]$Visible)

  if ($null -eq $Table -or $Row -lt 0 -or $Row -ge $Table.RowStyles.Count) { return }
  foreach ($control in @($Table.Controls)) {
    try {
      if ([int]$Table.GetRow($control) -eq $Row) { $control.Visible = $Visible }
    } catch { }
  }
  try {
    if ($Visible) {
      $Table.RowStyles[$Row].SizeType = [System.Windows.Forms.SizeType]::AutoSize
      $Table.RowStyles[$Row].Height = 0
    } else {
      $Table.RowStyles[$Row].SizeType = [System.Windows.Forms.SizeType]::Absolute
      $Table.RowStyles[$Row].Height = 0
    }
  } catch { }
}

# 勾选行：CheckBox 自带中文标签，跨 3 列
function Add-SettingsCheckRow {
  param($Table, $CheckBox)

  $row = New-SettingsRowIndex $Table
  $CheckBox.Anchor = 'Left'
  $CheckBox.Margin = New-Object System.Windows.Forms.Padding(0, 5, 0, 5)
  $Table.Controls.Add($CheckBox, 0, $row)
  $Table.SetColumnSpan($CheckBox, 3)
  try {
    if ($CheckBox.Tag -is [System.Collections.IDictionary]) {
      $CheckBox.Tag['_SettingsRowTable'] = $Table
      $CheckBox.Tag['_SettingsRow'] = $row
    }
  } catch { }
}

# 分组标题行（跨 3 列，加粗）
function Add-SettingsSectionRow {
  param($Table, [string]$Text, $BoldFont, $EnableIf = $null)

  $row = New-SettingsRowIndex $Table
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.AutoSize = $false
  $label.Dock = 'Fill'
  $label.Height = 24
  $label.ForeColor = [System.Drawing.Color]::FromArgb(0, 90, 158)
  $label.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 2)
  if ($null -ne $BoldFont) { $label.Font = $BoldFont }
  $Table.Controls.Add($label, 0, $row)
  $Table.SetColumnSpan($label, 3)
  if ($null -ne $EnableIf) {
    $tag = @{ Path = ''; Kind = 'section'; EnableIf = $EnableIf; _SettingsRowTable = $Table; _SettingsRow = $row }
    $label.Tag = $tag
  }
}

function New-SettingsCheckBox {
  param([string]$Text, $Tag, [bool]$Checked = $false)

  $box = New-Object System.Windows.Forms.CheckBox
  $box.Text = $Text
  $box.AutoSize = $true
  $box.Checked = $Checked
  try { $box.UseVisualStyleBackColor = $true } catch { }
  if ($null -ne $Tag) { $box.Tag = $Tag }
  return $box
}

function New-SettingsTextBox {
  param([string]$Value, $Tag, [switch]$Secret)

  $box = New-Object System.Windows.Forms.TextBox
  $box.Text = [string]$Value
  $box.Dock = 'Fill'
  $box.Margin = New-Object System.Windows.Forms.Padding(0, 4, 6, 4)
  if ($Secret) { $box.PasswordChar = '*' }
  if ($null -ne $Tag) { $box.Tag = $Tag }
  return $box
}

function New-SettingsNumber {
  param($Value, $Tag, [int]$MinValue, [int]$MaxValue)

  $box = New-Object System.Windows.Forms.NumericUpDown
  $box.Minimum = [decimal]$MinValue
  $box.Maximum = [decimal]$MaxValue
  $box.Width = 96
  $box.Anchor = 'Left'
  $box.TextAlign = 'Right'
  $box.Margin = New-Object System.Windows.Forms.Padding(0, 4, 6, 4)

  $number = $MinValue
  if ($null -ne $Value) {
    try { $number = [int]$Value } catch { $number = $MinValue }
  }
  if ($number -lt $MinValue) { $number = $MinValue }
  if ($number -gt $MaxValue) { $number = $MaxValue }
  $box.Value = [decimal]$number

  if ($null -ne $Tag) { $box.Tag = $Tag }
  return $box
}

function New-SettingsCombo {
  param([string[]]$DisplayTexts, [string[]]$Values, [string]$Current, $Tag)

  $combo = New-Object System.Windows.Forms.ComboBox
  $combo.DropDownStyle = 'DropDownList'
  $combo.Width = 260
  $combo.Anchor = 'Left'
  $combo.Margin = New-Object System.Windows.Forms.Padding(0, 4, 6, 4)
  foreach ($text in $DisplayTexts) { [void]$combo.Items.Add($text) }

  $index = -1
  for ($i = 0; $i -lt $Values.Count; $i++) {
    if ([string]$Values[$i] -ceq [string]$Current) { $index = $i; break }
  }
  if ($index -ge 0) { $combo.SelectedIndex = $index }

  if ($null -ne $Tag) { $combo.Tag = $Tag }
  return $combo
}

# 行工厂 ---------------------------------------------------------------

function Add-SettingsCheck {
  param($Table, [string]$Text, [string]$Path, [bool]$Checked = $false, [switch]$Invert, $EnableIf = $null)

  $extra = @{ }
  if ($Invert) { $extra['Invert'] = $true }
  if ($null -ne $EnableIf) { $extra['EnableIf'] = $EnableIf }
  $tag = New-SettingsTag -Path $Path -Kind 'bool' -Extra $extra
  $box = New-SettingsCheckBox -Text $Text -Tag $tag -Checked $Checked
  Add-SettingsCheckRow -Table $Table -CheckBox $box
  return $box
}

function Add-SettingsEnumCheck {
  param($Table, [string]$Text, [string]$Path, [string[]]$Values, [string]$Current, $EnableIf = $null)

  $extra = @{ Values = $Values }
  if ($null -ne $EnableIf) { $extra['EnableIf'] = $EnableIf }
  $tag = New-SettingsTag -Path $Path -Kind 'enumBool' -Extra $extra
  $checked = ([string]$Current -eq [string]$Values[0])
  $box = New-SettingsCheckBox -Text $Text -Tag $tag -Checked $checked
  Add-SettingsCheckRow -Table $Table -CheckBox $box
  return $box
}

function Add-SettingsText {
  param($Table, [string]$LabelText, [string]$Path, [string]$Value, $EnableIf = $null)

  $extra = @{ }
  if ($null -ne $EnableIf) { $extra['EnableIf'] = $EnableIf }
  $tag = New-SettingsTag -Path $Path -Kind 'string' -Extra $extra
  $box = New-SettingsTextBox -Value $Value -Tag $tag
  Add-SettingsRow -Table $Table -LabelText $LabelText -Control $box
  return $box
}

# 密码行：TextBox(PasswordChar='*') + 尾部「显示」勾选（切换明文）
function Add-SettingsPassword {
  param($Table, [string]$LabelText, [string]$Path, [string]$Value, $EnableIf = $null)

  $extra = @{ }
  if ($null -ne $EnableIf) { $extra['EnableIf'] = $EnableIf }
  $tag = New-SettingsTag -Path $Path -Kind 'string' -Extra $extra
  $box = New-SettingsTextBox -Value $Value -Tag $tag -Secret
  $box.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 4)

  $reveal = New-Object System.Windows.Forms.CheckBox
  $reveal.Text = '显示'
  $reveal.AutoSize = $true
  $reveal.Anchor = 'Left'
  $reveal.Margin = New-Object System.Windows.Forms.Padding(6, 5, 0, 4)
  try { $reveal.UseVisualStyleBackColor = $true } catch { }
  $reveal.add_CheckedChanged({
      param($sender, $eventArgs)
      try {
        if ($sender.Checked) { $box.PasswordChar = [char]0 } else { $box.PasswordChar = '*' }
      } catch { }
    }.GetNewClosure())

  Add-SettingsRow -Table $Table -LabelText $LabelText -Control $box -Trailing $reveal
  return $box
}

function Add-SettingsNumber {
  param($Table, [string]$LabelText, [string]$Path, $Value, [int]$MinValue, [int]$MaxValue, $EnableIf = $null)

  $extra = @{ }
  if ($null -ne $EnableIf) { $extra['EnableIf'] = $EnableIf }
  $tag = New-SettingsTag -Path $Path -Kind 'int' -Extra $extra
  $box = New-SettingsNumber -Value $Value -Tag $tag -MinValue $MinValue -MaxValue $MaxValue
  Add-SettingsRow -Table $Table -LabelText $LabelText -Control $box
  return $box
}

function Add-SettingsCombo {
  param($Table, [string]$LabelText, [string]$Path, [string[]]$DisplayTexts, [string[]]$Values, [string]$Current, $EnableIf = $null)

  $extra = @{ Values = $Values }
  if ($null -ne $EnableIf) { $extra['EnableIf'] = $EnableIf }
  $tag = New-SettingsTag -Path $Path -Kind 'enum' -Extra $extra
  $combo = New-SettingsCombo -DisplayTexts $DisplayTexts -Values $Values -Current $Current -Tag $tag
  Add-SettingsRow -Table $Table -LabelText $LabelText -Control $combo
  return $combo
}

# 配置读取小工具（一律带默认值，绝不抛） ---------------------------------

function Get-SettingsConfigBool {
  param($Config, [string]$Path, [bool]$Default = $false)

  $raw = Get-SettingsPathValue $Config $Path
  if ($null -eq $raw) { return $Default }
  if ($raw -is [bool]) { return [bool]$raw }
  $text = [string]$raw
  if ($text -eq 'true' -or $text -eq '1') { return $true }
  if ($text -eq 'false' -or $text -eq '0') { return $false }
  return $Default
}

function Get-SettingsConfigString {
  param($Config, [string]$Path, [string]$Default = '')

  $raw = Get-SettingsPathValue $Config $Path
  if ($null -eq $raw) { return $Default }
  return [string]$raw
}

# =============================================================================
# 区域 4：9 个分页（PROTOCOL.md §7 表格逐条对应）
# =============================================================================

# --- 部署 -------------------------------------------------------------
function Add-SettingsDeployPage {
  param($Tabs, $Config, $BoldFont, $Form)

  $table = New-SettingsPageTable -Tabs $Tabs -Title '部署'
  Add-SettingsSectionRow -Table $table -Text '部署' -BoldFont $BoldFont

  [void](Add-SettingsCheck -Table $table -Text '开机自启动（Windows 当前用户；保存后由托盘创建/删除快捷方式）' `
      -Path 'startup.enabled' -Checked (Get-SettingsConfigBool $Config 'startup.enabled' $false))
  [void](Add-SettingsCheck -Table $table -Text '启动后立即同步一次' `
      -Path 'startup.runOnStart' -Checked (Get-SettingsConfigBool $Config 'startup.runOnStart' $true))

  Add-SettingsSectionRow -Table $table -Text '托盘外观' -BoldFont $BoldFont

  $iconLabel = New-Object System.Windows.Forms.Label
  $iconLabel.Text = '默认图标'
  $iconLabel.AutoSize = $false
  $iconLabel.Dock = 'Fill'
  $iconLabel.TextAlign = 'MiddleLeft'
  $iconLabel.ForeColor = [System.Drawing.Color]::DimGray
  $iconLabel.Margin = New-Object System.Windows.Forms.Padding(0, 4, 6, 4)
  $Form.Tag['IconLabel'] = $iconLabel

  $iconButtons = New-Object System.Windows.Forms.FlowLayoutPanel
  $iconButtons.AutoSize = $true
  $iconButtons.AutoSizeMode = 'GrowAndShrink'
  $iconButtons.WrapContents = $false
  $iconButtons.Anchor = 'Left'
  $iconButtons.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 2)

  $btnSelect = New-Object System.Windows.Forms.Button
  $btnSelect.Text = '选择图片…'
  $btnSelect.Size = New-Object System.Drawing.Size(100, 28)
  $btnSelect.Margin = New-Object System.Windows.Forms.Padding(0, 2, 8, 2)
  try { $btnSelect.UseVisualStyleBackColor = $true } catch { }

  $btnReset = New-Object System.Windows.Forms.Button
  $btnReset.Text = '重置默认图标'
  $btnReset.Size = New-Object System.Drawing.Size(112, 28)
  $btnReset.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 2)
  try { $btnReset.UseVisualStyleBackColor = $true } catch { }

  $iconButtons.Controls.Add($btnSelect)
  $iconButtons.Controls.Add($btnReset)

  Add-SettingsRow -Table $table -LabelText '当前图标' -Control $iconLabel
  Add-SettingsRow -Table $table -LabelText '自定义图标' -Control $iconButtons

  # 「选择图片…」：只记录意图（_iconAction='set' + _iconPath），不动文件、不写配置
  $btnSelect.add_Click({
      param($sender, $eventArgs)
      $dialog = $null
      try {
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = '选择托盘图标图片'
        $dialog.Filter = '图片文件|*.png;*.ico;*.bmp;*.jpg'
        $dialog.CheckFileExists = $true
        $dialog.Multiselect = $false
        $dialog.RestoreDirectory = $true
        if ($dialog.ShowDialog($Form) -eq [System.Windows.Forms.DialogResult]::OK) {
          $picked = [string]$dialog.FileName
          if ($picked) {
            $Form.Tag['IconAction'] = 'set'
            $Form.Tag['IconPath'] = $picked
            Update-SettingsIconLabel -Form $Form
            Set-SettingsStatus -Form $Form -Text ('已选择图标：' + [System.IO.Path]::GetFileName($picked) + '（保存后由 Node 复制进 assets/）')
          }
        }
      } catch {
        try { Set-SettingsStatus -Form $Form -Text ('选择图片失败：' + $_.Exception.Message) -IsError } catch { }
      } finally {
        if ($null -ne $dialog) { try { $dialog.Dispose() } catch { } }
      }
    }.GetNewClosure())

  # 「重置默认图标」：同样只记录意图（_iconAction='reset'）
  $btnReset.add_Click({
      param($sender, $eventArgs)
      try {
        $Form.Tag['IconAction'] = 'reset'
        $Form.Tag['IconPath'] = $null
        Update-SettingsIconLabel -Form $Form
        Set-SettingsStatus -Form $Form -Text '保存后恢复默认图标。'
      } catch {
        try { Set-SettingsStatus -Form $Form -Text ('重置图标失败：' + $_.Exception.Message) -IsError } catch { }
      }
    }.GetNewClosure())

  $Form.Tag['BtnSelectIcon'] = $btnSelect
  $Form.Tag['BtnResetIcon'] = $btnReset
  Update-SettingsIconLabel -Form $Form
  return $table
}

# --- 准备阶段（WiFi） -------------------------------------------------
function Add-SettingsPreparePage {
  param($Tabs, $Config, $BoldFont)

  $table = New-SettingsPageTable -Tabs $Tabs -Title '准备阶段'
  Add-SettingsSectionRow -Table $table -Text 'WiFi 管理（准备阶段）' -BoldFont $BoldFont

  $wifiEnabled = Get-SettingsConfigBool $Config 'wifi.enabled' $false
  $whenEnabled = @{ Path = 'wifi.enabled'; Values = @($true) }

  [void](Add-SettingsCheck -Table $table -Text '同步前检查并连接指定 WiFi（总开关）' `
      -Path 'wifi.enabled' -Checked $wifiEnabled)
  [void](Add-SettingsText -Table $table -LabelText 'WiFi 名称（SSID）' -Path 'wifi.ssid' `
      -Value (Get-SettingsConfigString $Config 'wifi.ssid') -EnableIf $whenEnabled)
  [void](Add-SettingsPassword -Table $table -LabelText 'WiFi 密码' -Path 'wifi.password' `
      -Value (Get-SettingsConfigString $Config 'wifi.password') -EnableIf $whenEnabled)
  [void](Add-SettingsCheck -Table $table -Text '优先使用 Windows 已保存的密码' `
      -Path 'wifi.useSavedFirst' -Checked (Get-SettingsConfigBool $Config 'wifi.useSavedFirst' $true) -EnableIf $whenEnabled)
  [void](Add-SettingsCheck -Table $table -Text '不检查网络，总是尝试连接' `
      -Path 'wifi.alwaysConnect' -Checked (Get-SettingsConfigBool $Config 'wifi.alwaysConnect' $false) -EnableIf $whenEnabled)
  [void](Add-SettingsCheck -Table $table -Text '连接失败时跳过整次同步' `
      -Path 'wifi.skipOnFailure' -Checked (Get-SettingsConfigBool $Config 'wifi.skipOnFailure' $true) -EnableIf $whenEnabled)

  return $table
}

# --- Pull -------------------------------------------------------------
function Add-SettingsPullPage {
  param($Tabs, $Config, $BoldFont)

  $table = New-SettingsPageTable -Tabs $Tabs -Title 'Pull'
  Add-SettingsSectionRow -Table $table -Text 'Pull（同步前拉取）' -BoldFont $BoldFont

  $enabled = Get-SettingsConfigBool $Config 'stages.pull.enabled' $true
  [void](Add-SettingsCheck -Table $table -Text '跳过 Pull 阶段（不同步前拉取远端）' `
      -Path 'stages.pull.enabled' -Checked (-not $enabled) -Invert)

  [void](Add-SettingsCombo -Table $table -LabelText 'Pull 策略' -Path 'stages.pull.strategy' `
      -DisplayTexts @('rebase（变基）', 'ff-only（仅快进）') -Values @('rebase', 'ff-only') `
      -Current (Get-SettingsConfigString $Config 'stages.pull.strategy' 'rebase') `
      -EnableIf @{ Path = 'stages.pull.enabled'; Values = @($true) })

  return $table
}

# --- Sync -------------------------------------------------------------
function Add-SettingsSyncPage {
  param($Tabs, $Config, $BoldFont)

  $table = New-SettingsPageTable -Tabs $Tabs -Title 'Sync'
  Add-SettingsSectionRow -Table $table -Text 'Sync（探测 / 下载 / 写数据）' -BoldFont $BoldFont

  $enabled = Get-SettingsConfigBool $Config 'stages.sync.enabled' $true
  $whenEnabled = @{ Path = 'stages.sync.enabled'; Values = @($true) }

  [void](Add-SettingsCheck -Table $table -Text '跳过 Sync 阶段（不执行探测 / 下载 / 写数据）' `
      -Path 'stages.sync.enabled' -Checked (-not $enabled) -Invert)

  Add-SettingsSectionRow -Table $table -Text '网盘凭据' -BoldFont $BoldFont -EnableIf $whenEnabled

  [void](Add-SettingsPassword -Table $table -LabelText 'H1111_SESSION' -Path 'credentials.H1111_SESSION' `
      -Value (Get-SettingsConfigString $Config 'credentials.H1111_SESSION') -EnableIf $whenEnabled)
  [void](Add-SettingsText -Table $table -LabelText 'H1111_USER' -Path 'credentials.H1111_USER' `
      -Value (Get-SettingsConfigString $Config 'credentials.H1111_USER') -EnableIf $whenEnabled)
  [void](Add-SettingsPassword -Table $table -LabelText 'H1111_PASSWORD' -Path 'credentials.H1111_PASSWORD' `
      -Value (Get-SettingsConfigString $Config 'credentials.H1111_PASSWORD') -EnableIf $whenEnabled)

  return $table
}

# --- Commit -----------------------------------------------------------
function Add-SettingsCommitPage {
  param($Tabs, $Config, $BoldFont)

  $table = New-SettingsPageTable -Tabs $Tabs -Title 'Commit'
  Add-SettingsSectionRow -Table $table -Text 'Commit（提交）' -BoldFont $BoldFont

  $enabled = Get-SettingsConfigBool $Config 'stages.commit.enabled' $true
  [void](Add-SettingsCheck -Table $table -Text '跳过 Commit 阶段（不生成提交）' `
      -Path 'stages.commit.enabled' -Checked (-not $enabled) -Invert)

  $identityMode = Get-SettingsConfigString $Config 'stages.commit.identityMode' 'gha'
  [void](Add-SettingsCombo -Table $table -LabelText 'Git 身份' -Path 'stages.commit.identityMode' `
      -DisplayTexts @('GHA（github-actions[bot]）', '默认（本机 git 配置）', '自定义（用户名 + 邮箱）') `
      -Values @('gha', 'default', 'custom') -Current $identityMode `
      -EnableIf @{ Path = 'stages.commit.enabled'; Values = @($true) })

  $whenCustom = @{ Path = 'stages.commit.identityMode'; Values = @('custom') }
  [void](Add-SettingsText -Table $table -LabelText '自定义用户名' -Path 'stages.commit.userName' `
      -Value (Get-SettingsConfigString $Config 'stages.commit.userName') -EnableIf $whenCustom)
  [void](Add-SettingsText -Table $table -LabelText '自定义邮箱' -Path 'stages.commit.userEmail' `
      -Value (Get-SettingsConfigString $Config 'stages.commit.userEmail') -EnableIf $whenCustom)

  return $table
}

# --- Push -------------------------------------------------------------
function Add-SettingsPushPage {
  param($Tabs, $Config, $BoldFont)

  $table = New-SettingsPageTable -Tabs $Tabs -Title 'Push'
  Add-SettingsSectionRow -Table $table -Text 'Push（推送）' -BoldFont $BoldFont

  $enabled = Get-SettingsConfigBool $Config 'stages.push.enabled' $true
  [void](Add-SettingsCheck -Table $table -Text '跳过 Push 阶段（不推送到远端）' `
      -Path 'stages.push.enabled' -Checked (-not $enabled) -Invert)

  Add-SettingsSectionRow -Table $table -Text '推送凭据' -BoldFont $BoldFont
  [void](Add-SettingsPassword -Table $table -LabelText 'PUSH_TOKEN' -Path 'credentials.PUSH_TOKEN' `
      -Value (Get-SettingsConfigString $Config 'credentials.PUSH_TOKEN') `
      -EnableIf @{ Path = 'stages.push.enabled'; Values = @($true) })

  return $table
}

# --- 结束阶段 ---------------------------------------------------------
function Add-SettingsFinishPage {
  param($Tabs, $Config, $BoldFont)

  $table = New-SettingsPageTable -Tabs $Tabs -Title '结束阶段'
  Add-SettingsSectionRow -Table $table -Text '结束阶段（WiFi 收尾）' -BoldFont $BoldFont

  $disconnectAfter = Get-SettingsConfigBool $Config 'wifi.disconnectAfter' $false
  $whenDisconnect = @{ Path = 'wifi.disconnectAfter'; Values = @($true) }

  [void](Add-SettingsCheck -Table $table -Text '同步结束后断开指定 WiFi' `
      -Path 'wifi.disconnectAfter' -Checked $disconnectAfter)
  [void](Add-SettingsCheck -Table $table -Text '同步失败时也断开' `
      -Path 'wifi.disconnectEvenOnFailure' -Checked (Get-SettingsConfigBool $Config 'wifi.disconnectEvenOnFailure' $true) `
      -EnableIf $whenDisconnect)
  [void](Add-SettingsCheck -Table $table -Text '断开后忘记该 WiFi 配置' `
      -Path 'wifi.forgetOnDisconnect' -Checked (Get-SettingsConfigBool $Config 'wifi.forgetOnDisconnect' $false) `
      -EnableIf $whenDisconnect)

  return $table
}

# --- 通知 -------------------------------------------------------------
function Add-SettingsNotifyPage {
  param($Tabs, $Config, $BoldFont)

  $table = New-SettingsPageTable -Tabs $Tabs -Title '通知'
  Add-SettingsSectionRow -Table $table -Text '通知模式' -BoldFont $BoldFont

  [void](Add-SettingsCombo -Table $table -LabelText '通知模式' -Path 'notifications.mode' `
      -DisplayTexts @('标准模式（每次按结果通知）', '累积模式（每 N 次汇总一次）') `
      -Values @('standard', 'cumulative') `
      -Current (Get-SettingsConfigString $Config 'notifications.mode' 'standard'))

  $whenStandard = @{ Path = 'notifications.mode'; Values = @('standard') }
  $whenCumulative = @{ Path = 'notifications.mode'; Values = @('cumulative') }

  Add-SettingsSectionRow -Table $table -Text '标准模式：按结果类型通知' -BoldFont $BoldFont -EnableIf $whenStandard
  [void](Add-SettingsCheck -Table $table -Text '成功' -Path 'notifications.standard.success' `
      -Checked (Get-SettingsConfigBool $Config 'notifications.standard.success' $true) -EnableIf $whenStandard)
  [void](Add-SettingsCheck -Table $table -Text '已是最新' -Path 'notifications.standard.up-to-date' `
      -Checked (Get-SettingsConfigBool $Config 'notifications.standard.up-to-date' $false) -EnableIf $whenStandard)
  [void](Add-SettingsCheck -Table $table -Text '失败' -Path 'notifications.standard.failure' `
      -Checked (Get-SettingsConfigBool $Config 'notifications.standard.failure' $true) -EnableIf $whenStandard)
  [void](Add-SettingsCheck -Table $table -Text '内部错误' -Path 'notifications.standard.internal-error' `
      -Checked (Get-SettingsConfigBool $Config 'notifications.standard.internal-error' $true) -EnableIf $whenStandard)

  Add-SettingsSectionRow -Table $table -Text '累积模式' -BoldFont $BoldFont -EnableIf $whenCumulative
  [void](Add-SettingsNumber -Table $table -LabelText '每累积次数' -Path 'notifications.cumulative.everyRuns' `
      -Value (Get-SettingsPathValue $Config 'notifications.cumulative.everyRuns') -MinValue 1 -MaxValue 100 `
      -EnableIf $whenCumulative)
  [void](Add-SettingsEnumCheck -Table $table -Text '内部错误始终单独弹出（不并入累积汇总）' `
      -Path 'notifications.cumulative.internalErrorMode' -Values @('always', 'never') `
      -Current (Get-SettingsConfigString $Config 'notifications.cumulative.internalErrorMode' 'always') `
      -EnableIf $whenCumulative)

  return $table
}

# --- 其他 -------------------------------------------------------------
function Add-SettingsSchedulePage {
  param($Tabs, $Config, $BoldFont)
  $table = New-SettingsPageTable -Tabs $Tabs -Title '调度'
  Add-SettingsSectionRow -Table $table -Text '调度' -BoldFont $BoldFont
  [void](Add-SettingsNumber -Table $table -LabelText '同步间隔（分钟）' -Path 'scheduler.intervalMinutes' `
      -Value (Get-SettingsPathValue $Config 'scheduler.intervalMinutes') -MinValue 1 -MaxValue 1440)
  [void](Add-SettingsCheck -Table $table -Text '休眠唤醒后补跑一轮' -Path 'scheduler.catchUpOnWake' `
      -Checked (Get-SettingsConfigBool $Config 'scheduler.catchUpOnWake' $true))
  return $table
}

function Add-SettingsRuntimePage {
  param($Tabs, $Config, $BoldFont)
  $table = New-SettingsPageTable -Tabs $Tabs -Title '运行时'
  Add-SettingsSectionRow -Table $table -Text '运行时' -BoldFont $BoldFont
  [void](Add-SettingsText -Table $table -LabelText 'Node 路径（留空 = 自动查找）' -Path 'runtime.nodePath' `
      -Value (Get-SettingsConfigString $Config 'runtime.nodePath'))
  [void](Add-SettingsNumber -Table $table -LabelText '同步超时（分钟）' -Path 'runtime.syncTimeoutMinutes' `
      -Value (Get-SettingsPathValue $Config 'runtime.syncTimeoutMinutes') -MinValue 1 -MaxValue 1440)
  [void](Add-SettingsNumber -Table $table -LabelText 'Pull 超时（分钟）' -Path 'runtime.pullTimeoutMinutes' `
      -Value (Get-SettingsPathValue $Config 'runtime.pullTimeoutMinutes') -MinValue 1 -MaxValue 120)
  [void](Add-SettingsNumber -Table $table -LabelText 'Push 超时（分钟）' -Path 'runtime.pushTimeoutMinutes' `
      -Value (Get-SettingsPathValue $Config 'runtime.pushTimeoutMinutes') -MinValue 1 -MaxValue 60)
  return $table
}

function Add-SettingsLoggingPage {
  param($Tabs, $Config, $BoldFont)
  $table = New-SettingsPageTable -Tabs $Tabs -Title '日志与安全'
  Add-SettingsSectionRow -Table $table -Text '日志与安全' -BoldFont $BoldFont
  [void](Add-SettingsNumber -Table $table -LabelText '日志保留天数（0 = 永久）' -Path 'logging.retentionDays' `
      -Value (Get-SettingsPathValue $Config 'logging.retentionDays') -MinValue 0 -MaxValue 3650)
  [void](Add-SettingsPassword -Table $table -LabelText '锁定密码（留空 = 不能锁定）' -Path 'security.lockPassword' `
      -Value (Get-SettingsConfigString $Config 'security.lockPassword'))
  return $table
}

function Add-SettingsGithubPage {
  param($Tabs, $Config, $BoldFont)
  $table = New-SettingsPageTable -Tabs $Tabs -Title 'GitHub 凭据'
  Add-SettingsSectionRow -Table $table -Text 'GitHub 凭据' -BoldFont $BoldFont
  [void](Add-SettingsPassword -Table $table -LabelText 'GH_TOKEN（probe 只读 Token）' -Path 'credentials.GH_TOKEN' `
      -Value (Get-SettingsConfigString $Config 'credentials.GH_TOKEN'))
  return $table
}

# 顶层主分页中的嵌套 TabControl。子页仍复用同一套字段控件和联动逻辑。
function Add-SettingsNestedGroup {
  param($Tabs, [string]$Title, $Config, $BoldFont, [scriptblock]$Builder)
  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = $Title
  $page.Padding = New-Object System.Windows.Forms.Padding(6)
  $nested = New-Object System.Windows.Forms.TabControl
  $nested.Dock = 'Fill'
  $page.Controls.Add($nested)
  [void]$Tabs.TabPages.Add($page)
  & $Builder $nested $Config $BoldFont
  return $page
}

# =============================================================================
# 区域 5：控件 ↔ 配置 的读写
# =============================================================================

# 递归收集所有「带 Tag 字典」的字段控件（顺序 = 加入顺序，可重复调用）
function Get-SettingsFieldControls {
  param($Parent)

  $found = New-Object System.Collections.ArrayList
  if ($null -eq $Parent) { return $found.ToArray() }

  try {
    foreach ($control in $Parent.Controls) {
      if ($null -eq $control) { continue }
      if ($control.Tag -is [System.Collections.IDictionary]) { [void]$found.Add($control) }
      if ($control.HasChildren) {
        foreach ($child in (Get-SettingsFieldControls $control)) { [void]$found.Add($child) }
      }
    }
  } catch {
    # 控件树遍历失败时返回已收集到的部分，绝不抛
  }
  return $found.ToArray()
}

# 读单个控件的「配置值」（按 Tag.Kind 决定怎么取）
function Get-SettingsControlValue {
  param($Control)

  if ($null -eq $Control) { return $null }
  $tag = $Control.Tag
  if (-not ($tag -is [System.Collections.IDictionary])) { return $null }

  $kind = [string](Get-SettingsTagValue $tag 'Kind')
  $value = $null

  switch ($kind) {
    'bool' {
      $value = [bool]$Control.Checked
      if ([bool](Get-SettingsTagValue $tag 'Invert')) { $value = -not $value }
    }
    'enumBool' {
      $values = @(Get-SettingsTagValue $tag 'Values')
      if ($values.Count -ge 2) {
        if ([bool]$Control.Checked) { $value = [string]$values[0] } else { $value = [string]$values[1] }
      }
    }
    'int' {
      try { $value = [int]$Control.Value } catch { $value = $null }
    }
    'enum' {
      $values = @(Get-SettingsTagValue $tag 'Values')
      $index = -1
      try { $index = [int]$Control.SelectedIndex } catch { $index = -1 }
      if ($index -ge 0 -and $index -lt $values.Count) { $value = [string]$values[$index] } else { $value = $null }
    }
    default {
      $value = [string]$Control.Text
    }
  }
  return $value
}

# 按配置路径读「窗体当前值」（给 EnableIf 求值用；找不到返回 $null）
function Get-SettingsFormValue {
  param($Form, [string]$Path)

  foreach ($control in (Get-SettingsFieldControls $Form)) {
    $tag = $control.Tag
    $controlPath = [string](Get-SettingsTagValue $tag 'Path')
    if ($controlPath -eq $Path) { return (Get-SettingsControlValue $control) }
  }
  return $null
}

# EnableIf 求值：条件为空 → 启用；否则当前值必须在 Values 里
function Test-SettingsEnableCondition {
  param($Form, $Condition)

  if (-not ($Condition -is [System.Collections.IDictionary])) { return $true }
  $path = [string](Get-SettingsTagValue $Condition 'Path')
  if ([string]::IsNullOrEmpty($path)) { return $true }

  $expected = @(Get-SettingsTagValue $Condition 'Values')
  if ($expected.Count -eq 0) { return $true }

  $actual = Get-SettingsFormValue -Form $Form -Path $path
  foreach ($candidate in $expected) {
    if ($candidate -is [bool]) {
      if ([bool]$actual -eq [bool]$candidate) { return $true }
    } elseif ([string]$candidate -ceq [string]$actual) {
      return $true
    }
  }
  return $false
}

# 按当前控件状态刷新「哪些控件可编辑」
function Update-SettingsEnableStates {
  param($Form)

  try {
    foreach ($control in (Get-SettingsFieldControls $Form)) {
      $condition = Get-SettingsTagValue $control.Tag 'EnableIf'
      if ($null -eq $condition) { continue }
      $visible = $true
      try { $visible = [bool](Test-SettingsEnableCondition -Form $Form -Condition $condition) } catch { }
      try { $control.Enabled = $visible } catch { }

      # 模式专属设置项不只是禁用，而是连同标签/尾部控件一起隐藏。
      $table = Get-SettingsTagValue $control.Tag '_SettingsRowTable'
      $row = Get-SettingsTagValue $control.Tag '_SettingsRow'
      if ($null -ne $table -and $null -ne $row) {
        Set-SettingsRowVisible -Table $table -Row ([int]$row) -Visible $visible
      }
    }
  } catch {
    # 状态联动失败不影响保存
  }
  try {
    $Form.PerformLayout()
    foreach ($page in $Form.Tag['Tabs'].TabPages) { $page.PerformLayout() }
  } catch { }
}

# 给所有勾选 / 下拉控件挂上「状态联动」监听（值变化 → 重新求值 EnableIf）
function Initialize-SettingsEnableDependencies {
  param($Form)

  $handler = {
    param($sender, $eventArgs)
    try { Update-SettingsEnableStates -Form $Form } catch { }
  }.GetNewClosure()

  foreach ($control in (Get-SettingsFieldControls $Form)) {
    $kind = [string](Get-SettingsTagValue $control.Tag 'Kind')
    try {
      if ($kind -eq 'bool' -or $kind -eq 'enumBool') { $control.add_CheckedChanged($handler) }
      elseif ($kind -eq 'enum') { $control.add_SelectedIndexChanged($handler) }
    } catch { }
  }
}

# 按配置路径找控件（找不到返回 $null）
function Get-SettingsFieldByPath {
  param($Form, [string]$Path)

  if ($null -eq $Form -or [string]::IsNullOrEmpty($Path)) { return $null }
  foreach ($control in (Get-SettingsFieldControls $Form)) {
    if ([string](Get-SettingsTagValue $control.Tag 'Path') -eq $Path) { return $control }
  }
  return $null
}

# 把用户带到某个字段所在的页签（先选顶层页，再选嵌套页）并聚焦该控件。
function Focus-SettingsPath {
  param($Form, [string]$Path)

  $control = Get-SettingsFieldByPath -Form $Form -Path $Path
  if ($null -eq $control) { return $false }

  try {
    $tabs = $Form.Tag['Tabs']
    # 找到该控件所属的 TabPage 链：外层 TabControl → 可能的内层 TabControl
    $node = $control
    while ($null -ne $node -and $node -isnot [System.Windows.Forms.TabPage]) { $node = $node.Parent }
    if ($null -eq $node) { return $false }

    # 该 TabPage 的所有者是 TabControl；若它本身嵌在另一个 TabPage 里，则逐层向上
    $page = $node
    while ($null -ne $page) {
      $owner = $page.Parent
      while ($null -ne $owner -and $owner -isnot [System.Windows.Forms.TabControl]) { $owner = $owner.Parent }
      if ($null -eq $owner) { break }
      $owner.SelectedTab = $page
      $owner.PerformLayout()
      $page = $owner.Parent
      while ($null -ne $page -and $page -isnot [System.Windows.Forms.TabPage]) { $page = $page.Parent }
    }

    try { [void]$control.Focus() } catch { }
    try {
      if ($control -is [System.Windows.Forms.TextBox] -or $control -is [System.Windows.Forms.ComboBox]) { $control.SelectAll() }
    } catch { }
    return $true
  } catch {
    return $false
  }
}

# 状态栏文字（IsError → 红字，否则灰字）
function Set-SettingsStatus {
  param($Form, [string]$Text, [switch]$IsError)

  try {
    $label = $Form.Tag['StatusLabel']
    if ($null -eq $label) { return }
    $label.Text = [string]$Text
    if ($IsError) {
      $label.ForeColor = [System.Drawing.Color]::FromArgb(190, 30, 30)
    } else {
      $label.ForeColor = [System.Drawing.Color]::DimGray
    }
  } catch { }
}

# 「部署」页图标说明文字（只显示文件名，绝不复制文件）
function Update-SettingsIconLabel {
  param($Form)

  try {
    $label = $Form.Tag['IconLabel']
    if ($null -eq $label) { return }

    $action = [string]$Form.Tag['IconAction']
    $path = [string]$Form.Tag['IconPath']
    if ($action -eq 'reset') {
      $label.Text = '默认图标（保存后恢复）'
      return
    }
    if ($action -eq 'set' -and -not [string]::IsNullOrEmpty($path)) {
      $label.Text = [System.IO.Path]::GetFileName($path)
      return
    }

    $current = [string](Get-SettingsPathValue $Form.Tag['Base'] 'appearance.iconPath')
    if ([string]::IsNullOrEmpty($current)) {
      $label.Text = '默认图标'
    } else {
      $label.Text = [System.IO.Path]::GetFileName($current)
    }
  } catch { }
}

# 从窗体当前状态读出一份**完整**配置（含未暴露字段 + 图标意图）
function Get-SettingsFromForm {
  param($Form)

  if ($null -eq $Form) { return New-SettingsDefaultConfig }

  $state = $Form.Tag
  $baseConfig = $null
  if ($state -is [System.Collections.IDictionary]) { $baseConfig = $state['Base'] }

  $config = ConvertTo-SettingsOrdered $baseConfig
  if ($null -eq $config) { $config = New-SettingsDefaultConfig }

  foreach ($control in (Get-SettingsFieldControls $Form)) {
    $tag = $control.Tag
    $path = [string](Get-SettingsTagValue $tag 'Path')
    if ([string]::IsNullOrEmpty($path)) { continue }

    $kind = [string](Get-SettingsTagValue $tag 'Kind')
    $value = Get-SettingsControlValue $control
    # 枚举没选中（配置里是非法值）→ 保留原值，交给 Test-SettingsConfig 报可读错误
    if ($kind -eq 'enum' -and $null -eq $value) { continue }
    if ($kind -eq 'enumBool' -and $null -eq $value) { continue }

    Set-SettingsPathValue -Root $config -Path $path -Value $value
  }

  # version 固定 1（缺字段才补，绝不改已存在的版本号语义）
  if ($config -is [System.Collections.IDictionary]) {
    if (-not $config.Contains('version') -or $null -eq $config['version']) { $config['version'] = 1 }
  }

  # 图标意图（tray.ps1 消费后可用 Remove-SettingsTransientKeys 剔除）
  $config['_iconAction'] = Get-SettingsTagValue $state 'IconAction'
  $config['_iconPath'] = Get-SettingsTagValue $state 'IconPath'

  return $config
}

# 剔除 _iconAction / _iconPath（tray.ps1 把配置发给 Node 前调用）
function Remove-SettingsTransientKeys {
  param($Config)

  $clean = ConvertTo-SettingsOrdered $Config
  if (-not ($clean -is [System.Collections.IDictionary])) { return $clean }

  foreach ($key in @('_iconAction', '_iconPath')) {
    if ($clean.Contains($key)) { [void]$clean.Remove($key) }
  }
  return $clean
}

# =============================================================================
# 区域 6：窗体装配（New-SettingsForm / Show-SettingsWindow）
# =============================================================================

# 保存动作：读配置 → 本地预校验 → 通过才写入 $Form.Tag['Result'] 并置 DialogResult=OK。
# 返回 [bool]：$true = 已放行；$false = 被拦下（状态栏红字，用户的输入全部保留）。
# 单独抽成函数，是为了让自测能直接调用（不需要 Show、不需要消息循环）。
function Invoke-SettingsSave {
  param($Form)

  if ($null -eq $Form) { return $false }

  try {
    $config = Get-SettingsFromForm -Form $Form
    $details = @(Test-SettingsConfigDetailed -Config $config)
    if ($details.Count -gt 0) {
      $messages = @()
      foreach ($item in $details) { $messages += [string]$item['Message'] }
      Set-SettingsStatus -Form $Form -Text ('无法保存：' + ($messages -join '；')) -IsError
      # 校验失败必须让用户看得见：跳到出错的那个页签，再弹一次说明。
      $firstPath = [string]$details[0]['Path']
      [void](Focus-SettingsPath -Form $Form -Path $firstPath)
      try {
        [void][System.Windows.Forms.MessageBox]::Show(
          ($messages -join "`r`n`r`n"),
          '配置有误，未能保存',
          [System.Windows.Forms.MessageBoxButtons]::OK,
          [System.Windows.Forms.MessageBoxIcon]::Warning
        )
      } catch { }
      return $false
    }
    $Form.Tag['Result'] = $config
    Set-SettingsStatus -Form $Form -Text '校验通过，配置已就绪。'
    # 显式关闭模态窗体，避免仅设置 DialogResult 在部分 WinForms/PowerShell 组合下不退出。
    $Form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    try { $Form.Close() } catch { }
    return $true
  } catch {
    try { Set-SettingsStatus -Form $Form -Text ('保存失败：' + $_.Exception.Message) -IsError } catch { }
    return $false
  }
}

# 创建并返回设置窗体（不 Show）。调用方负责 Dispose()。
function New-SettingsForm {
  param([hashtable]$Config)

  $baseConfig = ConvertTo-SettingsOrdered $Config
  if ($null -eq $baseConfig) { $baseConfig = New-SettingsDefaultConfig }

  # 调用方可能把上次的 _iconAction/_iconPath 又传回来（tray.ps1 保存失败重开窗口时）：
  # 先剔除，避免「本次没动图标」却把上次的意图又带回去。
  if ($baseConfig -is [System.Collections.IDictionary]) {
    foreach ($transientKey in @('_iconAction', '_iconPath')) {
      if ($baseConfig.Contains($transientKey)) { [void]$baseConfig.Remove($transientKey) }
    }
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'fdn-autosync-tray · 配置'
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.ShowInTaskbar = $false
  $form.ClientSize = New-Object System.Drawing.Size(620, 560)
  $form.Padding = New-Object System.Windows.Forms.Padding(0)

  # 字体（连同下面的 DeviceDpi 变化一起随窗体 Dispose）
  $ownedFonts = New-Object System.Collections.ArrayList
  $uiFont = Get-SettingsUiFont -Size 9
  if ($null -ne $uiFont) {
    $form.Font = $uiFont
    [void]$ownedFonts.Add($uiFont)
  }
  $boldFont = $null
  try {
    $boldFont = New-Object System.Drawing.Font -ArgumentList @(
      $form.Font.FontFamily, [single]$form.Font.Size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point
    )
    [void]$ownedFonts.Add($boldFont)
  } catch {
    $boldFont = $null
  }

  $form.add_Disposed({
      param($sender, $eventArgs)
      try {
        foreach ($font in $ownedFonts) { try { if ($null -ne $font) { $font.Dispose() } } catch { } }
        $ownedFonts.Clear()
      } catch { }
    }.GetNewClosure())

  # 窗体状态（Base = 输入配置的深拷贝；Result = 保存后要交给 tray.ps1 的配置）
  $form.Tag = @{
    Base       = $baseConfig
    Result     = $null
    IconAction = $null
    IconPath   = $null
  }

  # --- 根布局：上 TabControl（填满） + 下状态栏/按钮（AutoSize） ---
  $root = New-Object System.Windows.Forms.TableLayoutPanel
  $root.Dock = 'Fill'
  $root.ColumnCount = 1
  $root.RowCount = 2
  $root.Padding = New-Object System.Windows.Forms.Padding(10, 10, 10, 8)
  [void]$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
  [void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
  [void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
  $form.Controls.Add($root)

  $tabs = New-Object System.Windows.Forms.TabControl
  $tabs.Dock = 'Fill'
  $tabs.Margin = New-Object System.Windows.Forms.Padding(0)
  $root.Controls.Add($tabs, 0, 0)
  $form.Tag['Tabs'] = $tabs

  # --- 顶层分页 + 嵌套分页 ---
  [void](Add-SettingsDeployPage -Tabs $tabs -Config $baseConfig -BoldFont $boldFont -Form $form)
  [void](Add-SettingsPreparePage -Tabs $tabs -Config $baseConfig -BoldFont $boldFont)
  [void](Add-SettingsNestedGroup -Tabs $tabs -Title '同步阶段' -Config $baseConfig -BoldFont $boldFont -Builder {
    param($childTabs, $cfg, $font)
    [void](Add-SettingsPullPage -Tabs $childTabs -Config $cfg -BoldFont $font)
    [void](Add-SettingsSyncPage -Tabs $childTabs -Config $cfg -BoldFont $font)
    [void](Add-SettingsCommitPage -Tabs $childTabs -Config $cfg -BoldFont $font)
    [void](Add-SettingsPushPage -Tabs $childTabs -Config $cfg -BoldFont $font)
    [void](Add-SettingsFinishPage -Tabs $childTabs -Config $cfg -BoldFont $font)
  })
  [void](Add-SettingsNotifyPage -Tabs $tabs -Config $baseConfig -BoldFont $boldFont)
  [void](Add-SettingsNestedGroup -Tabs $tabs -Title '高级' -Config $baseConfig -BoldFont $boldFont -Builder {
    param($childTabs, $cfg, $font)
    [void](Add-SettingsSchedulePage -Tabs $childTabs -Config $cfg -BoldFont $font)
    [void](Add-SettingsRuntimePage -Tabs $childTabs -Config $cfg -BoldFont $font)
    [void](Add-SettingsLoggingPage -Tabs $childTabs -Config $cfg -BoldFont $font)
    [void](Add-SettingsGithubPage -Tabs $childTabs -Config $cfg -BoldFont $font)
  })

  # --- 底部：状态栏 + 「保存」「取消」 ---
  $bottom = New-Object System.Windows.Forms.TableLayoutPanel
  $bottom.Dock = 'Fill'
  $bottom.AutoSize = $true
  $bottom.AutoSizeMode = 'GrowAndShrink'
  $bottom.ColumnCount = 1
  $bottom.RowCount = 2
  $bottom.Margin = New-Object System.Windows.Forms.Padding(0)
  [void]$bottom.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
  [void]$bottom.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
  [void]$bottom.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
  $root.Controls.Add($bottom, 0, 1)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = '密码类字段保存时原值回填；点「显示」可临时查看明文。'
  $status.AutoSize = $false
  $status.Height = 20
  $status.Dock = 'Fill'
  $status.TextAlign = 'MiddleLeft'
  $status.ForeColor = [System.Drawing.Color]::DimGray
  $status.Margin = New-Object System.Windows.Forms.Padding(0, 6, 0, 4)
  $bottom.Controls.Add($status, 0, 0)
  $form.Tag['StatusLabel'] = $status

  $buttonBar = New-Object System.Windows.Forms.FlowLayoutPanel
  $buttonBar.Dock = 'Fill'
  $buttonBar.AutoSize = $true
  $buttonBar.AutoSizeMode = 'GrowAndShrink'
  $buttonBar.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
  $buttonBar.WrapContents = $false
  $buttonBar.Margin = New-Object System.Windows.Forms.Padding(0)
  $bottom.Controls.Add($buttonBar, 0, 1)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'
  $btnCancel.Size = New-Object System.Drawing.Size(88, 28)
  $btnCancel.Margin = New-Object System.Windows.Forms.Padding(6, 0, 0, 0)
  $btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  try { $btnCancel.UseVisualStyleBackColor = $true } catch { }
  $buttonBar.Controls.Add($btnCancel)

  $btnSave = New-Object System.Windows.Forms.Button
  $btnSave.Text = '保存'
  $btnSave.Size = New-Object System.Drawing.Size(88, 28)
  $btnSave.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 0)
  try { $btnSave.UseVisualStyleBackColor = $true } catch { }
  $buttonBar.Controls.Add($btnSave)

  $form.AcceptButton = $btnSave
  $form.CancelButton = $btnCancel
  $form.Tag['BtnSave'] = $btnSave
  $form.Tag['BtnCancel'] = $btnCancel

  # --- 状态联动（先挂监听，再求值一次） ---
  Initialize-SettingsEnableDependencies -Form $form
  Update-SettingsEnableStates -Form $form
  # --- 选项卡切换后强制重绘，避免嵌套页留下上一页的残影 ---
  $repaint = {
    param($sender, $eventArgs)
    try {
      if ($null -ne $sender) { $sender.PerformLayout() }
    } catch { }
  }
  $tabs.add_SelectedIndexChanged($repaint)
  $form.add_Shown({
    param($sender, $eventArgs)
    try { Update-SettingsEnableStates -Form $sender } catch { }
    try {
      foreach ($page in $sender.Tag['Tabs'].TabPages) {
        foreach ($child in $page.Controls) { if ($child -is [System.Windows.Forms.TabControl]) { $child.add_SelectedIndexChanged($repaint) } }
      }
    } catch { }
  }.GetNewClosure())

  # --- 保存：本地校验 → 通过才放行（非法时红字 + 不关闭） ---
  $btnSave.add_Click({
      param($sender, $eventArgs)
      try {
        $saved = Invoke-SettingsSave -Form $form
        if ($saved) { $form.DialogResult = [System.Windows.Forms.DialogResult]::OK }
      } catch {
        try {
          Set-SettingsStatus -Form $form -Text ('保存失败：' + $_.Exception.Message) -IsError
        } catch { }
      }
    }.GetNewClosure())

  return $form
}

# 模态显示设置窗口：取消 / 关闭 → $null；保存 → 完整新配置（含 _iconAction/_iconPath）
function Show-SettingsWindow {
  param([hashtable]$Config)

  $form = $null
  $result = $null

  try {
    $form = New-SettingsForm -Config $Config
    $dialogResult = $form.ShowDialog()
    if ($dialogResult -eq [System.Windows.Forms.DialogResult]::OK) {
      $state = $form.Tag
      if ($state -is [System.Collections.IDictionary]) { $result = $state['Result'] }
    }
  } catch {
    # 任何异常都按「取消」处理：绝不把半成品配置交给 tray.ps1
    $result = $null
  } finally {
    if ($null -ne $form) { try { $form.Dispose() } catch { } }
  }

  return $result
}
