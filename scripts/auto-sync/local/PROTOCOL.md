# `fdn-autosync-tray` 内部契约（托盘宿主 ⇄ 本地业务）

本文件是 `scripts/auto-sync/local/` 下本地托盘版的**实现契约**：进程模型、JSON Lines 通信协议、
`config.json` / `state.json` 结构、菜单与窗口内容、图标合成与日志约定。

设计目标见 `.tmp/fdn-autosync-tray-design.md`；本文件只描述**已确定的实现约定**，两者冲突时以设计文档为准，
但具体字段名/消息名以本文件为准（设计文档允许统一命名）。

---

## 1. 进程模型

```text
start.vbs (wscript, 无窗口)
  └─ powershell.exe -File tray.ps1          ← Windows 托盘宿主（UI + Windows 集成）
       └─ node main.mjs                     ← 本地业务（唯一调度器 + 唯一状态机）
            └─ node ../../sync.mjs          ← 共享同步业务（GHA 同一份实现，按轮启动）
```

- **PowerShell 端不做业务**：不读 Git、不跑同步、不读写 `config.json` / `state.json`，只做窗口、菜单、
  Toast、打开文件夹、开机自启快捷方式、图标合成（GDI+）。
- **Node 端不做 UI**：只发命令、发状态，并把 Windows 侧动作委托给 PowerShell（`action` 消息）。
- 两者通过**标准输入/输出 JSON Lines** 通信（每行一个 JSON 对象，UTF-8）。
  - Node 的 `stdout` **只**输出协议消息；诊断信息一律写 `stderr`（宿主把 stderr 落到 `tray.log`）。
  - PowerShell 端每条消息独立解析，非法 JSON 只记日志、不得崩溃。
- 退出约定：宿主关闭 → Node 的 stdin 收到 EOF → Node 收尾退出。Node 退出 → 宿主退出。
- 单实例由 Node 负责（`local/state/instance.lock` + PID 存活检查）。Node 判定已有实例时
  **立即 exit 0 且不输出任何消息**；宿主读不到首条 `state` 就静默退出。

### 1.1 编码硬约束

- 所有 `.ps1` 必须是 **UTF-8 with BOM**（Windows PowerShell 5.1 读取无 BOM 的 UTF-8 会按 ANSI 解码，
  中文会乱码/解析失败）。`start.vbs` 必须 **纯 ASCII**（WSH 按 ANSI 读）。
- 宿主启动 Node 前：
  - `[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)`
  - `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`
  - `$p.StartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)`
- Node 端所有协议输出用 ASCII 安全模式：`JSON.stringify` 后把非 ASCII 字符转成 `\uXXXX` 转义
  （`toProtocolLine()`），彻底避免方向性的编码歧义。
- 宿主 → Node 方向若实测有乱码风险，同样在写出前把非 ASCII 转成 `\uXXXX`（见 §3.4 的 `ConvertTo-ProtocolJson`）。

---

## 2. 目录结构

```text
scripts/auto-sync/
├── probe.mjs                 # GHA 入口（本次不动）
├── sync.mjs                  # GHA 入口（本次不动；支持 LOCAL_SYNC_* 环境变量）
├── plan.mjs / lib.mjs / h1api.mjs / logger.mjs / session.mjs / check-session.mjs
└── local/
    ├── start.vbs             # 隐藏控制台启动入口（ASCII）
    ├── tray.ps1              # 宿主：NotifyIcon、菜单、详情窗口、Toast、自启动、图标合成调度
    ├── settings.ps1          # WinForms 设置窗口（由 tray.ps1 dot-source）
    ├── icon-compose.ps1      # GDI+ 图标合成（由 tray-icon.mjs 以子进程调用）
    ├── main.mjs              # 本地业务入口：装配、命令分发、锁定权限、状态持久化
    ├── config.json           # 用户配置（本机数据，.gitignore）
    ├── config.json.bak-*     # 配置损坏时的备份（.gitignore）
    ├── state.json            # 运行状态（本机数据，.gitignore）
    ├── state/                # instance.lock 等运行期文件（.gitignore）
    ├── assets/
    │   ├── default.ico       # 默认底图（入库）
    │   └── user-icon.*       # 用户自定义底图（.gitignore）
    ├── cache/icons/          # 合成后的图标缓存（.gitignore）
    ├── modules/
    │   ├── config.mjs        # 配置默认值、校验、迁移、原子保存
    │   ├── state.mjs         # state.json 读写、默认值、统计/通知计数
    │   ├── log.mjs           # 日志（按日期分目录、脱敏、保留期清理）
    │   ├── git.mjs           # Git 封装（spawn + shell:false + 超时）
    │   ├── wifi.mjs          # 网络检查 / WiFi 连接、断开、忘记
    │   ├── sync-runner.mjs   # 六阶段编排 → 结构化结果
    │   ├── scheduler.mjs     # 调度、暂停/恢复、立即同步、互斥、补跑
    │   ├── notification.mjs  # 标准/累积通知
    │   └── tray-icon.mjs     # 图标缓存键、GDI+ 调用、ICO 打包
    ├── test/                 # node --test 自动化测试
    └── logs/YYYY/MM/DD/{run,tray}.log
```

---

## 3. JSON Lines 协议

所有消息都是一行 JSON：`{"type":"...", ...}`。**字段名固定**，新增字段必须可选、缺省有兜底。

### 3.1 Node → 宿主

> 开发/自动化测试专用环境变量（正常运行不需要）：`FDN_LOCAL_DIR` 把「本机运行数据」
> （config/state/logs/cache/assets）重定向到别处；`FDN_REPO_ROOT` 把 Git/同步业务指向另一个仓库。
> 生产行为一律按脚本自身位置推导。

#### `state`（权威状态快照，任何变化都整条重发）

```json
{
  "type": "state",
  "data": {
    "locked": false,
    "paused": false,
    "running": true,
    "stage": "sync",
    "hasRun": true,
    "totalRuns": 12,
    "lastRun": {
      "status": "success",
      "finishedAt": "2026-11-26T12:00:18.000Z",
      "durationMs": 18000,
      "message": "同步完成"
    },
    "nextRunAt": "2026-11-26T12:10:18.000Z",
    "counts": { "success": 5, "up-to-date": 6, "failure": 1, "internal-error": 0 },
    "statusLines": [
      "自启动后已同步：12 次",
      "当前状态：同步中（Sync）",
      "上次同步：2026-11-26 20:30:18",
      "上次结果：成功 · 用时 18 秒",
      "下次同步：本轮结束后安排"
    ],
    "tooltip": "fdn-autosync-tray · 同步中 · Sync"
  }
}
```

- `hasRun=false` 时 `lastRun=null`，`statusLines` 只含「尚未同步」等诚实文本（不得虚构时间/结果）。
- `statusLines` 由 Node 排版好（本地时区、中文），宿主**原样显示**，不自行拼装。
- `tooltip` 宿主按需截断到 63 字符。
- 状态对象**绝不包含**任何凭据、Cookie、Token、密码。

#### `icon`

```json
{"type":"icon","path":"F:\\...\\local\\cache\\icons\\ab12cd34.ico","tooltip":"fdn-autosync-tray · 空闲"}
```

宿主：`New-Object System.Drawing.Icon($path)`，替换 `$notifyIcon.Icon` 后 `Dispose()` 旧对象；
加载失败则保留上一张有效图标并写 `tray.log`。启动早期（首条 `icon` 之前）宿主先临时用 `assets/default.ico`。

#### `notify`（Toast）

```json
{"type":"notify","id":"n-3","title":"自动同步成功","text":"同步了 2 个资源，共 3 个版本。"}
```

宿主显示 Windows Toast（不可用时退化为 NotifyIcon 气泡），然后回 `ack`：
`{"type":"ack","id":"n-3","ok":true,"error":null}`。Node 只在 `ok=true` 时清零累积计数。

#### `ack`（命令/动作回执）

```json
{"type":"ack","id":"c-7","ok":true,"message":"","error":null,"data":{}}
```

#### `action`（Node 请宿主做 Windows 侧动作）

```json
{"type":"action","id":"a-1","name":"open-path","path":"F:\\...\\logs"}
{"type":"action","id":"a-2","name":"restart"}
{"type":"action","id":"a-3","name":"exit"}
{"type":"action","id":"a-4","name":"show-detail","detail":{...}}
```

- `open-path`：`explorer.exe`/默认程序打开给定**已存在**路径（文件夹或文件）。
- `restart`：宿主启动新实例（新 `powershell tray.ps1` + Node 子进程）后自身退出；Node 已在此之前收尾。
- `exit`：宿主销毁 NotifyIcon 并退出进程。
- `show-detail`：只用一次（右键菜单「查看详细状态」由宿主直接拿 `ack.data.detail` 显示，不用此动作）。
  该动作保留但宿主可选择忽略（协议向后兼容用）。
- 宿主对每个 `action` 都回 `ack`。

### 3.2 宿主 → Node

#### `command`

```json
{"type":"command","id":"c-1","name":"sync-now"}
{"type":"command","id":"c-2","name":"unlock","password":"..."}
{"type":"command","id":"c-3","name":"open","target":"log-folder"}
{"type":"command","id":"c-4","name":"save-config","config":{ ... }}
{"type":"command","id":"c-5","name":"lock","password":""}
```

#### `event`

```json
{"type":"event","name":"wake"}
{"type":"event","name":"autostart-changed","enabled":true,"ok":true,"error":null}
{"type":"event","name":"autostart-status","exists":false}
```

- `wake`：系统从休眠恢复（宿主 `PowerModeChanged`）→ Node 重新核对计划时间，最多补跑一轮。
- `autostart-changed`：宿主已完成快捷方式创建/删除，Node 据此同步 `config.startup.enabled`。
- `autostart-status`：宿主启动时探测快捷方式是否存在，Node 据此把配置与真实状态对齐
  （程序目录移动后快捷方式失效 → 配置置 false，用户可在设置窗口「修复自启动」）。

### 3.3 命令表与权限（Node 端**再次**校验，不只依赖宿主隐藏菜单项）

| 命令 | 说明 | 未锁定 | 锁定 |
|---|---|---|:--:|
| `get-status` | 立即回一条 `state` | ✅ | ✅ |
| `get-detail` | `ack.data.detail`（只读详情对象，无凭据） | ✅ | ✅ |
| `sync-now` | 立即同步 | ✅ | ✅ |
| `sync-cancel` | 请求取消当前同步（需宿主二次确认） | ✅ | ✅ |
| `pause` / `resume` | 暂停/恢复自动同步 | ✅ | ❌ |
| `lock` | 加锁（`password` 非空且当前无密码时顺带设密码） | ✅ | 不适用 |
| `unlock` | 解锁（校验 `password`） | 不适用 | ✅ |
| `open` | `target` ∈ `log-folder` `latest-log` `project-dir` `data-dir` `sync-dir` `config-file` | ✅ | 仅 `log-folder` `latest-log` |
| `get-config` | 回完整配置（**含凭据**） | ✅ | ❌ |
| `save-config` | 保存配置（整体替换，含校验/迁移） | ✅ | ❌ |
| `restart` | 等待当前同步结束后重启托盘 | ✅ | ❌ |
| `exit` | 等待当前同步结束后退出 | ✅ | ❌ |
| `set-icon` | `data.path`：把用户图片复制进 `assets/` 并生效 | ✅ | ❌ |
| `reset-icon` | 恢复默认底图 | ✅ | ❌ |
| `repair-autostart` | 让宿主重建开机自启快捷方式 | ✅ | ❌ |

被拒绝时：`{"type":"ack","id":"...","ok":false,"error":"locked"}`（或 `"unknown-command"`）。
**锁定拒绝属于正常控制结果**，写 `INFO` 日志，不当作内部错误。

### 3.4 宿主侧 JSON 的确定性写法

Windows PowerShell 5.1：`ConvertFrom-Json` 得到 `PSCustomObject`，嵌套字段需递归转
`[hashtable]`/`[ordered]` 才能改（见 `ConvertTo-OrderedHashtable` 辅助函数）。写回 Node 时用
`ConvertTo-Json -Depth 12 -Compress`，再把非 ASCII 转义：

```powershell
function ConvertTo-ProtocolJson($obj) {
  $json = $obj | ConvertTo-Json -Depth 12 -Compress
  return [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}
```

---

## 4. 配置 `config.json`（schema v1）

```json
{
  "version": 1,
  "runtime": { "nodePath": "", "syncTimeoutMinutes": 120,
               "pullTimeoutMinutes": 10, "pushTimeoutMinutes": 5 },
  "startup": { "enabled": false, "runOnStart": true },
  "scheduler": { "intervalMinutes": 10, "catchUpOnWake": true },
  "wifi": {
    "enabled": false, "ssid": "", "password": "",
    "useSavedFirst": true, "alwaysConnect": false, "skipOnFailure": true,
    "disconnectAfter": false, "disconnectEvenOnFailure": true, "forgetOnDisconnect": false
  },
  "stages": {
    "pull":   { "enabled": true, "strategy": "rebase" },
    "sync":   { "enabled": true },
    "commit": { "enabled": true, "identityMode": "gha", "userName": "", "userEmail": "" },
    "push":   { "enabled": true }
  },
  "credentials": { "H1111_SESSION": "", "H1111_USER": "", "H1111_PASSWORD": "",
                   "GH_TOKEN": "", "PUSH_TOKEN": "" },
  "notifications": {
    "mode": "standard",
    "standard": { "success": true, "up-to-date": false, "failure": true, "internal-error": true },
    "cumulative": { "everyRuns": 7, "internalErrorMode": "always" }
  },
  "appearance": { "iconPath": null },
  "logging": { "retentionDays": 90 },
  "security": { "lockPassword": "" }
}
```

规则：

- `scheduler.intervalMinutes`：**本轮结束后**等待的分钟数（`nextRunAt = finishedAt + interval`），
  允许 1–1440 的整数。
- `stages.commit.identityMode`：`gha`（github-actions[bot]，与 GHA 一致）/ `default`（本机 git 配置）/
  `custom`（`userName` + `userEmail`，只作用于本仓库提交，不用 `--global`）。
- `credentials` 允许明文（用户明确要求可迁移）；**不得**写入日志、状态、Toast、命令行参数或 Git URL。
  Git 鉴权用 `GIT_CONFIG_*` 注入 `http.extraheader`，只对子进程生效。
- `appearance.iconPath` 指向 `local/assets/` 内的副本（不是用户原始路径），存**相对 `local/` 的路径**
  （如 `assets/user-icon.png`），这样整个程序目录搬走后仍然有效。
- `security.lockPassword` 为空 = 未设密码（此时禁止锁定，宿主提示先设密码）。
- 缺少字段一律补默认值；类型/枚举非法 → 校验失败并给出可读错误，**不静默清空**。

### 4.1 旧版配置迁移（旧 `config.json` → v1）

| 旧字段 | 新位置 |
|---|---|
| `intervalMinutes` | `scheduler.intervalMinutes` |
| `runOnStart` | `startup.runOnStart` |
| `session` | `credentials.H1111_SESSION` |
| `githubToken` | `credentials.GH_TOKEN` |
| `gitToken` | `credentials.PUSH_TOKEN` |
| `nodePath` | `runtime.nodePath` |
| `syncTimeoutMinutes` | `runtime.syncTimeoutMinutes` |
| `pullTimeoutMinutes` | `runtime.pullTimeoutMinutes` |
| `pullBeforeSync` + `stepPull` | `stages.pull.enabled`（两者都开才算开） |
| `pullStrategy` | `stages.pull.strategy`（`ff-only`→`ff-only`，其他→`rebase`） |
| `stepSync` | `stages.sync.enabled` |
| `stepCommit` | `stages.commit.enabled` |
| `gitIdentityMode` `script`/`git`/`custom` | `gha` / `default` / `custom` |
| `gitUserName`/`gitUserEmail` | `stages.commit.userName` / `userEmail` |
| `stepPush` | `stages.push.enabled` |
| `retryPush` | 丢弃（Push 失败恢复是强制行为，无开关） |
| `iconPath` | 复制进 `local/assets/` 后写入 `appearance.iconPath` |
| `notifyMode` `always`/`failure`/`never`/`accumulate` + `notifyEveryRuns` | `notifications.mode` = `standard`（always→四项全开；failure→仅 failure/internal-error）/ 同为 standard（全关）/ `cumulative`（`everyRuns`） |
| `logRetentionDays` | `logging.retentionDays` |
| `lockPassword` / `locked`（旧版存在 config 里） | `security.lockPassword` / `state.json.locked` |

迁移时先备份 `config.json.bak-<时间戳>`，迁移成功才覆盖；迁移失败保留原文件并报错。

---

## 5. 状态 `state.json`（schema v1）

```json
{
  "version": 1,
  "locked": false,
  "paused": false,
  "totalRuns": 12,
  "lastRun": {
    "status": "success",
    "startedAt": "2026-11-26T12:00:00.000Z",
    "finishedAt": "2026-11-26T12:00:18.000Z",
    "durationMs": 18000,
    "message": "同步完成",
    "stats": { "resources": 2, "versions": 3 },
    "error": null
  },
  "nextRunAt": "2026-11-26T12:10:18.000Z",
  "stats": { "success": 5, "up-to-date": 6, "failure": 1, "internal-error": 0 },
  "notification": { "pendingRuns": 0, "success": 0, "up-to-date": 0, "failure": 0, "internal-error": 0 }
}
```

- 原子保存（临时文件 + `rename`），损坏时备份并恢复默认值 + 记 `ERROR` 日志。
- `totalRuns` 每轮同步开始（或结束，二者选一，**全局只在一处**）加一。
- 锁定状态持久化，重启后继续锁定。
- 详细状态窗口与锁定菜单只读状态，不改状态文件。

---

## 6. 托盘菜单（宿主生成）

### 6.1 未锁定

```text
fdn-autosync-tray
─────────────
自启动后已同步：12 次
上次同步：2026-11-26 20:30:18
上次结果：成功 · 用时 18 秒
下次同步：2026-11-26 20:40:18
─────────────
立即同步            （running 时 Disabled，文本 →「同步中…」）
暂停自动同步 / 恢复自动同步
锁定
─────────────
浏览 >
  项目目录
  下载数据目录
  自动同步目录
  最新日志
  日志文件夹
─────────────
配置文件
日志文件夹
配置…
开机自启动            （勾选项，状态 = 快捷方式是否存在）
修复自启动            （仅当 配置里 enabled 但快捷方式不在时显示）
重启
退出
```

- 状态区为只读条目（Disabled），文本直接取 `state.statusLines`（Node 已排版好，含「自启动后已同步」「当前状态」「会话剩余天数/已失效提示」「上次同步」「上次结果」「下次同步」）。
- `暂停自动同步` 在 `paused=true` 时改为 `恢复自动同步`。
- 菜单在每次打开（`ContextMenuStrip.Opening`）时按当前 `state` 重建，避免缓存陈旧状态。
- 未锁定菜单**不显示** `查看详细状态`？——显示，也未锁定允许（设计只要求锁定时必须能看，未锁定时一并提供）。
  最终条目顺序以设计文档 §5.1 为准，额外提供 `查看详细状态`。

### 6.2 锁定

```text
fdn-autosync-tray（已锁定）
─────────────
自启动后已同步：12 次
当前状态：空闲 / 同步中（Sync） / 已暂停
上次同步：2026-11-26 20:30:18
上次结果：成功 · 用时 18 秒
下次同步：2026-11-26 20:40:18
─────────────
查看详细状态
─────────────
立即同步
解锁
浏览日志文件夹
```

- 锁定菜单只允许：状态摘要、详细状态（只读）、立即同步、解锁、打开日志文件夹。
- 锁定**不隐藏状态**、不影响同步调度、不影响图标角标。
- 未设 `security.lockPassword` 时不允许锁定：宿主先让用户设置密码，再随 `lock` 命令一起发送。

### 6.3 详细状态窗口（只读）

窗口标题 `fdn-autosync-tray · 详细状态`，内容为多行只读文本（`TextBox` ReadOnly + 垂直滚动），
来自 `get-detail` 的 `ack.data.detail`：

```json
{
  "statusText": "同步中（Sync）",
  "stageText": "Sync",
  "totalRuns": 12,
  "lastRun": {
    "startText": "2026-11-26 20:00:00",
    "endText": "2026-11-26 20:00:18",
    "durationText": "18 秒",
    "statusText": "成功",
    "message": "同步了 2 个资源，共 3 个版本",
    "errorText": ""
  },
  "counts": { "success": 5, "up-to-date": 6, "failure": 1, "internal-error": 0 },
  "nextRunText": "2026-11-26 20:10:18",
  "locked": true
}
```

窗口只有「关闭」按钮，无任何控制项；不含凭据。

---

## 7. 设置窗口（`settings.ps1`，WinForms）

- 模态窗口，宽约 620、高约 560，`TabControl` 分页，底部「保存」「取消」。
- 入口函数：`function Show-SettingsWindow($configHashtable) → [hashtable] | $null`
  （`$null` = 取消；返回**完整**新配置 `[ordered]`/hashtable，由 `tray.ps1` 发 `save-config`）。
- 分页与字段（与配置结构一一对应）：

| 页 | 字段 |
|---|---|
| 部署 | 开机自启动（勾选，保存时由宿主改快捷方式）、托盘外观（选择图片… / 重置默认图标）、启动后立即同步一次 |
| 准备阶段 | WiFi 管理总开关、SSID、密码、优先使用 Windows 已保存密码、不检查网络总是尝试连接、连接失败时跳过整次同步 |
| Pull | 跳过 Pull 阶段（`enabled=false`）、策略 rebase / ff-only |
| Sync | 跳过 Sync 阶段、`H1111_SESSION`、`H1111_USER`、`H1111_PASSWORD` |
| Commit | 跳过 Commit 阶段、Git 身份（GHA / 默认 / 自定义）、自定义用户名、邮箱 |
| Push | 跳过 Push 阶段、`PUSH_TOKEN` |
| 结束阶段 | 同步后断开指定 WiFi、失败时也断开、断开后忘记该 WiFi |
| 通知 | 标准模式 / 累积模式、标准模式四项勾选、累积次数、内部错误始终单独弹出 |
| 其他 | 同步间隔（分钟）、日志保留天数（0=永久）、锁定密码、`GH_TOKEN`、Node 路径、超时项 |

- 密码类输入框用 `PasswordChar`；保存时**原值回填**（不在日志/界面提示里回显明文）。
- 选择图片/重置图标按钮触发 `set-icon` / `reset-icon` 命令（宿主转发），不直接改配置。
- 保存后若 Node 返回校验错误：窗口保持打开并在底部状态栏显示错误，不丢用户输入。

---

## 8. 图标合成（Node 决策 + GDI+ 渲染）

### 8.1 角标优先级

1. `running=true` → 白色右三角；
2. `paused=true` → 白色 `||`；
3. 最近结果 `success` → 绿色勾；`up-to-date` → 绿色实心圆；`failure` / `internal-error` → 红色叉；
4. 无历史 → 无角标。

锁定不改变角标（只在菜单标题体现）。

### 8.2 缓存与渲染

- 缓存键 = `sha256(底图字节) : badge : sizes`（`sizes` 固定 `16,20,24,32,40,48,64`）。
- 缓存路径：`local/cache/icons/<hash 前 16 位>.ico`；命中直接复用，不重复合成。
- 未命中：`tray-icon.mjs` 调用
  `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File icon-compose.ps1 -Base <底图> -Badge <badge> -OutDir <临时目录> -OutIco <缓存临时文件> -Sizes 16,20,24,32,40,48,64`
  （`-Sizes` 是**一个逗号分隔字符串**，不是数组参数）。
  `icon-compose.ps1` 负责：
  1. 每个尺寸输出 `icon-<size>.png`（GDI+ 抗锯齿 + **沿角标实际轮廓**挖透明，不是方块）；
  2. 直接拼一个**多尺寸 ICO** 写到 `-OutIco`，条目用**传统 32bpp DIB**（不是 PNG 帧）——
     因为 .NET Framework 4.8 的 `System.Drawing.Icon` 读不了 PNG 帧 ICO；这样宿主可以直接
     `New-Object System.Drawing.Icon($path)`，不需要任何自研解码器；
  3. stdout 只输出一行 `{"sizes":[...]}`，失败 exit 1 + stderr 原因。
- Node 收到 `-OutIco` 文件后原子改名进缓存；只有 `.ico` 缺失时才用逐尺寸 PNG 自行打包兜底。
- 底图来源：`appearance.iconPath`（存在则用，损坏则回退默认并起 Toast/日志警告）或 `assets/default.ico`。
  底图支持 PNG / ICO / BMP（GDI+ 解码）。
- 输出尺寸 ≤ 底图尺寸时正常缩放；DPI 由多尺寸 ICO 覆盖。

---

## 9. 日志

- 目录：`local/logs/YYYY/MM/DD/run.log`（Node 业务日志，追加写入当日文件）、
  `local/logs/YYYY/MM/DD/tray.log`（宿主自身日志 + Node `stderr`）。
- 行格式：`[2026-11-26 20:00:00.123] [INFO] [Scheduler] 开始同步`。
- 等级 `DEBUG|INFO|WARN|ERROR`；保留期 `logging.retentionDays`，0 = 永久，只清理本程序日志目录。
- 脱敏：写入前把 `credentials.*` 值、`password`、`token`、`cookie` 等敏感串替换为 `***`。
- 子进程 `sync.mjs` 的 stdout 逐行写进当日 `run.log`（带 `[sync]` 前缀），不混入协议 stdout。
- 日志写入失败不得让同步业务崩溃：捕获后写 `stderr`。

---

## 10. 结构化同步结果

`sync-runner.mjs` 返回：

```js
{
  status: 'success' | 'up-to-date' | 'failure' | 'internal-error',
  startedAt: ISO, finishedAt: ISO, durationMs: 18000,
  message: '同步完成',
  stats: { resources: 2, versions: 3 } | null,
  error: { stage: 'push', code: 'GIT_PUSH_FAILED', message: '远端拒绝了推送' } | null,
  stages: [{ name: 'prepare', status: 'skipped'|'ok'|'failed', durationMs, message }],
  committed: true, pushed: true, aheadAtEnd: 0
}
```

- `up-to-date`：sync 业务报 `allLatest=true` 且无失败项。
- `failure`：网络/远端/网盘/Git 等普通业务失败。
- `internal-error`：配置损坏、模块加载失败、状态无法保存、未捕异常、关键依赖（node/git）不可用。
- 分类不看日志文本，只看退出码 + `LOCAL_SYNC_RESULT_FILE` 结构化字段。
- 取消（`sync-cancel`）→ 记为 `failure`，`error.code = 'CANCELLED'`，绝不记为成功。

---

## 11. 兼容性红线（本次重构不变）

- `.github/workflows/auto-sync.yml` 不改；`probe.mjs`、`sync.mjs` 的 CLI 入口、`GITHUB_OUTPUT`、
  Summary、注解、退出码、`::` 命令、`GHA` Secrets 名称（`H1111_SESSION` / `H1111_USER` /
  `H1111_PASSWORD` / `GITHUB_TOKEN`）全部保持原样。
- GHA 不读 `local/` 下任何文件；托盘端不要求 GHA 启动 PowerShell 或安装桌面依赖。
- 共享业务仍是 `sync.mjs`（本地以子进程方式调用，带
  `LOCAL_SYNC_STEP_COMMIT` / `LOCAL_SYNC_STEP_PUSH` / `LOCAL_SYNC_RESULT_FILE` 环境变量）。