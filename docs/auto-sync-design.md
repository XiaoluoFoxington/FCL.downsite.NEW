# 线路1 自动更新设计方案

> 状态：**已实施（v2，2026-08-26）**——日期归档 + 双 job 预探测架构已落地；本地真实运行验证通过
> 历史："设计草案（待审阅）" → 2026-08-25 实现初版 → 2026-08-26 迭代：日期归档替代逐位拆分、双 job 预探测（probe→sync）、lib.mjs 纯函数抽取
> 目标：将线路1（id 0，`/data/down`）从"站长手动维护"改造为"GitHub Actions 自动更新"，保留现有网盘分发模式，站端零代码改动。

## 1. 背景与目标

### 1.1 现状痛点

线路1 目前是纯手动维护：每当某个软件（FCL、Zalith2、Pojav 等）发布新版本，站长需要：

1. 从 GitHub Releases 下载各架构 APK
2. 上传到 huang1111 网盘（`foldcraftlauncher_cn` 目录树）
3. 在网盘里获取直链（`pan.huang1111.cn/f/{code}/{文件名}`）
4. 手动编写/更新 `data/down/{软件id}/...` 下的 JSON（index.json 版本列表 + 每版本架构文件）
5. git commit + push

这套流程繁琐、易错、依赖人肉盯版本。

### 1.2 目标

- 新版本发布后，**自动**完成"GitHub Releases → 网盘离线下载 → 取直链 → 生成 JSON → 提交仓库"全链路
- 站端（`data/mirror.json`、软件 `detail.json`、视图/控制器/适配器）**零改动**
- 文件继续托管在现有 huang1111 网盘（VIP2 年付），不引入新的服务器/存储成本
- 自动+手动共存：标准版本全自动，特殊条目（boat.json、共存版、自定义描述）继续手动维护
- 网盘侧脚本文件统一放新根目录 `foldcraftlauncher_cn_auto/`，与手动维护的 `foldcraftlauncher_cn/` 完全隔离

### 1.3 非目标（明确不做）

- 不买服务器、不使用 R2/OSS 等新存储
- 不改变线路1 的 API 结构（不引入 apiVer、不新增 adapter）
- 不迁移历史版本数据（只增量同步服务搭建完成后的新版本）
- 不做浏览器自动化（已验证 huang1111 API 可直接调用，无需操作网页）
- 不覆盖站内其它线路（线路2~线路12 保持现状）

## 2. 关键事实（已实测验证；3.8.5 更新后已重测）

### 2.1 huang1111 账号与权限

- 账号：`XiaoluoFoxington`（`2046665121@qq.com`）
- 等级：**VIP2（年付）**
- 存储策略：**V2 直链空间（单文件上限 2GB）**，直链可用于 326MB 的 FCL all 版 APK
- 离线下载：`allowRemoteDownload: true`，VIP2 支持 6 个并行任务
- 空间：年付 700GB + 100GB 赠送

### 2.2 网盘目录结构（脚本专用）

现有网盘目录（`foldcraftlauncher_cn`）**结构混乱且不一致**（FCL 用 `new/{逐位拆分}` 嵌套、zalith2 平铺、pojav 直接放文件），**脚本一律不读现有文件树**。所有脚本产生的文件统一放到**新的专用根目录**，按 Release 发布时间归档：

```
foldcraftlauncher_cn_auto/{软件id}/{年}/{月}/{日}/版本文件.后缀名
```

例如：`foldcraftlauncher_cn_auto/0/2026/8/26/FCL-release-1.3.2.8-arm64-v8a.apk`

- `{软件id}` = 站端 `data/software.json` 的 id（0=FCL、3=Zalith2、4=Amethyst、16=Acode、...）
- `{年}/{月}/{日}` = Release 发布时间转 UTC+8（不补零，如 `2026/8/26`），同一天的版本归到同一目录
- 该目录只由脚本读写，与手动维护的 `foldcraftlauncher_cn/` 完全隔离

### 2.3 已验证的 huang1111 API（Cloudreve v3 定制版）

全部基于登录 cookie（`cloudreve-session`）会话，页面上下文 fetch 同源调用。3.8.5 起流程含 验证码+CSRF（详见 `docs/huang1111-api-notes.md`）：

| 用途 | 方法/路径 | 请求体 | 实测结果 |
|---|---|---|---|
| 登录（含验证码） | `GET /site/captcha` + `GET /site/config` + `POST /user/session` | `{userName, Password, captchaCode}` | ✅ 3.8.5 必需；失败换新验证码重试，上限 10 次（实测 1~2 次即中） |
| 取 CSRF | `GET /site/config` | — | ✅ 唯一来源（响应头 `x-csrf-token`）；每次写请求前重取 |
| 列目录 | `GET /api/v3/directory/{路径}` | — | ✅ 返回 objects（含文件 id、name、size、type）+ `.data.parent`=该目录自身 id |
| 创建目录 | `PUT /api/v3/directory` | `{"path":"/目标目录"}` | ✅ 3.8.5 实测；`dst` 不存在时 aria2 也会自动建 |
| **URL 离线下载** | `POST /api/v3/aria2/url` | `{"url":[...], "dst":"/目标目录", "preferred_node":0}` | ✅ 提交成功（需 CSRF 头，不需要验证码）；响应**无 gid**，轮询反查 |
| 查下载中 | `GET /api/v3/aria2/downloading` | — | ✅ |
| 查已完成 | `GET /api/v3/aria2/finished?page=N` | — | ✅ 返回任务（gid、status、files、dst）；status 4=完成 5=失败 |
| **批量取直链** | `POST /api/v3/file/source` | `{"items":[文件id数组], "captchaCode":"..."}` | ✅ 3.8.5 起需带 captchaCode + CSRF 头；返回 `[{id,url,name}]`，直链格式 `https://pan.huang1111.cn/f/{code}/{文件名}` |
| 删除文件/目录 | `DELETE /api/v3/object` | `{"items":[文件id], "dirs":[目录id], "force":true}` | ✅ 需 CSRF 头；force 不绕过回收站（48h 自动清除） |

### 2.4 直链特性（实测）

- `/f/{code}/{文件名}` 是**稳定的公共直链**：无需登录即可访问
- 302 重定向到真实下载服务器（`download-sc1.huang1111.cn/api/v3/slave/source/...?sign=...`）
- 签名带时间戳，但入口 URL 长期有效（2026-04 上传的 1.3.2.7 直链 2026-08 仍可访问）
- 可直接写入 `data/down` JSON 长期使用——与现状一致

### 2.5 站点数据结构（data/down，需对齐）

以 FCL（软件 id 0）为例：

```jsonc
// data/down/0/index.json —— 版本列表
[
  { "name": "最后一个有Boat后端的版本", "nextUrl": "/data/down/0/boat.json", "description": "..." },  // 手动特殊条目
  { "name": "v1.3.2.8", "nextUrl": "/data/down/0/auto/2026/8/26/v1.3.2.8.json", "default": true },  // 默认=最新
  ...
]

// data/down/0/auto/2026/8/26/v1.3.2.8.json —— 单版本架构列表
[
  { "arch": "all", "url": "https://pan.huang1111.cn/f/2mzMC6/FCL-release-1.3.2.8-all.apk", "size": 325966879 },
  { "arch": "arm64-v8a", "url": "https://pan.huang1111.cn/f/z2mwtE/FCL-release-1.3.2.8-arm64-v8a.apk", "size": 172116300 },
  ...
]
```

- **自动生成（新格式）**：`auto/{年}/{月}/{日}/{版本名}.json`——年月日取 Release 发布时间转 UTC+8（不补零）；版本名保留 tag 原样（含前导 `v`/`V`），空白与非法文件名字符归一为 `_`
- **旧格式（历史保留，不再写入）**：`{段}/{段}/.../{段}.json`（由版本号按 `.` 拆段而来），解析器对旧格式保持兼容，新旧条目可共存
- `size`：文件字节数，来自 `GET /directory` 响应的 `objects[].size`；下载表格会通过 `formatBytes` 渲染为可读大小（`selectorView.js` 已支持）
- 现有手动维护的 JSON 无 size 字段（前端缺省显示空）；**自动生成的条目必须带 size**，与手动条目并存无冲突
- 旧格式 `nextUrl` 条目（如 `/data/down/0/1/3/2/7.json`）的 `entryVersionKey` 反解时会跳过 `auto` 命名空间首段，防止误判为巨大假版本

## 3. 架构设计

### 3.1 总体流水线（双 job 架构）

```
GHA workflow（每天 2 次：UTC+8 00:00 / 12:00，即 UTC 16:00 / 04:00）
  │
  ├─ 【probe job】——轻量预探测（必跑，~5s）
  │   ├─ checkout + setup-node 20
  │   └─ node probe.mjs
  │       · 读仓库已有 data/down/{id}/index.json 作基线
  │       · 拉 GitHub Releases（不读凭据、不动网盘、不跑 git）
  │       · 全量软件均已是最新 → 输出 needs_sync=false → sync job 不调度
  │
  └─ 【sync job】——重量同步（仅当 needs_sync=true 时调度）
      ├─ checkout + setup-python 3.11 + setup-node 20 + pip install OCR
      └─ node sync.mjs
          │
          ├─ ① 一次性登录 huang1111（跨软件复用 session）
          │     GET /site/captcha（OCR）+ GET /site/config 拿 CSRF + POST /user/session
          │
          ├─ ② 对每个有候选的软件：
          │     ├─ 从 probe 阶段已计算的 candidates 遍历（旧的先处理）
          │     ├─ 幂等检查：GET /directory/foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日} 已含全部文件则跳过下载
          │     ├─ 提交离线下载 POST /api/v3/aria2/url（带 X-CSRF-Token）
          │     │    {url: [各架构 assets 直链], dst: "foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}", preferred_node: 0}
          │     │    （dst 不存在会自动创建；脚本仍先 PUT /directory 兜底）
          │     ├─ 轮询：GET /aria2/finished?page=1 + GET /directory/{dst}
          │     │    （提交响应无 gid！按 dst+文件名判错 status==5 或目录出现文件判成功）
          │     └─ 失败重试：离线下载「提交+轮询」整段最多 3 次
          │
          ├─ ③ 对每个完成的新版本：
          │     ├─ GET /directory/foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日} 按文件名匹配拿文件 id + size
          │     └─ POST /file/source {items: [文件id...], captchaCode: "..."} 批量取直链
          │          （需带 captchaCode + 最新 X-CSRF-Token，验证码一次性 + OCR 误读率高 → 失败换新验证码重试，最多 10 次）
          │
          ├─ ④ 生成/更新仓库 JSON：
          │     ├─ 写 data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json（[{arch|name,url,size}]）
          │     │    url 来自直链、size 来自目录响应
          │     └─ 更新 data/down/{id}/index.json（保留手动条目、新版本降序插入、default 移到最新、重名跳过）
          │
          └─ ⑤ 分软件 git commit（固定消息格式，见 3.7）+ 全部完成后统一 push
```

**为什么分双 job？** 日常定时任务（多数时候无新 Release）只需跑 probe job（~5 秒），省掉 Python 3.11 安装、OCR 依赖 pip install、Node 20 重复安装、以及全部网盘操作。sync job 仅在有候选时才启动（container 都不拉起）。

### 3.2 触发与凭据

| 项 | 方案 |
|---|---|
| 触发 | workflow `auto-sync.yml`：`schedule` cron `0 4,16 * * *`（UTC）= UTC+8 每天 00:00 / 12:00（GHA cron 固定 UTC，故写 4,16）+ `workflow_dispatch` 手动触发；`concurrency` 防重入 |
| 登录凭据 | **账号密码方案（已确认）**：GHA secret `H1111_USER` / `H1111_PASSWORD`，仅在 sync job 中注入；probe job 完全不读凭据 |
| 验证码识别 | OCR（依赖包名在仓库中**不出现明文**，见 3.8）；识别结果大写+过滤非字母数字，期望长度 4；**验证码一次性**（同码重试必败）+ OCR 误读率约 50%（V/Y、6/B），失败必须**换新验证码**重试，登录/取直链均最多 10 次（实测稳定通过） |
| 登录失败处理 | 连续失败（验证码/CSRF/网络）→ workflow 失败（红色状态即告警），下次运行自动重试 |
| GitHub API | 使用 `GITHUB_TOKEN`（仓库默认，工作流自动注入），读取 releases 无需额外权限，并避免匿名限流 |

### 3.3 软件映射表（核心配置）

新增配置文件 `scripts/auto-sync/softwares.json`，每个软件一条。由于网盘目录统一为 `foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}/`，映射表**不需要任何网盘路径字段**：

```jsonc
{
  "softwareId": 0,                    // 站端软件 id（data/software.json），也是网盘目录 id
  "githubRepo": "FCL-Team/FoldCraftLauncher",
  "assetFilter": "\\.apk$",           // assets 名过滤正则（只保留 .apk）
  "mode": "arch",                     // arch=按架构出条目；name=按文件名出条目（如 Amethyst 的 Amethyst/Debug）
  "archNames": ["all","arm64-v8a","armeabi-v7a","x86","x86_64"],  // arch 模式的架构列表（也是输出顺序）
  "fallbackArch": null,               // 无法按后缀识别架构时的兜底架构（Zalith2 的 all 包无后缀，填 "all"）
  "includePrerelease": false          // 是否包含 prerelease 版本
}
```

- **当前映射**：0（FCL）/ 3（Zalith2）/ 4（Amethyst）/ 16（Acode）
- 网盘目标目录由脚本按 `foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}/` 自动拼接，无需配置

### 3.4 版本路径映射（日期归档）

- **网盘侧**（脚本读写）：`foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}/`，按 Release 发布时间 UTC+8 归档
- **站端侧**（data/down）：`data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json`，同一条日期路径，但版本名作为文件名
- 两边日期路径一致，同一天的不同版本归到同一目录下（如 `2026/8/26` 下可能有多个版本的 `.json`）
- **版本名归一化**（`versionFromTag`）：
  - 保留前导 `v`/`V` 原样（`v1.3.2.8` → `v1.3.2.8`，`V2.4.9_hotfix1` → `V2.4.9_hotfix1`）
  - 空白与非法文件名字符（`\ / : * ? " < > |`）归一为 `_`
  - 连续点塌缩为一点，去首尾点（避免隐藏文件）
- **旧格式兼容**：`data/down/{id}/{段}/{段}/.../{段}.json` 的旧条目通过 `entryVersionKey` 反解时，`auto` 首段会被排除，防止 `auto/2026/8/26.json` 这种不完整路径被误判为巨大假版本

### 3.5 JSON 生成规则

- **版本文件**：`data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json`，内容按 mode 区分：
  - `arch` 模式：`[{arch, url, size}, ...]`，按 `archNames` 顺序输出
  - `name` 模式：`[{name, url, size}, ...]`，按文件名排序输出（如 Amethyst / Amethyst-Debug）
  - `url` 用 `/file/source` 返回的直链；`size` 用同一次 `GET /directory` 响应对应文件的 `size`（字节数）
  - `nextUrl` 写入 index.json 时以 `/` 开头：`/data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json`
- **index.json**：
  - 保留所有现有条目（含 boat.json、自定义描述、共存版等手动条目，原样透传）
  - 新版本按版本号降序插入（复用 `lib.mjs` 的 `compareVersionsDescending` 逻辑，与前端 `js/adapters/download/common.js` 一致）
  - `default: true`：若原有条目已有 default 标记 → 移到最高版本，原 default 条目去掉；若原无 default（如 id3/id4）→ 不新增，保持现状
  - 若新版本名与已有条目重名 → 跳过（视为已同步）
  - 版本条目永远排在手动条目之后
- **写入格式**：与现有文件保持一致（2 空格缩进、UTF-8、无 BOM、无末尾换行）

### 3.6 目录/文件结构

```
.github/workflows/auto-sync.yml      -- 双 job（probe + sync），probe 输出 needs_sync 条件化 sync
scripts/auto-sync/
  lib.mjs                           -- 纯函数 + 共享状态（版本比较/归一化、数据源基线、GitHub Releases 拉取、资产映射、日志 ctx）
  probe.mjs                         -- 预探测（只读，不登录、不动网盘、不跑 git）
  sync.mjs                          -- 主流程（一次性登录 → 离线下载 → 直链 → 写 JSON → 分软件提交 → push）
  softwares.json                    -- 软件映射表（0/3/4/16）
  h1api.mjs                         -- huang1111 API 封装（captcha/config/session/directory/aria2/source）
  config.mjs                        -- 环境变量（H1111_USER/H1111_PASSWORD/H1111_HOST/GITHUB_TOKEN）与重试常量
  ocr_helper.py                     -- 验证码 OCR 子进程助手（依赖包名十六进制混淆，仓库无明文）
scripts/auto-sync/README.md          -- 使用/维护说明（secret 配置、手动触发、故障排查）
```

脚本用 Node.js 编写（仓库无构建步骤，Node 与前端生态一致）；CI 环境用 `actions/setup-node` + 无依赖脚本（用原生 `fetch`，Node 18+），避免 npm install 开销；OCR 依赖仅 sync job 运行时安装（包名由 hex 还原，见 3.8）。`lib.mjs` 是 probe.mjs 和 sync.mjs 的共享纯函数库，避免重复实现。

### 3.7 提交格式（用户确认）

- **每软件一个 commit**；无变更不提交；全部完成后统一 push
- 主题固定格式：`[GHA] 新增：内容：数据源：资源id-{id}：{版本列表&分隔}呜~`
  - 版本列表 = 本次同步的全部新版本，按版本号降序用 `&` 连接（如 `1.3.2.7&1.3.2.8`）；仅一个版本时直接写版本号
- 正文（日志）：本次该软件检测/下载/直链/JSON 的逐条详细日志
- 起始 `[GHA]` 与 updata-verInfo.yml 的防重入判断（`^\[GHA\]` 跳过）天然兼容，两个工作流不会互相触发死循环

### 3.8 OCR 依赖包名混淆（防站长针对性升级）

- `ocr_helper.py` 中依赖**包名不出现明文**，以十六进制编码给出（`bytes.fromhex` 运行时还原）
- GHA 安装步骤同样用十六进制还原包名后 `pip install`（仓库内无明文）
- 本地开发用的明文版助手在仓库外（`huang1111-api-test/ocr_helper.py`），不入库

## 4. 错误处理与恢复

**重试策略（用户确认，config.mjs 常量）**：

| 场景 | 策略 |
|---|---|
| 验证码类失败（登录、取直链） | 每次换新验证码，最多 10 次尝试（OCR 长度≠4 直接换图，不浪费 POST） |
| 离线下载失败（提交/轮询/任务错误） | 整段「提交+轮询」最多 3 次；超时默认 20 分钟/次（`AUTO_SYNC_DOWNLOAD_TIMEOUT_MS` 可调） |
| 其他任何失败（网络/HTTP/接口异常） | 最多 2 次尝试 |

| 场景 | 处理 |
|---|---|
| probe job 失败 | 若全部软件探测失败（overallFailed=true）→ 输出 `needs_sync=true`（宁可多跑一次同步 job，也不遗漏）；若单个软件探测失败但其他有候选 → 照常触发 sync job |
| 登录失败（验证码识别错/CSRF 轮换/网络） | 内部按上表重试；仍失败 → 该软件标记失败，运行结束退出码非 0 → workflow 失败（Actions 页面红色即告警），下次运行自动重试 |
| 离线下载失败（GitHub 被墙/超时） | 轮询 `finished.status==5`/`error` 判失败；本版本跳过（不写 JSON），继续处理其余版本，退出码非 0；下次运行重试 |
| 会话过期（API 返回 401） | 单次运行只在开始时建立会话；若中途失效会以错误形式暴露，下次运行自动重登（当前版本不自动重登，属已知边界） |
| 直链获取失败（多为验证码 OCR 误读） | 换新验证码最多 10 次；仍失败 → 该版本标记失败、跳过写 JSON、下次运行重试 |
| 下载到一半用户手动删除 | 目录查询拿不到期望文件 → 轮询超时判失败，重试提交 |
| 同版本重复触发 | 以仓库已有 index.json 为基线去重（重名跳过）；离线下载前先查 `foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}` 目录，已含全部文件则跳过下载 |
| 手动条目冲突 | 脚本只增不删 index.json 条目；手动条目（boat 等）原样透传 |
| GHA 运行超时 | probe job `timeout-minutes: 10`；sync job `timeout-minutes: 90`；单版本下载超时时长 20 分钟/次；未完成的版本下次运行续跑（落后检测天然续跑点） |

## 5. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| huang1111 API 是逆向产物，非官方文档化，可能变更 | 中 | 所有调用集中 `h1api.mjs` 一处，变更时只改封装；仓库记录 API 验证快照（`docs/huang1111-api-notes.md`，3.8.5 已重测通过） |
| 登录凭据在 Actions secret 中明文存储 | 中 | secret 权限最小化（仓库级 Actions secret）；账号密码可随时在网盘端改密作废；文档警示 |
| 验证码 OCR 失败率 | 低 | 上限 10 次换新验证码重试兜底（登录/取直链实测 1~2 次即中，偶发多拖几次）；持续失败触发告警 |
| 离线下载依赖网盘服务器访问 GitHub 的连通性 | 中 | 已验证可用；失败重试；必要时可配置 GitHub 直链代理前缀 |
| GHA 每分钟 60 次 API 限制 | 低 | 调用量极小（每软件 1 次 releases + 少量 aria2/source） |
| 站端 JSON 结构被脚本改坏 | 低 | 生成后本地校验（JSON 可解析、URL 均为 `pan.huang1111.cn/f/` 前缀、index 与版本文件一致），校验不过不提交 |

## 6. 实施进度（2026-08-26 更新）

1. ✅ 搭骨架：`scripts/auto-sync/` + `h1api.mjs` + `config.mjs` + `ocr_helper.py`
2. ✅ 映射表初版：0/3/4 三个标准结构软件
3. ✅ FCL 试点全链路（本地真实运行验证）
4. ✅ 日期归档替代逐位拆分（路径改为 `auto/{年}/{月}/{日}/{版本名}.json`）
5. ✅ 双 job 预探测架构（probe job 无候选时跳过 sync job，省掉 Python/OCR 安装）
6. ✅ `lib.mjs` 纯函数抽取 + `probe.mjs` 独立预探测脚本
7. ✅ GHA 接入：`auto-sync.yml` 改造为双 job + secret 配置
8. 扩展到其余软件（7/8/9/10/11/12/14 特殊结构）：待评估其 index/版本文件结构后补映射表
9. 试运行观察：GHA 上线后 1-2 周观察真实发布场景，确认无误后交接

## 7. 验收标准

- 某软件发布新版本后，无需人工干预，仓库自动出现对应 `data/down` JSON（含直链），且站点页面可正常显示新版本并可下载
- 自动生成的版本文件条目**带 `size` 字段**，下载表格正确显示文件大小（`formatBytes` 渲染）
- 手动特殊条目（boat.json、共存版、自定义描述）在自动更新后保持不变
- 站端无任何代码改动（software.json、detail.json、mirror.json、adapter、controller、view 均不动；仅 data/down 目录由脚本写）
- 失败场景（登录失败、下载失败）有明确标记（workflow 失败/非 0 退出），且不产生错误提交

## 8. 待确认/遗留事项

- [x] 登录失败告警渠道 → 采用 **workflow 失败即告警**（Actions 红色状态；无需额外通知渠道）
- [x] 单次运行新版本处理上限 → 不设上限（按用户要求"落后全部下载"；GHA sync job 90 分钟超时兜底）
- [x] 共存版/特殊版半自动机制 → 初版不做；手动条目原样透传不受影响
- [x] 历史版本是否保持不动 → 保持不动，仅新增同步
- [x] 日期归档 + 双 job 预探测 → 已实施（2026-08-26）
- [x] GHA secret 配置（`H1111_USER`/`H1111_PASSWORD`）需站长在仓库 Settings → Secrets 手动添加（脚本与 workflow 已就绪）
- [ ] 后续扩软件：为 7（Pojav，子目录结构）、12（name+children）、14 等补映射表配置
- [ ] OCR 依赖包名混淆是否足够（当前为十六进制编码；若担心被扫描可升级为更复杂的运行时拼装）
