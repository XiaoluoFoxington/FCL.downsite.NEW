# 线路1 自动更新设计方案

> 状态：**已实施**——日期归档 + 双 job 预探测（probe→sync）架构已落地并验证通过。演进历史见 git 记录。
> 目标：将线路1（`/data/down`）从"站长手动维护"改造为"GitHub Actions 自动更新"，保留现有网盘分发模式，站端零代码改动。
>
> 本文只记录**设计决策与原因**。具体实现、配置项、常量与软件映射以 `scripts/auto-sync/` 下的代码为准（`config.mjs`、`softwares.json` 等）；网盘 API 端点细节以 [`huang1111-api-notes.md`](huang1111-api-notes.md) 为准；脚本用法以 [`../scripts/auto-sync/README.md`](../scripts/auto-sync/README.md) 为准；测试文件在项目外，路径：`C:\Users\XiaoluoFoxington\huang1111-api-test`（线上脚本的验证探针为其中的 `_probe-v2-*.mjs`，用法见该目录 `README.md`）。

## 1. 背景与目标

### 1.1 现状痛点

线路1 原本是纯手动维护：每当某个软件发布新版本，站长需要从 GitHub Releases 下载各架构 APK、上传到 huang1111 网盘、获取直链、手写/更新 `data/down/{软件id}` 下的 JSON，再提交仓库。流程繁琐、易错，且依赖人肉盯版本。

### 1.2 目标

- 新版本发布后，**自动**完成「GitHub Releases → 网盘离线下载 → 取直链 → 生成 JSON → 提交仓库」全链路
- 站端（`data/mirror.json`、软件 `detail.json`、视图/控制器/适配器）**零改动**
- 文件继续托管在现有 huang1111 网盘，不引入新的服务器/存储成本
- 自动 + 手动共存：标准版本全自动，特殊条目（共存版、自定义描述等）继续手动维护
- 网盘侧脚本产物统一放新专用根目录，与手动维护目录完全隔离

### 1.3 非目标（明确不做）

- 不买服务器、不使用 R2/OSS 等新存储
- 不改变线路1 的 API 结构（不引入 apiVer、不新增 adapter）
- 不迁移历史版本数据（只增量同步服务上线后的新版本）
- 不做浏览器自动化（已验证网盘 API 可直接调用，无需操作网页）
- 不覆盖站内其它线路

## 2. 关键前提（设计依据）

### 2.1 网盘账号前提

账号需具备**直链空间**与**离线下载**权限（单文件上限、并行任务数等以网盘当前策略为准）。直链空间的上限足以容纳本站最大的资源包，这是选择该方案的依据之一。

### 2.2 网盘目录隔离

现有网盘目录结构混乱不一致，因此**脚本一律不读现有文件树**：所有脚本产物统一放到**新的专用根目录**下，按 Release 发布时间归档，与手动维护的目录完全隔离，互不干扰。

### 2.3 直链特性

- 网盘提供的 `/f/{code}/{文件名}` 是**稳定的公共直链**：无需登录即可访问，302 重定向到真实下载服务器
- 签名带时间戳，但入口 URL 长期有效，可直接写入 `data/down` JSON 长期使用

### 2.4 站点数据结构（data/down）

自动产物需与现有手动条目对齐、共存。具体的路径格式（新旧两种）与条目字段见 [`../scripts/auto-sync/README.md`](../scripts/auto-sync/README.md) 的「数据结构」一节，本文不复制（避免与实现漂移）。

关键约束：解析器对**旧格式保持兼容**，新旧条目可共存；自动生成的版本条目必须带 `size` 字段（前端据此显示文件大小），手动旧条目无 `size` 不影响。

## 3. 架构设计

### 3.1 总体流水线（双 job 架构）

```
GHA workflow
  │
  ├─ 【probe job】——轻量预探测（必跑）
  │   · checkout + setup-node
  │   · node probe.mjs
  │       - 读仓库已有 data/down/{id}/index.json 作基线
  │       - 拉 GitHub Releases（不读凭据、不动网盘、不跑 git）
  │       - 全量软件均已是最新 → 输出 needs_sync=false → sync job 不调度
  │
  └─ 【sync job】——重量同步（仅当 needs_sync=true 时调度）
      · checkout + setup-node
      · node sync.mjs
          ① 一次性登录网盘（跨软件复用会话）
          ② 对每个有候选的软件：幂等检查 → 提交离线下载 → 轮询（旧的版本先处理）
          ③ 对每个完成的新版本：目录按文件名匹配取文件 id + size → 批量取直链
          ④ 生成/更新仓库 JSON（版本文件 + index.json）
          ⑤ 分软件 git commit（固定消息格式）+ 全部完成后统一 push
```

**为什么分双 job？** 日常定时任务（多数时候无新 Release）只需跑轻量的 probe job，省掉 Node 安装以及全部网盘操作；sync job 仅在有候选时才启动（容器都不拉起）。

> 2026-10-02 起站点图形验证码通路下线，验证全靠 PoW，**sync job 已不再需要 Python / pip / OCR 依赖**（相应步骤与 Secrets 已移除）。

### 3.2 触发与凭据

- 由工作流的 `schedule`（cron 按 UTC 编写）与 `workflow_dispatch` 手动触发；另有 `concurrency` 防重入。具体时间点见 `.github/workflows/auto-sync.yml`。
- **登录凭据**以仓库 Secrets 注入，只在 sync job 中使用；probe job 完全不读凭据。
- **验证方式（2026-10-02 起为 captcha policy v2）**：站点已**下线图形验证码通路**（`captchaCode` 失效），验证统一走 PoW：
  - 所有请求带 `X-Cloudreve-Captcha-Protocol: 2`（缺失 → `41709`）
  - 请求返回 `41700` 时取其内嵌 policy → 解 PoW → `POST /site/captcha/policy` 换许可 → 带 `X-Cloudreve-Captcha-Permit` 重发
  - 整条链路按次重试（`RETRY.VERIFY_ATTEMPTS`），`41702` 限流按 `retry_after` 退避
  - PoW 求解为纯 WebCrypto（与前端 WebCrypto 回退路径同算法），**单线程**，带进度日志与硬超时
  - ⚠️ 必须携带**全部 cookie**（`cloudreve-session` + `cloudreve_observer` + `cloudreve_send`），否则许可提交恒 `41701`
  - 协议细节与被否决的旧方案见 [`huang1111-api-notes.md`](huang1111-api-notes.md) §0.3 / §0.4b / §0.7

### 3.3 软件映射表

新增配置文件 `scripts/auto-sync/softwares.json`，每个软件一条，记录站内软件 id、GitHub 仓库、资产匹配方式等。字段定义与当前收录清单**以该文件为准，本文不再复制**（避免与文件漂移）。

- 网盘目标目录由脚本按站内软件 id 与发布日期自动拼接，无需在映射表中配置路径
- 新增软件 = 追加一条映射；特殊结构（子目录 wrapper、`{name, children}` 内联等）初版**不纳入自动同步**，其 index.json 条目原样透传（这些手写条目会按 `name` 解析出的版本号参与统一排序，见 §3.5；确实无法解析版本号的用 `"pinned": true` 显式置顶）

### 3.4 版本路径映射（日期归档）

- **网盘侧**（脚本读写）与**站端侧**（`data/down`）使用同一条日期路径，日期取 Release 发布时间转 UTC+8（不补零），同一天的多个版本归到同一目录
- **版本名归一化**：保留前导 `v`/`V` 原样；空白与非法文件名字符归一为 `_`；连续点塌缩、去首尾点（避免隐藏文件）
- **旧格式兼容**：旧条目路径反解时会排除日期归档的命名空间首段，防止被误判为巨大假版本

### 3.5 JSON 生成规则

- **版本文件**：按 `mode` 区分输出结构（架构列表 / 文件名列表），URL 用直链、size 用目录响应中的字节数
- **index.json**：
  - 保留所有现有条目（含手动条目，原样透传）
  - **排序分两桶**：置顶条目前置，其余条目按版本号降序
  - **置顶的判定是显式的 `"pinned": true`**（2026-10-02 修订）。原实现把"能否从 `nextUrl` 反解出版本号"当作手动/版本的判据，导致两个副作用：id0 的 `/data/down/0/boat.json` 靠这条规则**意外**置顶；id12 那类 `{ name, children }` 内联手写版本条目也被误判为手动，永远压在自动同步的新版本之前（新版本反而掉到列表最底）。现在改为：置顶必须显式声明；手写条目从 `name`/`tag`/`version` 解析版本号后并入统一排序；既无 `pinned` 又解析不出版本号的条目兜底按置顶处理（保护历史遗留数据）。
  - 置顶条目不参与「数据源最新版本」判定，也不被 `keepLatest` 清理
  - 新版本按版本号降序插入（比较逻辑与前端 `js/adapters/download/common.js` 一致）
  - `default: true` 标记只在最新的版本条目上保持（置顶条目一律不带 `default`）
  - 与已有条目重名则跳过（视为已同步）；比较时忽略 `v`/`V` 前缀，避免 `v1.0.5` 与 `1.0.5` 被当成两个版本重复同步
- **写入格式**：与现有文件保持一致（缩进、UTF-8 无 BOM、无末尾换行）

### 3.6 目录/文件结构

自动化相关代码位于 `.github/workflows/auto-sync.yml` 与 `scripts/auto-sync/` 下；各文件的职责以其文件头注释与 [`../scripts/auto-sync/README.md`](../scripts/auto-sync/README.md) 为准，本文不逐文件罗列。

脚本用 Node.js 编写（仓库无构建步骤，与前端生态一致），CI 用 `actions/setup-node` + 无依赖脚本（原生 `fetch` / `webcrypto`）以避免 `npm install` 开销。**无 Python 依赖**（2026-10-02 起 OCR 已移除）。

### 3.7 提交格式（每软件一个 commit）

- 主题以 `[GHA]` 开头（与用户提交规范一致，以「呜~」结尾），正文为该软件的详细日志
  - 正文由统一分层日志模块 `log.mjs` 的**作用域捕获**（`log.capture`）生成，只含该软件同步期间的分级日志；每个事件只记录一次
- 无变更不提交；全部完成后统一 push
- 主题前缀与 `updata-verInfo.yml` 的防重入判断天然兼容，两个工作流不会互相触发死循环

### 3.7b 日志与运行概览

- **单一分层日志**：所有脚本统一 import `log.mjs`（唯一日志出口），提供 `section`（阶段标题）/ `group`+`end`（可折叠分组）/ `info` / `ok` / `detail` / `warn` / `fail`，行首按层级缩进、**不加时间戳**
- **GHA 感知**：GHA 下用 `::group::`/`::endgroup::` 折叠、`::warning::`/`::error::` 发注解；本地/手动运行降级为普通标题行（不发 GHA 指令）
- **不重复**：注解直接承载消息（不再另起同义日志行）；结尾不重复打印完整日志
- **概览汇总**：probe/sync 各向 `$GITHUB_STEP_SUMMARY` 追加一份简洁 Markdown（逐软件结果表 + 总计），详细日志只留在运行日志

### 3.8 验证协议（captcha policy v2）

2026-10-02 起站点把验证换成 **captcha policy v2**，图形验证码通路**后端已下线**（OCR 相关代码、依赖与 Secrets 全部移除）。当前唯一路径：

```
所有请求带 X-Cloudreve-Captcha-Protocol: 2（缺失 → 41709）
  → 41700 + 内嵌 policy → 解 PoW → POST /site/captcha/policy {id, pow_payload}
  → 带 X-Cloudreve-Captcha-Permit: <policy.id> 重发原请求
```

- 必须携带**全部 cookie**（`cloudreve-session` + `cloudreve_observer` + `cloudreve_send`），否则许可提交恒 `41701`
- 必须使用 **41700 内嵌**的 PoW token（含 `binding` claim）；独立 `GET /site/captcha/pow` 的 token 无效
- PoW 算法与上一版**一致**（PBKDF2-SHA256 + `Cloudreve-PoW/v1` 域分隔串），但要求**单线程**求解并设置硬超时

协议细节与被否决方案的排查过程见 [`huang1111-api-notes.md`](huang1111-api-notes.md) §0.3 / §0.4b / §0.7 / §10。

## 4. 错误处理与恢复

采用**分级重试**：完整验证链路（41700 → PoW → policy → permit）、离线下载（整段「提交+轮询」）、其他任何失败各自有独立的重试上限；**具体次数与超时以 [`../scripts/auto-sync/config.mjs`](../scripts/auto-sync/config.mjs) 的常量为准**。

| 场景 | 处理 |
|---|---|
| probe job 失败 | 全部软件探测失败 → 仍输出 `needs_sync=true`（宁可多跑一次，也不遗漏）；个别失败但其他有候选 → 照常触发 sync job |
| 登录失败（验证链路/CSRF/网络） | 按分级重试（整条验证链路换新 policy 重走）；`40020`/`40001`/`401` 为终态立即失败；仍失败 → workflow 失败（Actions 红色即告警），下次运行自动重试 |
| 站点要求交互式验证（滑块） | `required.interactive > 0` 时直接报错暴露，不静默重试（脚本无法自动完成） |
| 验证被限流（41702） | 按 `data.retry_after` 退避后重试 |
| 离线下载失败 | 轮询判失败；本版本跳过（不写 JSON），继续处理其余版本，退出码非 0 |
| 会话过期（401） | 单次运行只在开始时建立会话；中途失效以错误暴露，下次运行自动重登（当前不自动重登，属已知边界） |
| 直链获取失败 | 重走完整验证链路（换新 policy）；仍失败 → 该版本跳过写 JSON，下次运行重试 |
| 同版本重复触发 | 以仓库已有 index.json 为基线去重（重名跳过）；离线下载前先查目录，已含全部文件则跳过 |
| 手动条目冲突 | 脚本只增不删 index.json 条目；手动条目原样透传 |
| GHA 运行超时 | probe/sync job 各有 `timeout-minutes` 兜底（见 workflow）；未完成的版本下次运行续跑 |

## 5. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 网盘 API 是逆向产物，可能变更 | 中 | 所有调用集中在 `h1api.mjs` 一处，变更时只改封装；仓库记录 API 验证快照（见 `huang1111-api-notes.md`） |
| 登录凭据存于 Actions secret | 中 | secret 权限最小化；账号密码可随时在网盘端改密作废 |
| PoW 求解耗时（单线程逐 counter 试算，数十秒级） | 低 | 带 5s 一条的进度日志 + 硬超时（`RETRY.POW_SOLVE_TIMEOUT_MS`）；挑战有效期约 1200s 余量充足；失败换新挑战重走 |
| 站点再次变更验证机制（如强制交互式验证、换协议版本） | 中 | 验证逻辑集中在 `h1api.mjs` 的 `verifyThenSend` + `login`/`getSources` 两处；协议常量（`CAPTCHA_PROTOCOL` / `POW_PROTOCOL` / `POW_DOMAIN_STRING`）已显式命名并带注释，变更时改这一处；人工复核方法见 `huang1111-api-notes.md` §0.7 |
| 离线下载依赖网盘服务器访问 GitHub 的连通性 | 中 | 已验证可用；失败重试；必要时可配置代理前缀 |
| GHA API 限流 | 低 | 调用量极小（每软件 1 次 releases + 少量网盘接口调用） |
| 站端 JSON 结构被脚本改坏 | 低 | 生成后本地校验（JSON 可解析、URL 前缀、index 与版本文件一致），校验不过不提交 |

## 6. 状态与遗留

- ✅ 已实施：脚本骨架与网盘 API 封装、映射表、FCL 全链路试点、日期归档、双 job 预探测、纯函数抽取、GHA 接入
- ⏳ 待扩展：为采用特殊结构的其余软件补映射表（待评估其 index/版本文件结构）
- ⏳ 观察期：GHA 上线后观察真实发布场景，确认稳定后交接
