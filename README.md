# XiaoluoFoxington/FCL.downsite.NEW

## 项目简介

![fdn-preview](media/img/fdn-preview/fdn-preview.png)

[《Fold Craft Launcher》](https://github.com/FCL-Team/FoldCraftLauncher)（以下简称"FCL"）非官方公益下载站，由玩家社群自发搭建。

除了 FCL，此站还收录了诸多启动器、渲染器、插件、JRE 等资源，旨在帮助玩家在 Android 设备上更便捷地游玩《Minecraft: Java Edition》。如你所见，这是一个纯静态网站，无需后端，可部署在任何静态文件服务器上。

把名字改一下，可以完全拿来当软件资源站模板用[doge]。

这是下载站的第 4 次重制。旧版本存档如下，不再维护：

- 第 3 次重制：[XiaoluoFoxington/FCL.website.NEXT](https://github.com/XiaoluoFoxington/FCL.website.NEXT)
- 第 2 次重制：[XiaoluoFoxington/FCL.website.mdui](https://github.com/XiaoluoFoxington/FCL.website.mdui)
- 第 1 次重制：[fcl-docs/FCL.website](https://github.com/fcl-docs/FCL.website)

## 站点特色

- 烂大街的 MDUI，但是是 MD1。那 MD3 是真丑吧，大圆角、没阴影，反正我是不喜欢。
- 能跑就行的 JS，不报错就算成功，还有 AI 随机拉大便。
- 随意命名的函数和变量，自己都看不懂。
- 不务正业地塞彩蛋，正事反而往后排。
- 无任何框架，纯原生 HTML/CSS/JS，返璞归真。

## 技术栈

| 层面 | 选型 |
| --- | --- |
| 样式 | MDUI + 自制主题增强 + 补丁 + RTL 适配 |
| 图标 | Material Icons（不用 MDUI 自带那套，太旧） |
| 脚本 | 原生 JavaScript（ES Module） |
| 构建 | 无（纯静态，所见即所得） |
| 部署 | 任意静态文件服务器 |
| 自动更新 | GitHub Actions |

> 具体依赖库及其版本以 [`data/usedProj.json`](data/usedProj.json) 为准。

## 国际化（i18n）

- 支持多语言，入口在右侧抽屉的“网站设置”→“语言设置”独立页面（`html/language.html`）。
- 语言设置页以可排序列表管理语言顺序：第一位为界面显示语言，其余语言在翻译缺失时按列表顺序依次回退。
- 文案集中维护在 `js/i18n/`（`zh-CN` 为基准），静态页面通过 `data-i18n` 属性标记，动态文案通过 `t()` 函数获取。
- 翻译键缺失时自动回退到另一种语言，再回退到键本身，任何异常都不会影响页面可用性。
- RTL 语言会切换 `<html dir="rtl">`，由 `css/rtl.css` 镜像关键布局。
- 数据源内容翻译约定：
  - 短文本（设置项、标签、线路名、详情页消息、贡献者与开源项目描述等）统一放在语言包中，按稳定 ID/序号寻址；
  - 长文档（公告、软件介绍页）按语言后缀存放文件，加载时优先当前语言，缺失时回退中文原文件；
  - 数据源本身保持单一语言不变，未收录的键自动回退原文。

当前支持的语言、翻译键与文件布局见 [`js/common/i18n.js`](js/common/i18n.js)；完整的 API 参考、DOM 用法与维护指南见 [docs/i18n.md](docs/i18n.md)。

## 项目结构

```
index.html / 404.html   页面宿主
data/                   数据源（软件、标签、线路、设置、公告、下载数据等）
html/                   子页面模板（列表、详情、下载、介绍、版本历史、设置等）
css/                    样式与主题补丁
js/                     脚本（页面入口 + common / controllers / domain / http /
                        repositories / security / views / adapters / i18n）
media/                  静态资源（图片、字体、音效）
scripts/auto-sync/      线路1 自动同步脚本（GitHub Actions 调用）
docs/                   开发文档
.github/workflows/      GitHub Actions 工作流
```

各目录下的具体文件以仓库实际内容为准；关键数据源与模块职责见下文说明，自动化流程见 [docs/auto-sync-design.md](docs/auto-sync-design.md)。

## 架构说明

代码采用分层思路，虽然写得很随意，但好歹有个架子：

- **`repositories/`** 负责从网络或本地获取数据，返回原始数据。
- **`controllers/`** 负责处理业务逻辑，管理页面状态。
- **`views/`** 只负责往 DOM 里塞东西，不干别的。
- **`domain/`** 放纯数据模型与逻辑（收藏、偏好、系统信息、自动选择等），不碰 DOM、不发请求。
- **`common.js`** 是每页共用的入口，统一 import 国际化、主题、抽屉、水印等通用模块；各页面入口只处理该页独有逻辑。
- **`http/client.js`** 统一处理请求、超时、取消、错误和页面内缓存。
- **`security/content.js`** 是所有远程 HTML/Markdown 进 DOM 前的安全边界（marked + DOMPurify 懒加载 + SRI）。
- **`adapters/download/`** 每个文件只适配一种下载源的数据结构，最终统一输出 `name`、`version`、`architecture`、`size`、`description`、`downloadUrl`、`available` 和 `source`。路由键是 `data/mirror.json` 的 `apiVer`，未登记协议回退 `plain` 适配器。

## 收录资源

此站收录的软件与标签体系分别见 [`data/software.json`](data/software.json) 与 [`data/tag.json`](data/tag.json)，涵盖启动器、渲染器、驱动器、插件、JRE、工具等类型与 Android、Windows、Linux、HarmonyOS、macOS 等平台。

## 自动更新（线路1）

线路1（站长提供的 huang1111 网盘）由 GitHub Actions 全自动维护：

- **工作流**：`.github/workflows/auto-sync.yml`，采用 **probe + sync 双 job** 架构——probe 只读探测 GitHub Releases，无候选时直接跳过重量级的 sync job。
- **脚本**：`scripts/auto-sync/`（Node 原生 ESM，无需 `npm install`），完成「GitHub Releases → 网盘离线下载 → 取直链 → 生成 JSON → 分软件提交」。
- **数据落点**：`data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json`，与历史手动数据共存。

触发时间、凭据与脚本配置以工作流和脚本内配置为准。设计细节见 [docs/auto-sync-design.md](docs/auto-sync-design.md)，脚本用法见 [scripts/auto-sync/README.md](scripts/auto-sync/README.md)，网盘 API 依据见 [docs/huang1111-api-notes.md](docs/huang1111-api-notes.md)。

另有 `.github/workflows/updata-verInfo.yml` 负责刷新 `verInfo.json`（Git Hash）与 `sitemap.xml`。

## 新增下载线路

1. 若新线路使用**已有数据结构**，只需在 `data/mirror.json` 添加镜像条目（填好 `baseUrl`、`apiVer` 等），并在对应软件详情的 `download` 字段中引用。
2. 若数据结构不同，在 `js/adapters/download/` 下新增一个纯函数适配器文件，然后在 `import` 与注册表中登记对应的 `apiVer`。
3. 适配器仅做数据转换，不得发起网络请求或操作 DOM。额外接口请求放在 repository 中，页面交互和取消逻辑放在 controller 中。

## 开发与贡献

- 此站是静态站点，无需构建工具，修改后直接刷新浏览器即可。
- 提交 PR 前请确保代码风格一致（虽然本来也没什么风格可言）。
- 若发现 Bug 或有功能建议，欢迎提交 [Issue](https://github.com/XiaoluoFoxington/FCL.downsite.NEW/issues/new) 或通过 [腾讯问卷](https://wj.qq.com/s2/27273825/b7f1/) 反馈。

## 文档索引

- [docs/i18n.md](docs/i18n.md) —— 国际化模块的 API、用法与维护指南
- [docs/auto-sync-design.md](docs/auto-sync-design.md) —— 线路1 自动同步设计方案
- [docs/huang1111-api-notes.md](docs/huang1111-api-notes.md) —— huang1111 网盘 API 逆向笔记
- [scripts/auto-sync/README.md](scripts/auto-sync/README.md) —— 自动同步脚本使用说明
- [AGENTS.md](AGENTS.md) —— AI 助手在本项目的工作约定

## 免责声明

此站并非 Minecraft 官方网站，亦非任何启动器的官方网站。此站与 Mojang、微软及各启动器开发者均无隶属关系。此站仅为公益性质的资源整合与分享站点，旨在为普通玩家提供便捷的下载服务。
