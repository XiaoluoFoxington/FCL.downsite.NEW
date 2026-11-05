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
- `local/`：**Windows 托盘版外壳**（`tray.ps1` / `start.vbs` / `session-status.mjs`），复用 `sync.mjs` 全流程，不重复实现

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

## 本地版（Windows 托盘，常驻自动同步）

不想依赖 GitHub Actions 时，可以在自己的 Windows 电脑上跑同一条流水线。

- **只支持 Windows 10/11**；依赖 **Node.js 18+** 与 **git**（都在 PATH 里）
- **直接双击 [`local/start.vbs`](local/start.vbs)**：无黑框、无窗口，通知区域出现一个下载图标
- 托盘图标上的菜单：立即同步 / 暂停·继续 / 更新间隔（15·30·60·120·240·720 分钟 + 自定义）/ 开机启动 / 打开日志 / 打开配置 / 会话剩余天数 / 退出
- **跑的就是 [`sync.mjs`](sync.mjs) 本体**（预探测 → 登录 → 离线下载 → 直链 → 写 JSON → 分软件提交 → push），本地版只是外壳，不存在第二套同步逻辑

### 配置（首次运行自动生成）

`local/config.json`（已在 `.gitignore` 里，**不会入库**）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `intervalMinutes` | `60` | 自动同步间隔（分钟），也可在托盘菜单里改 |
| `runOnStart` | `true` | 托盘启动后是否立即同步一次 |
| `nodePath` | `""` | 留空自动在 PATH 找；找不到时填 `node.exe` 完整路径 |
| `session` | `""` | huang1111 会话 cookie；留空则沿用系统环境变量 `H1111_SESSION` |
| `githubToken` | `""` | GitHub 只读 token；留空则沿用 `GITHUB_TOKEN` / `GH_TOKEN`（匿名限额 60 次/小时） |
| `syncTimeoutMinutes` | `120` | 单次同步硬超时，超时强杀子进程 |

> 会话 cookie 的取法见上文「会话 cookie」一节（`node scripts/auto-sync/tools/refresh-session.mjs`）。
> 托盘会离线推算「还剩多少天」，剩余 ≤10 天时弹气泡提醒。

### 行为与注意

- **每次运行都会 commit + push 到当前仓库的 `origin`**，用的是本机 git 凭据（SSH key / credential helper）。请确保当前目录是**你要同步的那个仓库**的克隆，且分支正确
- 本地版**不会自动 pull**：它直接在当前工作区上提交。若远端已有新提交，push 会被拒绝；push 卡住则 5 分钟后超时失败。两种情况提交都会留在本地，而下一轮因为本地 JSON 已是最新**不会自动补推** —— 托盘会持续显示「待推 N」并弹一次气泡提醒。恢复：在仓库目录执行 `git pull --rebase && git push`，之后托盘状态自动消失
- **不要和 GitHub Actions 的定时任务同时开启**，两边都可能提交 `data/down`，容易互相顶掉。用本地版时请先停用 `.github/workflows/auto-sync.yml` 的 `schedule`
- 每次同步写一个日志：`local/logs/sync-<时间>.log`；托盘自身事件写 `local/logs/tray.log`。双击托盘图标可直接打开**最近一次**同步日志
- 同步进程完全隐藏运行，**不会弹任何窗口**；只有点「自定义间隔」等菜单项时才会出现小对话框
- 开机自启：托盘菜单勾选「开机启动」，或执行
  `powershell -ExecutionPolicy Bypass -File scripts\auto-sync\local\tray.ps1 -Install`
  （取消用 `-Uninstall`）。原理是在当前用户的 Startup 文件夹里放一个指向 `start.vbs` 的快捷方式
- 单实例：重复双击 `start.vbs` 不会起第二个托盘

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
3. 特殊结构（子目录 wrapper、`{name, children}` 内联等）初版**不纳入自动同步**，index.json 手动条目原样透传；其中 `{name, children}` 形态若 `name` 能解析出版本号（如 `v1.0.2`）会参与统一排序，解析不出的需加 `"pinned": true` 才会稳定置顶。

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
