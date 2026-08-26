# 线路1 自动同步（auto-sync）

把「GitHub Releases → huang1111 网盘离线下载 → 直链 → 站端 `data/down` JSON → 提交」全链路自动化，跑在 GitHub Actions 上。站端前端无需改动（下载节点按 `nextUrl` 惰性加载，对目录结构透明）。

> 详细设计见 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md)，API 实测依据见 [`docs/huang1111-api-notes.md`](../../docs/huang1111-api-notes.md)。
> 本目录内 `.mjs` 为 Node 20+ 原生 ESM（无需 npm install），`.py` 为 OCR 子进程助手。

## 目录结构

```
auto-sync/
  lib.mjs           纯函数 + 共享状态（版本比较/解析、数据源基线、GitHub Releases 拉取、资产映射）
  probe.mjs         预探测（只读 GitHub Releases + index.json，无候选跳过 sync job）
  sync.mjs          主流程：检测 → 离线下载 → 直链 → 写 JSON → 分软件提交 → push
  h1api.mjs         huang1111 API 封装（登录/CSRF/验证码/目录/离线下载/直链 + 重试策略）
  config.mjs        环境变量与重试常量
  softwares.json    软件映射表（当前：0=FCL、3=Zalith2、4=Amethyst、16=Acode）
  ocr_helper.py     验证码 OCR 助手（依赖包名仓库内无明文，见下文）
```

## 触发

- **定时**：UTC+8 每天 `00:00` 与 `12:00`（GHA 的 cron 按 UTC 写：`0 4,16 * * *`）
- **手动**：GitHub 仓库 Actions 页 → `线路1自动同步` → `Run workflow`（可临时改时间/直接验证）

## 凭据（Secrets）

仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 值 |
|---|---|
| `H1111_USER` | huang1111 登录账号 |
| `H1111_PASSWORD` | huang1111 登录密码 |

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

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `H1111_HOST` | `https://pan.huang1111.cn` | 网盘 API 源（一般不用改） |
| `AUTO_SYNC_DOWNLOAD_TIMEOUT_MS` | `1200000`（20 分钟） | 单版本离线下载轮询上限 |
| `GITHUB_TOKEN` | 无 | 本地一般不需要；GHA 自动注入 |

## 数据结构（站内 `data/down/{id}/`）

- **自动生成（新格式）**：`auto/{年}/{月}/{日}/{版本名}.json` —— 年月日取 Release 发布时间转 UTC+8（不补零）；版本名保留 tag 原样（含前导 `v`/`V`），空白与非法文件名字符归一为 `_`。网盘侧对应 `foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}/`。
- **旧格式（历史保留，不再写入）**：`{段}/{段}/.../{段}.json`（由版本号按 `.` 拆段而来），解析器对旧格式保持兼容，新旧条目可共存。
- **手动条目**：index.json 中无版本路径的条目（如 `boat`）原样透传，永远排在版本条目之前。
- index.json 的版本条目按版本降序；带 `default: true` 的标记自动只保留在最新版本上。

## GHA 双 job 架构

```
probe job（轻量，必跑）          sync job（重量，按需跑）
├─ checkout                    ├─ checkout
├─ setup-node 20               ├─ setup-python 3.11
└─ node probe.mjs              ├─ setup-node 20
   （拉 GitHub Releases +     ├─ pip install OCR 依赖
    读本地 index.json 做基线） └─ node sync.mjs
   输出 needs_sync=true/false    （离线下载 → 直链 → 写 JSON → 提交 → push）
         ↓
   needs.probe.outputs.needs_sync == 'true'
         ↓
   ─── sync job 才被调度 ───
```

- 无候选时 probe job 直接输出 `needs_sync=false`，**sync job 完全不启动**（省掉 Python/Node/OCR 安装 + 全部网盘操作）
- probe job 不读 `H1111_USER`/`H1111_PASSWORD`，凭据只在 sync job 中使用
- 异常时 probe 默认输出 `needs_sync=true`（宁可多跑一次，也不遗漏）

## 检测逻辑

1. 读 `data/down/{id}/index.json` 找**数据源内最新版本**
2. 数据源**没有**版本 → 只取 GitHub Release 最新一个
3. 数据源**有**版本 → 落后 Release 多少版本，把落后的**全部**下载（旧的先处理）

## 重试策略

| 类型 | 次数 |
|---|---|
| 验证码类失败（登录、取直链） | 最多 10 次尝试，每次换新验证码 |
| 离线下载失败 | 最多 3 次「提交 + 轮询」 |
| 其他任何失败 | 最多 2 次尝试 |

任一步耗尽后：该版本跳过（不写 JSON），其余版本继续；存在失败项时进程以非 0 退出，GHA 显示红色即告警，下次运行自动补。

## 提交格式（每软件一个 commit）

```
[GHA] 新增：内容：数据源：资源id-{id}：{版本1&版本2&...}呜~
（空行）
{本次该软件的详细日志}
```

- 版本范围示例：`1.3.2.7-1.3.2.8`（数据源原最新 → 新最新）；原本无版本则只写新版本号
- 主题以 `[GHA]` 开头，与 `updata-verInfo.yml` 的防重入判断兼容，不会互相触发

## OCR 依赖安装（GHA 自动执行）

OCR 依赖的**包名不在仓库出现明文**（防止网盘站长扫描仓库后针对性升级验证码）：

- `ocr_helper.py` 内通过十六进制编码还原包名/类名（`bytes.fromhex(...)` 运行时解码）
- GHA workflow 安装步骤同样用十六进制还原包名后 `pip install`
- 如需手动安装（本地开发），运行环境按同法还原包名安装即可；明文版助手只在仓库外（`huang1111-api-test/ocr_helper.py`）

## 新增/维护软件

1. 打开 `softwares.json`，按现有条目格式追加一行
2. 三处确认：
   - `githubRepo`：GitHub 仓库（`owner/repo`）
   - `mode`：`arch`（资产名带架构后缀，如 `-arm64-v8a.apk`）或 `name`（资产名即条目名，如 Amethyst/Debug）
   - 资产是否只有 `.apk` 需要（改 `assetFilter`），Zalith2 式"all 包无架构后缀"需配 `fallbackArch: "all"`
3. 特殊结构（子目录 wrapper、name+children 内联、boat.json 共存版等）初版**不纳入**，index.json 手动条目原样透传

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| Actions 运行失败（红色） | 查看该次运行日志：登录失败 / 某版本下载失败 / 直链失败，均会输出中文原因；下次运行自动重试 |
| 某版本一直失败 | 本地手动跑一次看完整日志；常见：GitHub 资产命名变化（改映射表）、验证码 10 次全错（偶发，重跑） |
| index.json 顺序乱了 | 手动条目（boat 等）永远排在版本条目之前，版本条目按版本降序；确认数据源 JSON 未被外部改动破坏 |
| OCR 报错 | 检查运行环境是否安装了 OCR 依赖（GHA 自动装；本地手动装需还原包名） |

## 已知边界

- 软件映射见 `softwares.json`（当前：0=FCL、3=Zalith2、4=Amethyst、16=Acode）；其余软件待后续扩展映射表
- 单次运行中途若会话过期（401）不做自动重登（下次运行重新登录）；其余均在约定重试策略内自动恢复
- 自动版本条目带 `size` 字段（前端 `formatBytes` 显示），手动旧条目无 `size` 不影响