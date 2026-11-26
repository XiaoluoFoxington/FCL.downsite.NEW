# 线路1 自动同步（auto-sync）

把「GitHub Releases → huang1111 网盘离线下载 → 直链 → 站端 `data/down` JSON → 提交」全链路自动化，默认跑在 GitHub Actions 上（也可在本机 Windows 上以托盘常驻运行，见下文「本地版」）。站端前端无需改动（下载节点按 `nextUrl` 惰性加载，对目录结构透明）。

> 详细设计见 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md)，API 实测依据见 [`docs/huang1111-api-notes.md`](../../docs/huang1111-api-notes.md)。
> 本目录内 `.mjs` 为 Node 原生 ESM（无需 npm install）。各文件的职责以其文件头注释为准。

## 职责速览

- `sync.mjs`：主流程（检测 → 离线下载 → 直链 → 写 JSON → 分软件提交 → push）
- `probe.mjs`：预探测（只读，无候选时跳过 sync job）
- `check-session.mjs`：会话 cookie 巡检（只读，临期/失效时在日志与运行页告警）
- `plan.mjs`：候选版本探测（**probe 与 sync 共用同一份实现**，避免两边口径漂移）
- `logger.mjs`：**唯一日志实现**（树形缩进 / 提交正文收集 / GHA 注解 / 汇总页）
- `lib.mjs`：纯函数与共享常量（**不持有任何日志状态**）
- `session.mjs`：会话 cookie 解析与生命周期判定（签发/到期时间、临期档位；供上面两者共用）
- `h1api.mjs`：huang1111 API 封装（含会话登录、验证链路与 PoW 求解）
- `config.mjs`：环境变量与常量（**改配置看这里**）
- `softwares.json`：软件映射表（**有哪些软件看这里**）
- `tools/refresh-session.mjs`：**手动工具**（非 GHA 运行）——从浏览器提取会话 cookie，供更新 secret
- `local/`：**Windows 托盘版 `fdn-autosync-tray`**（`start.vbs` → `tray.ps1` 宿主 → `main.mjs` 本地业务 → `sync.mjs` 共享业务），只是外壳，不重复实现同步逻辑；协议与配置结构见 [`local/PROTOCOL.md`](local/PROTOCOL.md)

> ⚠️ 2026-10 日志全量重构：旧的可变全局 `ctx`（`ctx.log` / `ctx.group` / `ctx.sum` …）**已整体删除**。
> 需要打日志的函数改为**接收作用域或回调**，再也没有「猴补丁替换全局 log」这种写法。
> 详见下节「日志」。

## 触发

- **定时**：由工作流的 `schedule` 决定（cron 按 UTC 编写，时间点见 `.github/workflows/auto-sync.yml`）
- **手动**：GitHub 仓库 Actions 页 → `线路1自动同步` → `Run workflow`（可临时改时间/直接验证）

## 凭据（Secrets）

仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 必需性 | 说明 |
|---|---|---|
| `H1111_SESSION` | **必需** | huang1111 **会话 cookie 值**（不是账号密码）。取法见下节 |
| `H1111_USER` | 可选 | 登录账号（**回退**用，见下） |
| `H1111_PASSWORD` | 可选 | 登录密码（**回退**用） |

> `OCR_PKG_NAME` / `OCR_CLS_NAME` 已废弃（站点图形验证码通路下线），可从仓库删除。

凭据只存 GitHub，脚本只从环境变量读取，仓库内永不落盘。

### 会话 cookie：为什么用它、怎么取

**为什么不能用账号密码了**：站点自 **2026-10-07** 起把**登录**改成了**交互式验证** ——
要在图形里点选字符（`kind=click`）、输入字符（`kind=text`）或拖滑块（`kind=slide`），人眼专用，脚本无法完成。
（实测登录时 `required.interactive=1` 且**不下发 PoW**，只有这一道坎。）

**替代办法**：在浏览器里**人工登录一次**，把拿到的会话 cookie 存进 `H1111_SESSION`，脚本复用它。

实测依据（2026-10-07 全部本地验证）：

| 性质 | 实测结果 |
|---|---|
| 有效期 | `Max-Age=5184000` = **60 天**，且**不滑动续期**（绝对过期） |
| 是否绑定 UA | ❌ 不绑定（无 UA / curl / Linux Chrome 均可认证） |
| 是否绑定 IP | ❌ 不绑定（换代理出口后依然有效） |
| 取直链要不要交互式 | ❌ 不要（`direct_link` 的 `required.interactive=0`，仍只需 PoW） |
| 需要哪些 cookie | **只要 `cloudreve-session`**；`cloudreve_observer`（仅 1 天）由 41700 响应自动补发 |

**取新值的步骤**（回家时做一次）：

```powershell
# 1. 在 Firefox 里登录 https://pan.huang1111.cn （完成点选/输入/滑块验证）
#    ⚠ 确认页面右上角显示你的用户名，再往下做
# 2. 提取会话并复制到剪贴板（会自动验活，不是登录态就拒绝输出）
node scripts/auto-sync/tools/refresh-session.mjs
# 3. 粘贴到 GitHub → Settings → Secrets → H1111_SESSION
```

> ⚠️ **「cookie 很新」不等于「已登录」**：站点对**匿名访问**也会签发 `cloudreve-session`，
> 而且每次请求都换新的。所以别看时间戳，要看脚本的「验活：✅ 服务端确认已登录」那一行。
> 若脚本报「这份 cookie 是匿名的」，说明浏览器里其实没登录成功（或被退登了）。

> 60 天到期后同步会失败。`check-session.mjs` 每次运行（probe job 里）都会**固定输出剩余天数**：
> · 运行页顶部横幅：`::warning::线路1会话巡检：会话 cookie 剩余 X 天（到期 …｜状态）`
> · 汇总页（Summary）一张固定字段的表：剩余 / 到期时间 / 签发时间 / 状态 / 服务端验活 / cookie 指纹
>
> 已失效时注解升级为 `::error::` 并追加「怎么解决」。**不发 Issue**（只在日志与运行页体现）。

### 回退：账号密码登录

`H1111_USER` / `H1111_PASSWORD` 仍保留：当 `H1111_SESSION` 为空时会走密码登录。
但站点已启用交互式验证，**这条路目前必然失败**（错误信息会提示改用会话 cookie）。
保留它是为了站点将来改回密码登录时无需改代码。

## 本地手动运行（调试用）

```powershell
# 只跑预探测（不读凭据、不动网盘）
node scripts/auto-sync/probe.mjs

# 会话巡检（不登录、只读；打印剩余天数与告警）
$env:H1111_SESSION = '你的会话 cookie 值'
node scripts/auto-sync/check-session.mjs

# 完整同步（需要会话 cookie）
$env:H1111_SESSION = '你的会话 cookie 值'
node scripts/auto-sync/sync.mjs
```

可用的环境变量、默认值与重试常量统一在 [`config.mjs`](config.mjs) 中定义，以其为准。

### 本地 GitHub Token（可选，但强烈建议）

不配 token 时，GitHub API 走**匿名限额：60 次/小时**（按出口 IP 计）。
本脚本每个软件要拉一次 Release 列表，7 个软件一轮就是 7 次；
反复调试很容易把额度跑光，之后会看到：

```
GitHub 拉取失败（第 1/2 次）：GitHub API HTTP 403，重试…
❌ 探测失败：GitHub 拉取失败：GitHub API HTTP 403
```

**GHA 里不需要这个** —— 平台自动注入 `GITHUB_TOKEN`（5000 次/小时）。只有本地调试才要配。

#### 1. 生成 token

打开 <https://github.com/settings/tokens>，二选一：

| 类型 | 怎么建 | 权限 |
|---|---|---|
| **Fine-grained**（推荐） | Fine-grained tokens → Generate new token | **Public Repositories (read-only)** 即可，不选任何仓库 |
| **Classic** | Tokens (classic) → Generate new token (classic) | **一个 scope 都不要勾** |

> 本脚本只用 token **读公开的 Release 列表**，不推代码（推送走的是 GHA 自己的 token）。
> 所以**不需要** `repo` / `workflow` 之类的权限，给最小权限最安全。

#### 2. 让脚本读到它

三个途径任选其一（脚本按 `GITHUB_TOKEN` → `GH_TOKEN` 的顺序取，先有的优先）：

```powershell
# ① 当前会话临时用（最常用；关掉终端就没了，不会污染系统）
$env:GITHUB_TOKEN = 'ghp_xxxxxxxxxxxx'
node scripts/auto-sync/sync.mjs
```

```powershell
# ② 永久写进用户环境变量（一次配置，长期有效）
[Environment]::SetEnvironmentVariable('GITHUB_TOKEN', 'ghp_xxxxxxxxxxxx', 'User')
# 之后新开的终端自动带上；当前窗口要重开才生效
```

```powershell
# ③ 用 gh CLI 惯用的变量名（脚本同样认）
$env:GH_TOKEN = 'ghp_xxxxxxxxxxxx'
```

#### 3. 验证

```powershell
node scripts/auto-sync/probe.mjs
```

看到「GitHub Releases：N 个」就是通了；仍报 403 说明 token 没被读到（检查变量名拼写），
或额度按 IP 被其他程序占满。

> ⚠️ 不要把 token 写进仓库里的任何文件（`.env`、脚本、`config.mjs` 都不要）。
> `config.mjs` 只从环境变量读，仓库里永远不落凭据。

## 本地版（Windows 托盘 `fdn-autosync-tray`）

不想依赖 GitHub Actions 时，可以在自己的 Windows 电脑上跑同一条流水线。**只支持 Windows 10/11**，
依赖 **Node.js**（开发实测 24）与 **git**（都在 PATH 里；也可在配置里指定 Node 路径）。

### 进程模型

```text
start.vbs（wscript，无窗口）
  └─ powershell tray.ps1           宿主：托盘图标 / 菜单 / 详细状态 / 设置窗口 / Toast / 开机自启
       └─ node main.mjs            本地业务：唯一调度器 + 唯一状态机（配置 / 状态 / Git / WiFi / 日志 / 通知）
            └─ node sync.mjs       共享同步业务：与 GHA 完全同一份实现，按轮启动
```

- 宿主（PowerShell）**不做业务**：不读 Git、不跑同步、不读写 `config.json`/`state.json`，只做窗口与 Windows 集成
- 业务（Node）**不做 UI**：只发状态、发命令，需要打开文件夹/弹通知/改快捷方式时委托宿主
- 两者用**标准输入输出 JSON Lines** 通信，协议见 [`local/PROTOCOL.md`](local/PROTOCOL.md)
- **双击 [`local/start.vbs`](local/start.vbs)** 即可启动；单实例，重复双击不会起第二个

### 托盘菜单

未锁定时：

```text
fdn-autosync-tray
────────────
自启动后已同步：12 次
当前状态：空闲 / 同步中（Sync） / 已暂停
会话：剩 57 天（或「即将到期」「已失效，请更新 H1111_SESSION」）
上次同步：2026-11-26 20:30:18
上次结果：成功 · 用时 18 秒
下次同步：2026-11-26 20:40:18
────────────
立即同步（同步中禁用）
暂停自动同步 / 恢复自动同步
锁定
────────────
查看详细状态
浏览 >（项目目录 / 下载数据目录 / 自动同步目录 / 最新日志 / 日志文件夹）
────────────
配置文件
日志文件夹
配置…
开机自启动
修复自启动（仅在配置已开启但快捷方式不见了时出现）
重启
退出
```

- 状态区是**只读**信息（灰显不可点），文本由 Node 排版好（本地时区、中文），宿主原样显示
- 还没跑过任何一轮时显示「尚未同步」/「上次结果：—」，**不会虚构**上次时间

**锁定**后菜单变成：`fdn-autosync-tray（已锁定）` + 同样的状态摘要 + **查看详细状态** + 立即同步 + 解锁 + 浏览日志文件夹。
锁定**不隐藏状态、不影响定时同步、不影响图标角标**，只是把「改配置/暂停/重启/退出/开目录」等操作挡住；
权限由宿主隐藏菜单项 **和** Node 侧二次校验双保险（Node 收到越权命令一律拒绝并回 `locked`）。

「查看详细状态」是**只读**窗口（只有「关闭」按钮）：当前状态与阶段、运行次数、上次开始/结束/耗时、上次结果与简短错误、
各结果累计次数、下次同步时间（暂停时如实显示「未安排（已暂停）」），且**不含任何 Token / Cookie / 密码**。

### 图标与角标

底图与角标分开处理：底图来自 `local/assets/default.ico` 或你在设置窗口选的图片（会**复制**到 `local/assets/`，
不依赖原始路径）；角标画在右下角、约底图 50%，**沿角标实际轮廓挖透明**（不是挖方块），带抗锯齿。

角标优先级：**同步中**（白色右三角）＞ **已暂停**（白色 ‖）＞ **最近结果**（成功=绿勾 / 已是最新=绿点 / 失败或内部错误=红叉）＞ 无。
合成结果按「底图哈希 + 角标 + 尺寸集合」缓存在 `local/cache/icons/`，状态变化时直接复用缓存；
输出 16/20/24/32/40/48/64 多尺寸 ICO（传统 32bpp DIB 条目，.NET 的 `Icon` 可直接读）。

### 配置（首次运行自动生成）

`local/config.json`（**已在 `.gitignore` 里，不会入库**）。旧版扁平配置（`intervalMinutes`/`session`/`gitToken`/…）
会在首次启动时**自动迁移**到下面的结构，迁移前把原文件备份成 `config.json.legacy-<时间>`，凭据原样保留。

```json
{
  "version": 1,
  "runtime": { "nodePath": "", "syncTimeoutMinutes": 120, "pullTimeoutMinutes": 10, "pushTimeoutMinutes": 5 },
  "startup": { "enabled": false, "runOnStart": true },
  "scheduler": { "intervalMinutes": 10, "catchUpOnWake": true },
  "wifi": { "enabled": false, "ssid": "", "password": "", "useSavedFirst": true, "alwaysConnect": false,
            "skipOnFailure": true, "disconnectAfter": false, "disconnectEvenOnFailure": true, "forgetOnDisconnect": false },
  "stages": {
    "pull":   { "enabled": true, "strategy": "rebase" },
    "sync":   { "enabled": true },
    "commit": { "enabled": true, "identityMode": "gha", "userName": "", "userEmail": "" },
    "push":   { "enabled": true }
  },
  "credentials": { "H1111_SESSION": "", "H1111_USER": "", "H1111_PASSWORD": "", "GH_TOKEN": "", "PUSH_TOKEN": "" },
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

| 分组 | 字段 | 默认 | 说明 |
|---|---|---|---|
| runtime | `nodePath` | `""` | 留空 = 在 PATH 找 `node`；找不到宿主会明确提示 |
| runtime | `syncTimeoutMinutes` | `120` | 单轮同步硬超时，超时杀整棵子进程树并记为失败 |
| runtime | `pullTimeoutMinutes` / `pushTimeoutMinutes` | `10` / `5` | Pull / Push 超时 |
| startup | `enabled` | `false` | 开机自启动（**真实状态以 Startup 文件夹里的快捷方式为准**） |
| startup | `runOnStart` | `true` | 托盘启动后是否立即同步一次 |
| scheduler | `intervalMinutes` | `10` | **本轮结束后等待**的分钟数（12:00 开始、12:01 结束、间隔 10 → 下一轮 12:11） |
| scheduler | `catchUpOnWake` | `true` | 休眠唤醒后发现错过计划时**最多补跑一轮**（不连续补） |
| wifi | `enabled` 等 | 关 | WiFi 管理总开关与策略，见下文「同步前联网」 |
| stages.pull | `enabled` / `strategy` | 开 / `rebase` | 是否同步前拉取、策略 `rebase` 或 `ff-only` |
| stages.sync | `enabled` | 开 | 是否执行 `sync.mjs`（关掉 = 只跑 Git 阶段，调试用） |
| stages.commit | `enabled` / `identityMode` / `userName` / `userEmail` | 开 / `gha` | 身份：`gha` = `github-actions[bot]`（与 GHA 一致）/ `default` = 本机 git 配置 / `custom` = 下面两项（只作用于本仓库提交，不写 `--global`） |
| stages.push | `enabled` | 开 | 是否推送；关掉时提交只留在本地 |
| credentials | `H1111_SESSION` | `""` | huang1111 会话 cookie（取法见上文「会话 cookie」） |
| credentials | `H1111_USER` / `H1111_PASSWORD` | `""` | 回退用的账号密码（站点已改交互式验证，基本用不上） |
| credentials | `GH_TOKEN` | `""` | GitHub 只读 token（把 API 限额从 60 次/时提到 5000 次/时） |
| credentials | `PUSH_TOKEN` | `""` | 仅用于 `git pull/push` 鉴权；留空 = 沿用本机 git 凭据 |
| notifications | `mode` | `standard` | `standard` 每次按勾选项通知 / `cumulative` 每 N 次汇总一次 |
| notifications | `standard.*` | 成功/失败/内部错误开，已是最新关 | 四类结果各自是否通知 |
| notifications | `cumulative.everyRuns` / `internalErrorMode` | `7` / `always` | 汇总周期；内部错误是否始终单独提示 |
| appearance | `iconPath` | `null` | 自定义底图（相对 `local/` 的路径，如 `assets/user-icon.png`）；`null` = 默认 |
| logging | `retentionDays` | `90` | 日志保留天数，`0` = 永久保留（只清理本程序自己的日志） |
| security | `lockPassword` | `""` | 托盘锁定密码（明文，可迁移）；为空时**不允许锁定** |

> **明文凭据是用户明确要求的便携性权衡**：配置目录整体复制到另一台机器就能继续用，不绑 Windows 账户、不用 DPAPI。
> 代价是能读这个文件的人也能读到 Token。程序因此做了这些事：`config.json` 在 `.gitignore` 里、
> 启动时用 `icacls` 尽量收紧 ACL、凭据只在环境变量与本进程里出现（不进日志 / 状态 / Toast / 命令行参数 / Git URL）。

### 六个阶段与结果判定

```text
Prepare（检查网络，必要时连 WiFi）
  → Pull（fetch + rebase/ff-only，工作区脏则跳过，不覆盖你的改动）
  → Sync（调用 sync.mjs 本体：探测 → 登录 → 离线下载 → 直链 → 写 data/down JSON）
  → Commit（逐软件提交 data/down/<id>，不碰其它文件）
  → Push（推送；永不 --force）
  → Finish（按配置断开 / 忘记 WiFi，**无论成败都会执行**）
```

结果只有四类，**只看结构化结果，不解析日志猜**：

- `success`：有新内容/新版本，且本轮提交或推送成功
- `up-to-date`：检查成功但没有需要更新的内容
- `failure`：网络 / 远端 / 网盘 API / Git 等普通业务失败（含用户取消，取消绝不记成成功）
- `internal-error`：程序自身异常、配置或状态损坏、关键依赖缺失

### 行为与注意

- **跑的就是 [`sync.mjs`](sync.mjs) 本体**。托盘只把它当子进程调用，并通过环境变量
  `LOCAL_SYNC_STEP_COMMIT=0` / `LOCAL_SYNC_STEP_PUSH=0` 让它只写数据文件，提交与推送由托盘的 Commit/Push 阶段按本地配置来做；
  结构化结果走 `LOCAL_SYNC_RESULT_FILE`。GHA 不设置这些变量，行为完全不变
- **Push 失败不回滚本地提交**：提交本身就是待推送内容的持久化来源。下一轮先看本地是否 ahead，
  远端有新提交就按策略 Pull（冲突则停下记录，不擅自选 ours/theirs），然后重新 Push。
  所以「本轮 push 失败」不会丢数据，下一轮会自动补推（自动化回归见 `local/test/integration-runner.test.mjs`）
- **绝不覆盖你的工作区**：不 `reset --hard`、不 `clean -fd`、不 `push --force`、不改 remote URL、不改全局 git 配置。
  工作区有未提交修改时跳过自动 Pull；检测到未完成的 merge/rebase/cherry-pick 会停下让你手动处理
- 提交消息格式与 GHA 一致（`[GHA] 新增：内容：数据源：资源id-<id>：<版本列表>呜~`），正文说明本轮资源与时间
- **暂停**只取消下一轮定时器，不会打断正在跑的同步；暂停期间仍可「立即同步」，跑完仍不排下一轮。
  同步中再次点「立即同步」会被拒绝（不会起第二个任务）
- **通知**：标准模式下按四类结果勾选项弹 Toast（Windows 原生，失败退化为气泡）；累积模式每 N 次发一条汇总。
  **通知发送成功才清零累积计数**，发送失败不改同步结果
- **锁定**只限制 UI 操作，不是系统级安全边界（能读文件/结束进程的人照样能绕过）；**锁定后仍能看状态、
  仍能立即同步、仍能解锁、仍能开日志文件夹**，但不能改配置/暂停/重启/退出/开项目目录
- 日志：`local/logs/<yyyy>/<MM>/<dd>/run.log`（业务）、同目录 `tray.log`（宿主 + 子进程 stderr）；
  行格式 `[时间] [级别] [模块] 消息`，写入前统一脱敏（凭据、`ghp_...`、`Bearer ...`、`cloudreve-session` 一律变 `***`）
- 状态：`local/state.json`（少量必要数据：锁定/暂停/运行次数/上次结果/下次时间/累计统计），原子保存，损坏会备份并恢复默认
- 开机自启：菜单勾选或执行
  `powershell -ExecutionPolicy Bypass -File scripts\auto-sync\local\tray.ps1 -Install`（取消用 `-Uninstall`）。
  原理是在当前用户 Startup 文件夹放一个指向 `start.vbs` 的快捷方式；程序目录搬走后菜单里会出现「修复自启动」
- **不要和 GitHub Actions 的定时任务同时开启**：两边都可能提交 `data/down`，容易互相顶掉。
  用本地版时请先停用 `.github/workflows/auto-sync.yml` 的 `schedule`
- 程序目录可整体搬迁（配置 / 状态 / 日志 / 图标都在 `local/` 内，路径全部按脚本自身位置推导）；
  搬完重新勾一次开机自启即可

### 设置窗口

托盘菜单「配置…」打开原生 WinForms 窗口（锁定状态下不可打开），分页：

| 页 | 内容 |
|---|---|
| 部署 | 开机自启动、托盘外观（选择图片 / 重置默认图标）、启动后立即同步一次 |
| 准备阶段 | WiFi 总开关、SSID、密码、优先用系统已保存密码、总是尝试连接、失败跳过整次 |
| Pull | 跳过 Pull、策略 rebase / ff-only |
| Sync | 跳过 Sync、`H1111_SESSION`、`H1111_USER`、`H1111_PASSWORD` |
| Commit | 跳过 Commit、身份（GHA / 默认 / 自定义）、自定义用户名与邮箱 |
| Push | 跳过 Push、`PUSH_TOKEN` |
| 结束阶段 | 同步后断开 WiFi、失败也断开、断开后忘记配置 |
| 通知 | 标准 / 累积、四类结果勾选、累积次数、内部错误始终提示 |
| 其他 | 同步间隔、日志保留天数、锁定密码、`GH_TOKEN`、Node 路径、各阶段超时 |

保存时由 Node 校验并**原子**写入（唯一写配置的进程），校验失败会保留窗口里的输入让你改；
本轮正在跑的同步用的是**开始时的配置快照**，改配置只影响下一轮。

### 开发与测试

```bash
# 本地业务（不弹窗口、不开托盘）——开发联调用
node scripts/auto-sync/local/main.mjs        # 由 tray.ps1 通过 stdin/stdout 驱动

# 自动化测试（无需网络、不碰真实仓库）
# 注意：Node 24 的 node --test 不再接受目录参数，用 glob 或进入目录后不带参数
node --test "scripts/auto-sync/local/test/**/*.test.mjs"
```

- 测试覆盖：配置默认值/校验/迁移/原子保存、状态记账、调度器间隔与暂停/唤醒、通知文案与计数、
  **Git push 失败恢复（临时 bare 仓库 + pre-receive 钩子）**、工作区保护、锁定权限矩阵、协议编码、图标缓存键与 ICO 结构、WiFi 输出解析
- 联调钩子（正常运行时不要设置）：`FDN_LOCAL_DIR` 把本机运行数据重定向到别处、`FDN_REPO_ROOT` 把 Git/同步业务指向另一个仓库
- 宿主调试：`powershell -ExecutionPolicy Bypass -File scripts\auto-sync\local\tray.ps1 -NoTray`
  不创建托盘图标、只跑协议循环（用于协议联调，不会和正在用的托盘抢通知区）

## 数据结构（站内 `data/down/{id}/`）

- **自动生成（新格式）**：`auto/{年}/{月}/{日}/{版本名}.json` —— 年月日取 Release 发布时间转 UTC+8（不补零）；版本名保留 tag 原样（含前导 `v`/`V`），空白与非法文件名字符归一为 `_`。网盘侧对应 `foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}/{版本名}/`。
- **旧格式（历史保留，不再写入）**：`{段}/{段}/.../{段}.json`（由版本号按 `.` 拆段而来），解析器对旧格式保持兼容，新旧条目可共存。
- **手动条目**：
  - **置顶条目**：显式写 `"pinned": true` 的条目原样透传、永远排在所有版本条目之前（典型用例：FCL 的「最后一个有Boat后端的版本」）。置顶条目不参与「数据源最新版本」判定，也不会被 `keepLatest` 清理。
  - **手写版本条目**：`{ name, children }` 内联形态（无 `nextUrl`）会从 `name` / `tag` / `version` 中解析版本号，与自动条目一起按版本降序统一排序，不再被压到前面。
  - 兜底：既无 `pinned` 又解析不出版本号的条目仍按置顶处理（历史遗留数据不会被误排进版本序列）。
- index.json 的版本条目按版本降序；`default: true` 标记自动只保留在最新版本上（置顶条目一律不带 `default`）。

## 双 job 架构

```
probe job（轻量，必跑）──读取 GitHub Releases + 本地 index.json 基线──► 输出 needs_sync
                                                                        │
                                        needs_sync == 'true' ───────────┘
                                                  ▼
                       sync job（重量，按需）──登录 → 离线下载 → 直链 → 写 JSON → 提交 → push
```

- 无候选时 probe job 输出 `needs_sync=false`，**sync job 完全不启动**（连容器都不拉起）
- 凭据只在 sync job 中使用，probe job 不读凭据
- 异常时 probe 默认输出 `needs_sync=true`（宁可多跑一次，也不遗漏）

## 检测逻辑

1. 读 `data/down/{id}/index.json` 找**数据源内最新版本**
2. 数据源**没有**版本 → 只取 GitHub Release 最新一个
3. 数据源**有**版本 → 落后 Release 多少版本，把落后的**全部**下载（旧的先处理）
4. **不完整守护**：候选版本中，Release 发布时间距今不足 `guardMinutes` 分钟的**本轮跳过**，
   等下一轮（或发布满该时长后）再同步。防止刚发布时资产尚未传齐、直链尚未生效导致的半截同步。
   - 配置在 [`softwares.json`](softwares.json)：每个软件可单独写 `"guardMinutes": N`
   - 默认 **10 分钟**；写 `0` 关闭该软件的守护
   - 守护只影响「本轮是否同步」，不算失败；若全部候选都被守护，结果记为「已是最新」（绿色实心圆）
   - probe 与 sync 共用同一份实现，probe 也会把被守护的版本计入「暂缓」；若没有其他可同步版本，则不调度 sync job

## 重试策略

各场景的重试次数与超时以 [`config.mjs`](config.mjs) 的常量（`RETRY` / `TIMING` / `LIMIT` 等）为准。

**登录与取直链的验证方式**（站点 2026-10-02 起改为 **captcha policy v2**，图形验证码通路**已被后端下线**）：

验证不再是「先试图形验证码、失败再回退 PoW」的两阶段，而是一次**挑战 → 许可**链路：

```
正常请求（带 X-Cloudreve-Captcha-Protocol: 2）
  ↓ code=41700 + data 内嵌 policy{id, required, pow, …}
解 PoW（算法未变，PBKDF2-SHA256）
  ↓
POST /site/captcha/policy { id, pow_payload }   ← 字段名是 pow_payload（下划线）
  ↓ code=0, ready=true
带 X-Cloudreve-Captcha-Permit: <policy.id> 重发原请求  → 真实业务结果
```

- 整条链路最多 `RETRY.VERIFY_ATTEMPTS`（3）次，每次换新 policy/挑战
- 单次 PoW 求解硬超时 `RETRY.POW_SOLVE_TIMEOUT_MS`（150s；求解为单线程逐 counter 试算，`counterLimit` 上限 5000）
- `41702` 限流按 `data.retry_after` 退避重试
- `40020`/`40001`/`401` 为终态（凭据错误、未登录等），立即失败不做无谓重试
- 站点要求**交互式验证**（图形点选/输入字符）时直接报错并提示改用会话 cookie，不静默重试

> ⚠️ 前置条件（详见 [`docs/huang1111-api-notes.md`](../../docs/huang1111-api-notes.md) §0.3）：
> 1. 所有请求都要带 `X-Cloudreve-Captcha-Protocol: 2`，否则一律 `41709`「请更新页面后使用新版验证」
> 2. 验证链路需要**全量 cookie**。但**只需自己提供 `cloudreve-session`** ——
>    `cloudreve_observer` / `cloudreve_send` 由 41700 响应**自动下发**并被 cookieJar 吸收，
>    无需手工保存（实测 2026-10-07：只带 session 即可走完 PoW → policy → permit 拿到直链）。
>    > 旧文档写的「只带 session 恒返回 41701」描述的是**手工构造请求、未接收 41700 下发的 cookie**
>    > 那种情形；本脚本用 cookieJar 自动吸收，不受影响。

任一步耗尽后：该版本跳过（不写 JSON），其余版本继续；存在失败项时进程以非 0 退出，GHA 显示红色即告警，下次运行自动补。

## 日志（logger.mjs）

2026-10 全量重构，**旧的 `ctx` 日志模块已整体作废**。新规则：

| 要求 | 做法 |
|---|---|
| 详细明了 | 关键事实逐条列出：资产名、字节数、网盘路径、直链、校验结果都不省略 |
| 结构清晰的缩进 | 树形前缀 `├─ │ └─` 由作用域嵌套**自动推导**，调用方不手写空格 |
| 保留提交正文带日志 | 每个软件作用域自动收集正文，见下 |
| 不在末尾重复整份日志 | 控制台逐行输出即唯一 run 日志，**没有**「--- 完整日志 ---」重打 |
| 每行不带时间戳 | GH Actions 自己给每行打时间；耗时只在阶段收口行里说一次 |
| 不用折叠分组 | 不调 `::group::` / `::endgroup::`，层级靠缩进表达 |

**缩进模型**：作用域树，**每一行都是一个树节点、都有分支符**：

| 行类型 | 前缀 | 说明 |
|---|---|---|
| 作用域标题 | `├─ ` | 画在本级 |
| 普通行 | `│  ├─ ` | 比标题深一级 |
| 清单项（`items()`） | `│  │  · ` | 再深一级，`·` 与 `├─` 区分 |
| 结论（`close()`） | `│  └─ ` | 本作用域最后一行 |

前缀 = `│  ` × (depth − 1)。根作用域（depth 0）没有树线，散行平铺。
**为什么这样是流式安全的**：`└─` 只出现在 `close()`，那一刻在定义上就是最后一行，无需预知未来；
祖先竖线统一画 `│  `（不断言"祖先之后还有没有兄弟"），所以行一旦输出就永不回改，GHA 的非 TTY 日志也不会错位。

```
线路1 自动同步 · 7 个软件
├─ 阶段 1：预探测候选
│  ├─ 资源 id=0（FCL-Team/FoldCraftLauncher）
│  │  ├─ 数据源最新版本：1.3.3.7
│  │  ├─ 落后 1 个版本：1.3.3.8
│  │  └─ ✅ 需同步 1 个版本
│  ├─ 资源 id=3（ZalithLauncher/ZalithLauncher2）
│  │  └─ ✅ 已是最新，无需同步
│  └─ ✅ 阶段 1 完成｜用时 3.6s
├─ 阶段 2：同步 1 个软件
│  ├─ 资源 id=0（FCL-Team/FoldCraftLauncher）
│  │  ├─ 版本 1.3.3.8
│  │  │  ├─ 按 arch 模式解析出 5 个文件（合计 1006.1 MiB）：
│  │  │  │  · FCL-release-1.3.3.8-all.apk → all（331.2 MiB）
│  │  │  │  · FCL-release-1.3.3.8-arm64-v8a.apk → arm64-v8a（172.6 MiB）
│  │  │  ├─ 离线下载
│  │  │  │  ├─ 提交第 1/1 批（5 个）：…
│  │  │  │  └─ ✅ 下载完成｜用时 10.0s
│  │  │  └─ ✅ 版本同步完成：1.3.3.8
│  │  └─ ✅ 完成：同步 1 个版本并提交｜用时 10.3s
│  └─ ✅ 阶段 2 完成｜用时 16.0s
└─ 总用时 16.8s｜结果：全部成功｜成功软件 7/7
```

**提交正文**：`资源 id=…` 作用域内产生的行会自动进入该软件的 commit body；
阶段级/登录级内容用 `commit: false` 排除，过程噪声（PoW 求解进度、轮询中间态）用 `body: false` 排除；
进入作用域时还不知道会不会有事的小节（如 `keepLatest=0` 时的「保留清理」）可用 `dropFromBody()` 事后抹掉。
正文按**实际发生顺序**生成，无需手工拼装（缩进用纯空格而非树线，更适合 `git log` 阅读）：

```javascript
const swScope = phase.child(`资源 id=${sw.softwareId}（${sw.githubRepo}）`);
swScope.line('…');                       // 进正文
swScope.items(['…', '…']);               // 清单项，进正文时保留 '· '
const v = swScope.child(`版本 ${version}`);
v.line('…');                             // 进正文，自动多缩进一层
v.close('✅ 版本同步完成');               // 结论行进正文
commitSoftware(id, versionList, swScope.collectBody(), swScope);
```

**汇总页**（`GITHUB_STEP_SUMMARY`）是一张**详细表格**，与 run 日志分工不同、内容不重复：
资源 id / 仓库 / 数据源最新 / 数据源条目数 / Release 数 / 落后版本 / 本次同步 / 保留清理 / 结果 / 用时。

**失败可见性**：`::error::` / `::warning::` / `::notice::` 只发 GHA 注解（Actions 页顶部红色/黄色横幅），
**不再把同一句话在 run 日志里抄第二遍**。

## 提交格式（每软件一个 commit）

```
[GHA] 新增：内容：数据源：资源id-{id}：{版本1&版本2&...}呜~

{该软件的详细过程日志：从「资源 id=…」到最终结论，按发生顺序，含资产清单与直链}
```

- 主题以 `[GHA]` 开头，与 `updata-verInfo.yml` 的防重入判断兼容，不会互相触发
- 正文即上面那个作用域的 `collectBody()` 结果，**不含**阶段级/登录级内容，也不含整份 run 日志

## 新增/维护软件

1. 打开 [`softwares.json`](softwares.json)，按现有条目格式追加一行（各字段含义见字段名本身与 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md)）。
2. 确认 `githubRepo`、`mode`（`arch` 按架构出条目 / `name` 按文件名出条目）、资产过滤与兜底架构。
3. 按需设置 `guardMinutes`（不完整守护，默认 10 分钟，`0` = 关闭）：发布后等多久再同步该软件的新版本。
4. 特殊结构（子目录 wrapper、`{name, children}` 内联等）初版**不纳入自动同步**，index.json 手动条目原样透传；其中 `{name, children}` 形态若 `name` 能解析出版本号（如 `v1.0.2`）会参与统一排序，解析不出的需加 `"pinned": true` 才会稳定置顶。

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| Actions 运行失败（红色） | 查看该次运行日志：登录失败 / 某版本下载失败 / 直链失败，均会输出中文原因；下次运行自动重试 |
| 某版本一直失败 | 本地手动跑一次看完整日志；常见：GitHub 资产命名变化（改 `softwares.json`）、PoW 链路重试耗尽（偶发，重跑） |
| index.json 顺序乱了 | 置顶条目必须是 `"pinned": true`；手写 `{name, children}` 条目的版本号要能从 `name` 解析（如 `v1.0.2`）。其余版本条目按版本降序自动排列 |
| 日志报 `41709 请更新页面后使用新版验证` | 请求缺 `X-Cloudreve-Captcha-Protocol: 2` 头，或站点又升了协议版本 —— 查 `h1api.mjs` 的 `CAPTCHA_PROTOCOL` |
| 日志报 `41701 验证失败，请重试` | 走到验证链路时 cookie 不完整。脚本用 cookieJar 自动吸收 41700 下发的 `cloudreve_observer`，正常不该出现；若持续出现，检查是否手工改过请求头 |
| 登录报 `401 Login required` /「会话 cookie 已失效」 | `H1111_SESSION` 过期（60 天）。按上面「会话 cookie」一节重新登录并更新 secret |
| 登录报「缺少凭据」 | 没配 `H1111_SESSION`（且没配账号密码）。会话 cookie 是当前唯一可用路径 |
| 运行页横幅显示「会话 cookie 剩余 X 天」 | 正常。这是每次巡检的固定输出，方便一眼看到寿命；剩余 ≤30 天时会附「临期」标记，失效时变红（`::error::`） |
| 日志报「站点要求交互式验证」 | 站点给该 purpose 开了点选/输入（`required.interactive > 0`）。**登录**必然如此 → 改用 `H1111_SESSION`；若**取直链**也变成这样，说明站点扩大了交互式范围，届时只能人工维护 |
| 日志报 `41702` 限流 | 已按 `retry_after` 自动退避；若频繁出现说明触发频率限制，需拉长定时任务间隔 |
| 日志出现「求解中… N/5000」 | 正常。PoW 求解为单线程逐 counter 试算，耗时数十秒，进度日志每 5s 一条，不是卡死 |

> 怀疑站点又改了验证机制时，先跑项目外测试目录的探针确认
> （路径与用法见 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md) 开头；
> 交互式验证专项探针为 `_probe-v3-*.mjs` / `_probe-v3-*.py`）。

## 已知边界

- 软件映射见 [`softwares.json`](softwares.json)；其余软件待后续扩展映射表
- **登录无法自动化**：站点 2026-10-07 起对登录强制交互式验证（人眼点选/输入/拖滑块），
  故依赖 `H1111_SESSION` 的人工续期（60 天一次）；剩余天数每次巡检都写在日志与运行页上
- 单次运行中途若会话过期（401）不做自动重登（下次运行重新登录）；其余均在约定重试策略内自动恢复
- 自动版本条目带 `size` 字段（前端 `formatBytes` 显示），手动旧条目无 `size` 不影响
