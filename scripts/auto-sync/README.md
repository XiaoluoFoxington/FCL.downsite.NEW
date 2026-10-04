# 线路1 自动同步（auto-sync）

把「GitHub Releases → huang1111 网盘离线下载 → 直链 → 站端 `data/down` JSON → 提交」全链路自动化，跑在 GitHub Actions 上。站端前端无需改动（下载节点按 `nextUrl` 惰性加载，对目录结构透明）。

> 详细设计见 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md)，API 实测依据见 [`docs/huang1111-api-notes.md`](../../docs/huang1111-api-notes.md)。
> 本目录内 `.mjs` 为 Node 原生 ESM（无需 npm install）。各文件的职责以其文件头注释为准。

## 职责速览

- `sync.mjs`：主流程（检测 → 离线下载 → 直链 → 写 JSON → 分软件提交 → push）
- `probe.mjs`：预探测（只读，无候选时跳过 sync job）
- `lib.mjs`：纯函数与共享状态
- `h1api.mjs`：huang1111 API 封装（含新版验证链路与 PoW 求解）
- `log.mjs`：统一分层日志（唯一日志出口：分级缩进、GHA 折叠/注解、运行概览汇总）
- `config.mjs`：环境变量与常量（**改配置看这里**）
- `softwares.json`：软件映射表（**有哪些软件看这里**）

## 触发

- **定时**：由工作流的 `schedule` 决定（cron 按 UTC 编写，时间点见 `.github/workflows/auto-sync.yml`）
- **手动**：GitHub 仓库 Actions 页 → `线路1自动同步` → `Run workflow`（可临时改时间/直接验证）

## 凭据（Secrets）

仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 说明 |
|---|---|
| `H1111_USER` | huang1111 登录账号 |
| `H1111_PASSWORD` | huang1111 登录密码 |

> `OCR_PKG_NAME` / `OCR_CLS_NAME` 已废弃（站点图形验证码通路下线），可从仓库删除。

凭据只存 GitHub，脚本只从环境变量读取，仓库内永不落盘。

## 本地手动运行（调试用）

```powershell
# 只跑预探测（不读凭据、不动网盘）
node scripts/auto-sync/probe.mjs

# 完整同步（需要凭据）
$env:H1111_USER = '你的账号'
$env:H1111_PASSWORD = '你的密码'
node scripts/auto-sync/sync.mjs
```

可用的环境变量、默认值与重试常量统一在 [`config.mjs`](config.mjs) 中定义，以其为准。

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
- 站点要求**交互式验证**（滑块等）时直接报错，不静默重试

> ⚠️ 两个必须遵守的前置条件（详见 [`docs/huang1111-api-notes.md`](../../docs/huang1111-api-notes.md) §0.3）：
> 1. 所有请求都要带 `X-Cloudreve-Captcha-Protocol: 2`，否则一律 `41709`「请更新页面后使用新版验证」
> 2. 必须携带**全部 cookie**（`cloudreve-session` + `cloudreve_observer` + `cloudreve_send`）。
>    只带 `cloudreve-session` 时 `POST /site/captcha/policy` 恒返回 `41701` —— 旧文档「observer 非必需」已失效。

任一步耗尽后：该版本跳过（不写 JSON），其余版本继续；存在失败项时进程以非 0 退出，GHA 显示红色即告警，下次运行自动补。

## 提交格式（每软件一个 commit）

```
[GHA] 新增：内容：数据源：资源id-{id}：{版本1&版本2&...}呜~
（空行）
{本次该软件的详细日志}
```

- 主题以 `[GHA]` 开头，与 `updata-verInfo.yml` 的防重入判断兼容，不会互相触发
- 正文（本次该软件的详细日志）由统一日志模块的**作用域捕获**生成（`log.capture`），只含该软件同步期间的分级日志（版本、下载、直链、清理等）
- 每次运行的**概览**（逐软件结果表 + 总计）写入 `$GITHUB_STEP_SUMMARY`；详细日志只留在运行日志里，不重复进汇总

## 新增/维护软件

1. 打开 [`softwares.json`](softwares.json)，按现有条目格式追加一行（各字段含义见字段名本身与 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md)）。
2. 确认 `githubRepo`、`mode`（`arch` 按架构出条目 / `name` 按文件名出条目）、资产过滤与兜底架构。
3. 特殊结构（子目录 wrapper、`{name, children}` 内联等）初版**不纳入自动同步**，index.json 手动条目原样透传；其中 `{name, children}` 形态若 `name` 能解析出版本号（如 `v1.0.2`）会参与统一排序，解析不出的需加 `"pinned": true` 才会稳定置顶。

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| Actions 运行失败（红色） | 查看该次运行的 `::error::` 注解（GHA 会在对应日志行标红）与上方分级日志：登录失败 / 某版本下载失败 / 直链失败，均会输出中文原因；下次运行自动重试 |
| 某版本一直失败 | 本地手动跑一次看完整过程日志；常见：GitHub 资产命名变化（改 `softwares.json`）、PoW 链路重试耗尽（偶发，重跑） |
| index.json 顺序乱了 | 置顶条目必须是 `"pinned": true`；手写 `{name, children}` 条目的版本号要能从 `name` 解析（如 `v1.0.2`）。其余版本条目按版本降序自动排列 |
| 日志报 `41709 请更新页面后使用新版验证` | 请求缺 `X-Cloudreve-Captcha-Protocol: 2` 头，或站点又升了协议版本 —— 查 `h1api.mjs` 的 `CAPTCHA_PROTOCOL` |
| 日志报 `41701 验证失败，请重试` | 提交 `POST /site/captcha/policy` 时 cookie 不全。必须带 `cloudreve-session` + `cloudreve_observer` + `cloudreve_send` 全部 cookie |
| 日志报「站点要求交互式验证」 | 站点给该 purpose 开了滑块/点选（`required.interactive > 0`），脚本无法自动完成，需人工处理 |
| 日志报 `41702` 限流 | 已按 `retry_after` 自动退避；若频繁出现说明触发频率限制，需拉长定时任务间隔 |
| 日志出现 `[PoW] 求解中… N/5000（Ns）` | 正常。求解为单线程逐 counter 试算，耗时数十秒，进度日志每 5s 一条（仅在间隔到达时输出），不是卡死 |

> 怀疑站点又改了验证机制时，先跑项目外测试目录的 `_probe-v2-protocol.mjs` 确认（路径与用法见 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md) 开头）。

## 已知边界

- 软件映射见 [`softwares.json`](softwares.json)；其余软件待后续扩展映射表
- 单次运行中途若会话过期（401）不做自动重登（下次运行重新登录）；其余均在约定重试策略内自动恢复
- 自动版本条目带 `size` 字段（前端 `formatBytes` 显示），手动旧条目无 `size` 不影响
