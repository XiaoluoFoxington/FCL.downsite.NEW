# Code Wiki —— FCL.downsite.NEW 代码库文档

> 《Fold Craft Launcher》（FCL）非官方公益下载站，**纯静态多页网站**（原生 JavaScript + ES Module + MDUI），无构建步骤、无后端、无框架。
> 本文档基于仓库当前代码整理，覆盖整体架构、模块职责、关键函数、依赖关系与运行方式。
> 与之互补的专项文档：[i18n.md](i18n.md)、[auto-sync-design.md](auto-sync-design.md)、[huang1111-api-notes.md](huang1111-api-notes.md)、[../scripts/auto-sync/README.md](../scripts/auto-sync/README.md)。

---

## 目录

1. [项目概览](#1-项目概览)
2. [运行方式](#2-运行方式)
3. [整体架构](#3-整体架构)
4. [目录结构](#4-目录结构)
5. [页面清单与入口机制](#5-页面清单与入口机制)
6. [核心运行时模块](#6-核心运行时模块)
7. [分层业务模块](#7-分层业务模块)
8. [关键函数速查表](#8-关键函数速查表)
9. [数据源（data/）](#9-数据源data)
10. [样式与静态资源](#10-样式与静态资源)
11. [依赖关系](#11-依赖关系)
12. [自动化：GitHub Actions 与线路1自动同步](#12-自动化github-actions-与线路1自动同步)
13. [工程约定与注意事项](#13-工程约定与注意事项)

---

## 1. 项目概览

| 项 | 内容 |
| --- | --- |
| 项目性质 | 纯静态资源下载站（MPA 多页应用），可部署在任意静态文件服务器 |
| 前端技术 | 原生 JavaScript（ES Module）、MDUI 1.0.2（Material Design 1）、自制 CSS 补丁 |
| 构建 | **无**（所见即所得，改完刷新浏览器即可） |
| 后端 | **无**，所有数据为仓库内 JSON/HTML 数据源 + 外部镜像 API |
| 规模 | `js/` 约 12.7k 行（含 7 个语言包）；`scripts/auto-sync/` 约 3.3k 行 Node 脚本 |
| 语言 | 7 种：`zh-CN`（基准）、`en-US`、`ja-JP`、`fr-FR`、`ru-RU`、`ar`（RTL）、`es-ES` |
| 自动化 | GitHub Actions × 2（线路1自动同步、verInfo/sitemap 刷新） |

**核心业务**：展示软件资源列表（启动器、渲染器、插件、JRE 等）→ 详情页 → 下载页（多线路选择、按架构/系统自动推荐）→ 直链下载。

---

## 2. 运行方式

### 2.1 本地预览站点（日常开发）

无需安装依赖、无需构建，但 **ES Module 必须经 HTTP 加载**（不能直接 `file://` 打开）：

```bash
# 任选其一，在仓库根目录 /workspace 启动静态服务器
python3 -m http.server 8000
npx serve .
php -S localhost:8000
```

然后访问 `http://localhost:8000/`。修改 HTML/CSS/JS/JSON 后直接刷新浏览器即可生效。

### 2.2 线上部署

推送到任意静态文件服务器 / GitHub Pages / CDN 即可，无任何构建产物。搜索引擎相关文件已内置：`robots.txt`、`sitemap.xml`、`BingSiteAuth.xml`、`404.html`。

### 2.3 运行自动同步脚本（Node）

`scripts/auto-sync/` 为 **Node 原生 ESM（`.mjs`），无需 `npm install`**；CI 使用 Node 24（本地建议 ≥ 20）。

```bash
node scripts/auto-sync/probe.mjs                 # 预探测：比对数据源与 GitHub Releases（不需凭据）
node scripts/auto-sync/check-session.mjs         # 会话 cookie 只读验活（需 H1111_SESSION）
node scripts/auto-sync/sync.mjs                  # 完整同步（必需环境变量 H1111_SESSION）
node scripts/auto-sync/tools/refresh-session.mjs # 会话续期/更新辅助
```

```bash
# 环境变量（见 scripts/auto-sync/config.mjs 的 ENV）
export H1111_SESSION=xxx        # 必需：huang1111 网盘会话 cookie（cloudreve-session，实测 60 天有效）
export H1111_USER=...           # 可选：账号密码回退（登录已改为交互式验证，基本不可用）
export H1111_PASSWORD=...
export GITHUB_TOKEN=...         # 可选：拉取 GitHub Releases（匿名额度亦可，token 提高限额）
export GITHUB_REPOSITORY=owner/repo
```

会话 cookie 的获取与更新方法见 [../scripts/auto-sync/README.md](../scripts/auto-sync/README.md)「会话 cookie」一节。

---

## 3. 整体架构

### 3.1 页面架构：多页应用（MPA）

站点**不是**单页应用，也不是 iframe 嵌套。`index.html` 是主页，各子页面是 `html/` 下**独立的完整 HTML 文档**，每个页面自行加载：

```html
<link  href="https://unpkg.com/mdui@1.0.2/...">       <!-- MDUI CSS + SRI -->
<link  href="/css/mdui.theme.enhanced.css">            <!-- 主题增强 -->
<link  href="/css/mdui.patch.css">                     <!-- 补丁 -->
<link  href="/css/xf.css">                             <!-- 站点自制样式 -->
<link  href="/css/rtl.css">                            <!-- RTL 镜像 -->
<script src="https://unpkg.com/mdui@1.0.2/...">        <!-- MDUI JS + SRI -->
<script type="module" src="/js/common.js">             <!-- 每页公共入口 -->
<script type="module" src="/js/{page}.js">             <!-- 该页专属入口 -->
```

`html/template.html` 是新页面的空白骨架（appbar + 返回/主页按钮 + 抽屉 + 内容区）。

### 3.2 代码分层

```
┌─────────────────────────────────────────────────────────────────┐
│ 页面入口  js/{index,list,detail,down,intro,rh,about,...}.js      │
│          只做「取 DOM 元素 + 创建 controller + load()」          │
├─────────────────────────────────────────────────────────────────┤
│ 公共入口  js/common.js  —— import 并初始化 logger/i18n/a11y/     │
│          theme/drawer/verWatermark/foxCorner/sponsorRemind      │
├──────────────┬──────────────────┬───────────────────────────────┤
│ controllers/ │ views/           │ 业务状态机，只协调不取数渲染   │
│ 业务逻辑     │ 纯 DOM 渲染      │  (downloadSelectorController) │
├──────────────┴──────────────────┴───────────────────────────────┤
│ repositories/   取数据（getJSON/getText）+ 调用 adapter 归一化    │
├─────────────────────────────────────────────────────────────────┤
│ adapters/download/   纯函数数据转换（按 apiVer 路由，无网络无DOM）│
├─────────────────────────────────────────────────────────────────┤
│ domain/       纯数据模型与逻辑（收藏/偏好/系统信息/筛选/可见性）  │
│               不碰 DOM、不发请求（少数经 logger 触达）           │
├─────────────────────────────────────────────────────────────────┤
│ 基础设施                                                                  │
│  http/client.js      浏览器网络唯一入口（超时/取消/错误/缓存）             │
│  security/content.js 远程 HTML/Markdown 进 DOM 前的安全边界                │
│  common/i18n.js      国际化（t()、语言顺序、RTL）                         │
│  common/logger.js    日志（console + Toast 统一出口）                     │
└─────────────────────────────────────────────────────────────────┘
```

**依赖方向**（自上而下，横向只经导出函数）：

```
入口 → controllers → views / repositories
repositories → http/client + adapters → common/i18n
views → domain + security + common/i18n
domain / common → preferences(localStorage) / i18n / logger
```

### 3.3 下载页核心数据流

```
down.html?id=N
  └─ createDownloadController
       ├─ getSoftware(id) / getMirrors()        ← siteRepository ← data/software.json、data/mirror.json
       ├─ detectSystemInfo()                    ← domain/systemInfo（UAParser 解析 UA）
       ├─ selectAutoDefault(mirrorItems)        ← domain/autoSelect（标记默认线路）
       └─ createDownloadSelectorController
            ├─ loadDownloadNodes(...)           ← downloadRepository
            │    └─ adaptDownloadData(payload, apiVer, ctx)   ← adapters/download 按线路协议路由
            ├─ 逐级渲染选择框（children / items / nextUrl 非叶子则继续下钻）
            └─ 叶子层级 → createSelectorView 渲染下载表格
                 ├─ downloadFilter 按类别取舍列/行（dataSource > system > archive > source）
                 └─ 列整列为空自动删除该列
```

---

## 4. 目录结构

```
index.html / 404.html     页面宿主（主页 / 404）
html/                     子页面模板（12 个独立 HTML 文档）
css/                      样式与主题补丁（4 个文件）
js/                       前端脚本（详见下表）
  common.js               每页公共入口
  {page}.js               各页面专属入口（10 个）
  adapters/download/      下载线路数据适配器（纯函数）
  controllers/            控制器（业务逻辑与页面状态）
  views/                  视图（只操作 DOM）
  domain/                 领域逻辑（纯数据，不碰 DOM/网络）
  repositories/           数据仓库（唯一取数层）
  http/client.js          网络层唯一入口
  security/content.js     远程内容安全边界
  common/                 通用运行时模块（i18n、主题、抽屉、日志……）
  i18n/                   语言包（7 个文件，zh-CN 为基准）
data/                     数据源（软件、标签、线路、设置、公告、下载数据）
html/ … media/            静态资源（图片、字体、音效）
scripts/auto-sync/        线路1 自动同步脚本（Node ESM）
docs/                     开发文档（本文档所在目录）
.github/workflows/        GitHub Actions 工作流（2 个）
```

---

## 5. 页面清单与入口机制

### 5.1 页面对应表

| 页面 | URL | 专属入口 | controller | 说明 |
| --- | --- | --- | --- | --- |
| 主页 | `/index.html` | `js/index.js` | — | 渲染 `#home-bookmarks` 收藏列表 |
| 资源列表 | `/html/list.html` | `js/list.js` | `listController` | 筛选表达式 + 标签 + 收藏列 |
| 资源详情 | `/html/detail.html?id=N` | `js/detail.js` | `detailController` | 详情信息、标签、线路、图标 |
| 下载 | `/html/down.html?id=N` | `js/down.js` | `downloadController` → `downloadSelectorController` | 线路选择 + 下载表格 |
| 介绍文档 | `/html/intro.html?id=N` | `js/intro.js` | `introController` | Markdown/HTML 文档面板 |
| 版本历史 | `/html/rh.html?id=N` | `js/rh.js` | `rhController` | GitHub Releases 列表 |
| 关于 | `/html/about.html` | `js/about.js` | `aboutController` | 线路、贡献者、开源项目 |
| 语言设置 | `/html/language.html` | `js/language.js` | `languageController` | 可排序语言优先级列表 |
| 行为设置 | `/html/behavior.html` | `js/behavior.js` | `behaviorController` | 由 `data/setting.json` 驱动 |
| 主题设置 | `/html/theme.html` | （内联脚本） | — | 亮/暗、主色、强调色 |
| 赞助 | `/html/sponsor.html` | （内联脚本） | — | 赞助与打赏 |
| 模板 | `/html/template.html` | （仅 common.js） | — | 新页面骨架 |
| 404 | `/404.html` | `js/404.js` | — | 反馈按钮 |

**URL 参数约定**：

- `?id=N` —— 软件 ID，由 `getSoftwareId()` 严格校验（`/^\d+$/`，非负整数，否则 `null`）。
- `?showHidden=1`（或 `true`）—— 显式访问 `hidden: true` 的条目，见 `js/domain/visibility.js`；详情页跳往子页面的链接会自动继承该参数（`withShowHidden()`）。

### 5.2 公共入口 `js/common.js` 的初始化顺序

1. `import './common/logger.js'`（注册全局错误处理）；
2. `import` 其余通用模块：`a11y`、`theme`、`drawer`、`verWatermark`、`foxCorner`、`sponsorRemind`；
3. **`initI18n()`** —— 必须先于其它模块执行，保证动态渲染读到正确语言；
4. **`ensureDefaultBookmarks()`** —— 收藏夹为空时默认收藏 FCL 与 MG；
5. IIFE 动态注入统计 SDK（`//sdk.51.la/js-sdk-pro.min.js`，加载后 `LA.init`），失败只记日志（Toast 受设置项 `fdn-logger-analyticsToastDisabled` 控制，**默认关闭**）。

> 新增「每页共用」的 ES Module，统一在 `js/common.js` 中 import。

---

## 6. 核心运行时模块

### 6.1 `js/http/client.js` —— 网络唯一入口

所有浏览器网络请求**必须**经此模块（便于统一超时、取消、错误分类与缓存）。

| 导出 | 签名 | 职责 |
| --- | --- | --- |
| `HttpError` | `class HttpError extends Error`，`constructor(message, {kind, url, status, cause})` | 统一网络错误；`kind ∈ 'network' \| 'http' \| 'parse' \| 'timeout' \| 'abort'` |
| `getJSON` | `getJSON(url, options?) → Promise<object\|Array>` | 请求并解析 JSON |
| `getText` | `getText(url, options?) → Promise<string>` | 请求文本（Markdown/HTML/描述） |
| `getLocalizedText` | `getLocalizedText(url, options?) → Promise<string>` | 优先当前语言版本，404/403 时回退原文；`abort` 错误直接上抛不回退 |
| `clearResponseCache` | `clearResponseCache(url?)` | 清除内存缓存（省略 url 清空全部） |

`options = { signal?, timeoutMs?, cache? }`：

- **超时**：默认 `timeoutMs = 15000`；`createRequestSignal()` 把调用方 `signal` 与超时定时器合并进一个 `AbortController`，并用 `didTimeOut()` 区分「超时」与「用户取消」（判断顺序不可颠倒）。
- **缓存**：`cache: true` 时按 `` `${responseType}:${url}` `` 缓存**进行中的 Promise**（并发去重）；失败的 Promise 立即剔除，保证「重试」真正重发。缓存仅存活于页面生命周期，刷新后由浏览器 HTTP 缓存接管。

### 6.2 `js/security/content.js` —— 远程内容安全边界

**规则**：镜像/第三方仓库的 HTML 与 Markdown 必须经 `createSafeContent()` 处理后才能进 DOM；纯字符串展示请直接用 `textContent`。

| 导出 | 签名 | 职责 |
| --- | --- | --- |
| `loadExternalScript` | `loadExternalScript({src, integrity, globalName}) → Promise<global>` | 懒加载带 **SRI** 的固定版本 CDN 脚本；Promise 复用防重复插入，失败剔除缓存可重试 |
| `createSafeContent` | `createSafeContent(rawContent, {type?: 'html'\|'md', baseUrl?}) → Promise<DocumentFragment>` | 解析 + 净化 + 链接改写的唯一通道 |
| `joinUrl` | `joinUrl(baseUrl, key) → string` | 拼接 URL，自动处理首尾斜杠 |
| `isSafeNavigationUrl` | `isSafeNavigationUrl(value, {allowRelative?}) → boolean` | 写入动态 `href` 前的协议校验（仅 http/https，可选放行 `/` 开头的站内地址） |
| `escapeHtml` | `escapeHtml(str) → string` | 简单 HTML 转义 |

`createSafeContent` 流程：

1. 懒加载 `marked@15.0.12` 与 `dompurify@3.2.6`（jsDelivr + SRI，首次用到才插入 `<script>`）；
2. Markdown 先转 HTML，与原生 HTML 走同一净化策略：`FORBID_TAGS: [script, style, iframe, object, embed, link, meta, base, form]`、`FORBID_ATTR: [srcdoc]`、`ALLOW_DATA_ATTR: false`；
3. `template.innerHTML` —— **全站唯一允许写 innerHTML 的边界**（输入已净化）；
4. `rewriteUrls()` 收紧协议（拒绝 `javascript:` 等）、补齐相对地址、跨域链接加 `target="_blank" rel="noopener noreferrer"`、图片 `loading="lazy"`；
5. 调用 `mdui.mutation()` 让 MDUI 接管新节点。

> ⚠️ 已知结构问题（源码 TODO）：`i18n.js → logger.js → content.js → i18n.js` 存在循环依赖，当前因顶层未互调导出而安全运行。

### 6.3 `js/common/i18n.js` —— 国际化

| 导出 | 签名 / 说明 |
| --- | --- |
| `LANGUAGE_PACKS` / `LANGUAGE_NAMES` | 7 个语言包（`../i18n/*.js`）与展示名 |
| `t(key, params?, skip?)` | 核心翻译：按**语言顺序**查表 → `{param}` 插值 → 失败回退**返回键本身**（永不抛错）；`skip` 为保留原样的占位符集合（DOM 占位元素用） |
| `tOr(key, fallback, params?)` | 与 `t` 相同，但缺失时返回调用方给的 `fallback` |
| `getCurrentLang()` | 当前界面语言 |
| `isRTLLang(code)` | 按语言主标签判断 RTL（`ar` 等） |
| `getLanguageOrder()` / `setLanguageOrder(order, {reload})` | 读/写语言优先级（第一位为界面语言，其余为回退顺序；写入后刷新生效） |
| `getSupportedLanguages()` | 支持的语言列表 |
| `applyTranslations(root = document)` | 应用静态文案：`data-i18n="key"`、`data-i18n-attr="content\|title\|…"` |
| `translateDynamicContent(container)` | 动态内容翻译 |
| `initI18n()` | 初始化：恢复语言偏好 → 检测浏览器语言 → `applyDirection()` 设置 `<html dir>` |
| `translateTag(name)` | 标签名翻译（数据源保持单一语言，未收录键回退原文） |
| `getLocalizedPath(path)` | 本地长文档的多语言文件名转换（如 `/data/announcement.html` → `announcement.en-US.html`） |
| `escapeKeySegment(segment)` | 键路径转义 |

**存储键**：`fdn-language`（旧版单值，兼容读取）、`fdn-language-order`（JSON 数组，读取时规范化并写回）。

**回退链**：`语言顺序第 1 位 → 第 2 位 → … → 键本身`；任何异常经 `logWarn` 后仍返回键，**任何异常都不影响页面可用性**。RTL 由 `applyDirection()` 写 `<html dir="rtl">`，`css/rtl.css` 镜像布局；`index.html` 内联脚本在 CSS 加载前先设 `lang/dir`，避免布局翻转闪烁。

### 6.4 `js/common/` 其余模块

| 文件 | 行数 | 导出 / 职责 |
| --- | --- | --- |
| `logger.js` | 156 | `logInfo/logWarn/logError(err, context, options)`、`registerGlobalHandlers()`；console + Toast 统一出口（`options.noToast` 可静默） |
| `toast.js` | 102 | `showToast(content, options?)` 轻量 Toast |
| `a11y.js` | 432 | IIFE，为 MDUI Panel/Select/Drawer 补键盘导航、ARIA、焦点管理（`window.__MDUI_PANEL_A11Y_INITED` 防重入） |
| `drawer.js` | 240 | 右侧抽屉：静态结构取自 `data/drawer.html`，动态注入反馈、公告、运行时间、收藏、彩蛋入口 |
| `announcement.js` | 123 | `checkNewAnnouncement()`、`loadAnnouncement(container)`；公告按语言读 `data/announcement.{lang}.html`，经 `createSafeContent` 入 DOM |
| `theme.js` | 86 | 主题设置页交互；`showSaveSuccess()` |
| `verWatermark.js` | 46 | `getCurrentVersion()` 读 `data/verInfo.json` 的 `gitHash` 做版本水印 |
| `sponsorRemind.js` | 91 | 赞助提醒（基于下载访问计次 `fdn-downVisitCount`，可永久关闭 `fdn-sponsorRemindPermanentDisabled`） |
| `foxCorner.js` | 60 | 右下角狐狸吉祥物插画（纯装饰，RTL 镜像到左下，滚到底部才显示） |

---

## 7. 分层业务模块

### 7.1 `js/repositories/` —— 数据仓库（唯一取数层）

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `siteRepository.js` | `getSoftwareCatalog(options?, visibility?)`、`getTags(options?)`、`getMirrors(options?)`、`getSoftware(id, options?)`、`getSettings(options?)`、`getFeedbackChannels(options?)`、`completeOrphanTags(tags, references)` | 读 `data/software.json`、`tag.json`、`mirror.json`、`setting.json`、`feedback.json`；校验 ID 唯一与必填字段；按 `showHidden` 过滤/拦截隐藏条目 |
| `downloadRepository.js` | `loadDownloadNodes({...})`、`loadDescription(url, signal)` | 按 `apiVer`/线路名请求镜像 JSON 并调用 `adaptDownloadData` 归一化；`cxsjmc` 线路直读 GitHub Release assets；额外接口请求放这里（适配器不发请求） |

**统一叶子下载项字段**：`name`、`version`、`architecture`、`size`、`description`、`downloadUrl`、`available`、`source`；线路 API 额外信息 `publishedAt`、`sha256`、`prerelease`、`contentType`、`assetId`、`tagName`、`launcher` 一并归一化（上游没有则留空）。

### 7.2 `js/controllers/` —— 控制器（业务逻辑 + 页面状态）

| 文件 | 工厂函数 | 职责 |
| --- | --- | --- |
| `listController.js` | `createListController(elements)`；另有 `parseFilterExpression(input)`、`removeLastCondition(input)` | 列表页：并行取目录/标签、筛选表达式解析（`name: fold & tag: mc\!je`，关系符 `& \| !`，值内需 `\` 转义）、收藏变更订阅、防抖刷新 |
| `detailController.js` | `createDetailController(elements, softwareId)` | 详情页：`getSoftware/getTags/getMirrors` 并行 → `renderDetail`；失败渲染错误 + `load` 重试 |
| `downloadController.js` | `createDownloadController(elements, softwareId)` | 下载页：组装 `mirrorItems`、`detectSystemInfo` + OS 要求消息、`selectAutoDefault` 选默认线路、创建选择器 |
| `downloadSelectorController.js` | `createDownloadSelectorController(options) → {start, abort}` | **下载链路核心状态机**：每次选择持独立 `AbortController` + 递增 `requestSequence`，过期响应不回写；`isBottomLevel()` 判断是否渲染最终表格；`renderDescription()` 净化加载线路描述 |
| `introController.js` | `createIntroController(container, softwareId)` | 介绍页：文档面板按状态 `loading/ready/error/undefined` 惰性加载，经 `createSafeContent` 渲染 |
| `rhController.js` | `createRhController(container, softwareId)` | 版本历史：请求 `detail.json.releaseHistoryUrl`（GitHub Releases API）渲染 |
| `aboutController.js` | `createAboutController(elements)` | 关于页三个挂载点：线路 / 贡献者 / 开源项目 |
| `behaviorController.js` | `createBehaviorController(elements)` | 行为设置：结构完全由 `data/setting.json` 驱动（`storageKey` 直连 `preferences`），无硬编码业务常量 |
| `languageController.js` | `createLanguageController(elements)` | 语言页：可排序列表，重排即保存优先级并实时生效 |
| `doNotClickController.js` | `ramdonRun()`、`runEvent(eventId)` | 彩蛋模块（「千万别点」） |

### 7.3 `js/views/` —— 视图（只操作 DOM）

| 文件 | 关键导出 | 渲染目标 |
| --- | --- | --- |
| `commonView.js` | `debounce`、`formatBytes`、`clearElement`、`setFilterIndicator`、`renderMessages`、`renderTableStatus`、`renderStatus`、`setSoftwareHeader`、`setErrorTitle`、`getSoftwareId`、`loadFeedback`、`createStickyColumn` | 跨页公共：加载/错误状态机、页头、反馈按钮、表格吸附列 |
| `uiComponents.js` | `createPanel`、`createPanelItem`、`createMaterialIcon`、`createExternalLink`、`createTypoContainer`、`createParagraph`、`createFluidTable`、`createRaisedButton`、`createGrid`、`createBreak`、`createHR`、`createSpan`、`createTextField`、`createCheckbox`、`showSnackbar` | MDUI 组件工厂集 |
| `listView.js` | `renderSoftwareList`、`renderListLoading/Error`、`renderFilterHelpTags`、`enableFilterHelpInserts`、`refreshBookmarkColumn` | 资源列表与筛选帮助 |
| `detailView.js` | `renderDetail(elements, id, basic, detail, tags, mirrors)`、`renderDetailLoading/Error` | 详情页全部内容 |
| `selectorView.js` | `createSelectorView(container, stopButton, matchedArchitecture, osPatterns?, osName?)` | 下载选择框 + 最终下载表格（列可见性、筛选面板、不可用项） |
| `introView.js` | `renderIntroLoading/Error/Panels`、`renderDocumentLoading/Document/DocumentError` | 介绍页文档面板 |
| `rhView.js` | `renderReleases(container, basic, releases)`、`renderRhLoading/Error` | 版本历史面板 |
| `aboutView.js` | `renderDownloadLines`、`renderContributors`、`renderUsedProjects`、`renderAboutLoading/Error` | 关于页三块 |
| `languageView.js` | `createRow`、`createColumns`、`createComparisonTable` | 语言排序行与翻译对照表 |
| `behaviorView.js` | `renderSettingsTree(container, categories, readPref, onChange)`、校验族 `isValidOption/SwitchValue/NumberValue`、`getDefaultOptionValue` | 设置树渲染与取值校验 |
| `bookmarkView.js` | `createBookmarkButton(item)`、`renderBookmarkList`、`mountBookmarkList` | 收藏按钮与收藏列表 |
| `iconView.js` | `createIconElement({icon, name, size, className, imgClassName})`、`isSvgIcon` | 图标（缺图占位、SVG/AVIF 处理） |
| `sortableTable.js` | `createSortableTable(container, {items, columns, renderRow, onReorder})`、`resolveInsertIndex` | 语言页可拖拽排序表 |

### 7.4 `js/domain/` —— 领域逻辑（纯数据，不碰 DOM、不发请求）

| 文件 | 导出 | 逻辑 |
| --- | --- | --- |
| `preferences.js` | `readPreference(key, defaultValue?)`、`writePreference(key, value)` | localStorage 封装；隐私模式/存储禁用时降级为默认值，不阻断页面 |
| `bookmarks.js` | `getBookmarks`、`ensureDefaultBookmarks`、`addBookmark`、`removeBookmark`、`isBookmarked`、`toggleBookmark`、`clearBookmarks`、`restoreDefaultBookmarks`、`onBookmarkChange`、`offBookmarkChange` | 存储键 `fdn-bookmarks`；空收藏时默认收藏 FCL 与 MG；事件通知机制 |
| `theme.js` | `applyTheme(theme, primary, accent)` | 计算最终主题写入 `<html data-xf-theme="light\|dark">`（全站 CSS 只看这一个属性） |
| `systemInfo.js` | `detectSystemInfo()`、`inferArchitecture(item)`、`checkOSRequirement(osRequests, system)`、`buildSystemMessages(system)`、`getSystemDownloadPatterns(osName)` | UAParser 解析 UA → 架构/系统；只影响绿色推荐行，不隐藏其它下载项 |
| `autoSelect.js` | `selectAutoDefault(items)` | 有序管道标记默认线路；`notJoinRandom` 仅表示不参与「随机」这一步，仍可作回退 |
| `downloadFilter.js` | `createFilterConfig({filter, osPatterns, osName})`、`ARCHIVE_EXTENSIONS`、`SOURCE_EXTENSIONS` | 下载表格筛选类别，优先级 `dataSource > system > archive > source` |
| `visibility.js` | `SHOW_HIDDEN_PARAM`、`isTruthyFlag`、`isShowHiddenEnabled(search)`、`isHiddenItem`、`filterHiddenItems`、`withShowHidden(url, search)` | `hidden: true` 条目默认隐藏；详情/下载/介绍/版本历史需 `?showHidden=1` 才可访问；子页面链接自动继承该参数 |
| `siteInfo.js` | `getRunTime()`、`getDownVisitCount()`、`incrementDownVisitCount()` | 建站运行时长、下载访问计次（赞助提醒用） |

### 7.5 `js/adapters/download/` —— 线路适配器

- **注册与路由**：`index.js` 导出 `adaptDownloadData(payload, apiVersion, context = {})`，按 `data/mirror.json` 的 `apiVer` 查注册表；**未登记协议一律回退 `adaptPlain`**。
- **约束**：适配器是**纯函数**，只做数据转换，禁止发网络请求或操作 DOM；额外接口请求放 repository，交互与取消放 controller。
- **登记方式**：新增线路 → 新建纯函数文件 → 在 `index.js` 的 import 与注册表中登记 `apiVer`。

| 文件 | 导出 | 适配的数据结构 |
| --- | --- | --- |
| `common.js` | `normalizeDownloadItem(item, source, version?, release?)`、`normalizeExtraMetadata(item, release)`、`formatPublishedAt(value)`、`compareVersionsDescending(l, r)` | 统一项构造与额外字段归一化（公共底座） |
| `plain.js` | `adaptPlain(payload, context)` | 本地/最简数组结构 `[{arch, url, size}]` 或 `[{name, url}]`（线路1、线路8 等） |
| `fengyuan.js` | `adaptFengyuan` | 枫源镜像 API |
| `Linkong.js` | `adaptLinkong`、`wdfDownUrl(baseUrl, tag, assetName, owner, repo)` | 线路5（GitHub Release 拼链） |
| `lemwood.js` | `adaptLemwood(payload, context, {latestOnly}?)` | 柠泽资源站（V1/V2 接口） |
| `cxsjmc.js` | `adaptCxsjmc` | 创想镜像 |
| `frostlynx.js` | `adaptFrostlynx` | FrostLynx 线路 |
| `way2old.js` | `adaptWay2old` | 旧协议 |

---

## 8. 关键函数速查表

> 按「你在某页要做什么 → 调谁」组织；签名以源码 JSDoc 为准。

**起步一个新页面**

```js
// 1. 复制 html/template.html，改 title / data-i18n
// 2. 新建 js/{page}.js
import { createXxxController } from './controllers/xxxController.js';
import { getSoftwareId, renderStatus, setErrorTitle } from './views/commonView.js';
import { t } from './common/i18n.js';

document.addEventListener('DOMContentLoaded', () => { /* 取元素 → controller.load() */ });
// 3. 页面同时加载 /js/common.js（i18n、主题、抽屉等已就绪）
```

**取数据**

```js
getJSON(url, { signal, timeoutMs, cache })      // http/client
getText(url, options)                           // http/client
getLocalizedText(url, options)                  // 语言优先 + 404/403 回退
getSoftware(id, options)                        // siteRepository，含 showHidden 校验
getSoftwareCatalog(options, visibility)         // 软件目录（过滤 hidden）
getMirrors(options) / getTags(options)          // 线路 / 标签
loadDownloadNodes({ apiVersion, sourceName, ... })  // 下载节点（内部走 adapter）
loadDescription(url, signal)                    // 线路描述
```

**渲染与状态**

```js
renderStatus(container, state, { message, onRetry })   // 统一 loading/ready/error
renderMessages(wrapper, container, messages)           // 系统兼容性等消息组
setSoftwareHeader(basic, { titlePrefix, detailButton })// 子页公共页头
getSoftwareId()                                        // 严格解析 ?id=
withShowHidden(url, search)                            // 链接继承 showHidden
```

**文案与主题**

```js
t('detail.download.button', { n: 3 })   // 翻译 + 插值，缺失返回键
tOr(key, fallback, params)              // 缺失返回 fallback
translateTag(name) / applyTranslations(root) / translateDynamicContent(container)
applyTheme(theme, primary, accent)      // 'light'|'dark'|'auto'
```

**本地存储**

```js
readPreference(key, def) / writePreference(key, value)  // 通用偏好
getBookmarks() / toggleBookmark(item) / onBookmarkChange(cb)  // fdn-bookmarks
```

**安全渲染远程内容**

```js
const fragment = await createSafeContent(mdOrHtml, { type: 'md', baseUrl });
container.replaceChildren(fragment);      // 全站唯一 innerHTML 边界在模块内部
isSafeNavigationUrl(href)                 // 动态 href 校验
```

---

## 9. 数据源（data/）

### 9.1 目录级数据

| 文件 | 结构（要点） | 用途 |
| --- | --- | --- |
| `software.json` | `[{ id, name, icon?, tagIds: number[], detailUrl, hidden? }]` | 软件目录；`hidden: true` 默认隐藏（见 `domain/visibility.js`） |
| `tag.json` | `[{ id, name }]` | 标签字典（Android/启动器/渲染器/JRE…） |
| `mirror.json` | `[{ id, name, baseUrl, apiVer?, description?, notJoinRandom?, contributeId: number[] }]` | 下载线路目录；`apiVer` 是适配器路由键（当前数据中取值：`fengyuan`、`Linkong`、`Lemwood`；`cxsjmc` 等适配器已登记但当前未被线路引用；缺省/未登记一律走 `plain`） |
| `setting.json` | 树：`[{ name, label, children: [{ name, label, storageKey, type, ... }] }]` | 行为设置结构（分类 `common/log/list/detail`），`storageKey` 直连 localStorage |
| `usedProj.json` | `[{ name, description, useDescription, useVersion, link, license, licenseLink }]` | 第三方依赖清单（关于页展示，也是依赖版本的**权威来源**） |
| `verInfo.json` | `{ gitHash }` | 由 CI 刷新，版本水印用 |
| `contribute.json` | `[{ id, accentName, name, avatar, link, content }]` | 贡献者/线路提供者 |
| `feedback.json` | `[{ name, href }]` | 反馈渠道按钮 |
| `drawer.html` | HTML 片段 | 抽屉静态结构 |
| `announcement.html` / `announcement.{en-US,ja-JP,fr-FR,ru-RU,ar,es-ES}.html` | HTML 片段 | 公告（按语言后缀，缺失回退中文） |
| `sponsorRemind.html` | HTML 片段 | 赞助提醒内容 |
| `software.json.bak`、`down/模板.json` | — | 备份 / 模板，不参与运行 |

### 9.2 `data/down/` 下载数据组织

```
data/down/{软件id}/
├── index.json                 # 版本索引（数组）
│     [{ name, nextUrl, tag?, default?, pinned?, description? }]
│     · default: true  → 下载页默认版本
│     · pinned: true   → 置顶条目（如「最后一个有 Boat 后端的版本」）
├── {逐位拆分路径}.json         # 历史手动版本，如 1/3/2/8.json → 1.3.2.8
└── auto/{年}/{月}/{日}/{版本}.json   # GitHub Actions 自动生成
      [{ arch, url, size }]    # arch: all | arm64-v8a | armeabi-v7a | x86 | x86_64
```

- `nextUrl` 形成**逐级下钻**链：`index.json → 版本 JSON → （可继续）`；`downloadSelectorController.isBottomLevel()` 据 `children/nextUrl/items` 判断是否叶子。
- 手动数据与自动数据**共存**在同一 index 中。

### 9.3 `data/software/{id}/` 详情数据

```jsonc
// detail.json
{
  "info": [{ "name": "developer", "href": "https://…" }],       // 信息行
  "intro": [                                                     // 介绍文档面板
    { "title": "GH-README", "url": "https://raw.githubusercontent.com/…",
      "file": "/README.md", "type": "md" },                      // md → marked
    { "title": "介绍", "url": "/data/software/0",
      "file": "/intro.html", "type": "html" }                    // html → DOMPurify
  ],
  "releaseHistoryUrl": "https://api.github.com/repos/…/releases", // rh.html 数据源
  "download": [                                                   // 可用线路及 key
    { "mirrorId": 0, "key": "/0/index.json" },
    { "mirrorId": 4, "key": "/api/releases?owner=…&repo=…" }
  ],
  "OSRequest": [ /* 运行系统要求，checkOSRequirement 消费 */ ]
}
```

同目录另有 `icon.avif|svg`、`intro.{lang}.html`（长文档多语言版本）、`media/img/`（介绍页配图）。`data/mirror/{id}/*.json` 是本地镜像线路的静态数据。

---

## 10. 样式与静态资源

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `css/mdui.theme.enhanced.css` | 236 | MDUI 主题变量增强（配色/阴影） |
| `css/mdui.patch.css` | 258 | 对 MDUI 1.0.2 的问题补丁 |
| `css/xf.css` | 613 | 站点自制样式（布局、组件、`--xf-fox-corner-width` 等自定义属性） |
| `css/rtl.css` | 192 | RTL 语言布局镜像（与 `js/common/i18n.js` 的 RTL 判定配合） |

`media/`：`font/Mojangles.ttf`（Minecraft 风格字体）、`img/`（预览图、头像、彩蛋、缺图占位 `picMissing.webp`）、`sound/钢管落地.mp3`（彩蛋音效）。

主题切换唯一判据：`<html data-xf-theme="light|dark">`（由 `domain/theme.js:applyTheme` 写入）。

---

## 11. 依赖关系

### 11.1 第三方依赖（版本以 `data/usedProj.json` 为准）

| 库 | 版本 | 引入方式 | 用途 |
| --- | --- | --- | --- |
| MDUI | 1.0.2 | unpkg CDN，`<link>/<script>` + SRI（sha384） | 基础 UI 框架 |
| Material Icons | 1.13.14 | unpkg CDN + SRI | 图标字体（不用 MDUI 自带旧版） |
| UAParser.js | 2.0.7 | jsDelivr CDN + SRI，**仅 `html/down.html` 引入** | 下载页架构/系统识别 |
| Marked | 15.0.12 | jsDelivr + SRI，**`security/content.js` 懒加载** | Markdown 解析（介绍/版本历史） |
| DOMPurify | 3.2.6 | jsDelivr + SRI，**懒加载** | 远程 HTML 净化 |
| 51.la 统计 SDK | 动态注入，无 SRI | `js/common.js` IIFE | 访问统计（失败不影响功能） |

所有 CDN 脚本均带 `integrity` + `crossorigin="anonymous"`；`index.html` 对 unpkg / jsDelivr 有 `preconnect`。**无 npm / package.json / 构建工具链。**

### 11.2 模块依赖关系（import 图，主要链路）

```
js/{page}.js ─┬─ controllers/* ─── repositories/* ── http/client.js
              │        │                 └──── adapters/download/* ── common/i18n
              │        ├─ views/*  ── domain/* 、security/content.js、common/i18n
              │        └─ domain/* 、common/i18n、common/logger
              └─ views/commonView.js

js/common.js ── common/{logger,i18n,a11y,theme,drawer,verWatermark,foxCorner,sponsorRemind}
                     │            │
                     │            └─ domain/{preferences,bookmarks,siteInfo}
                     └─ security/content.js ←┐
                                              │（循环，见 6.2 注）
        common/i18n ←── common/logger ────────┘

关键横向边：
  repositories/siteRepository ── domain/visibility
  controllers/download*        ── domain/{systemInfo,autoSelect}、security/content
  controllers/list             ── domain/bookmarks、http/client（clearResponseCache）
  common/announcement          ── http/client(getLocalizedText)、security/content
```

**规则**：`domain/` 不 import `views/`、不发请求；`adapters/` 不 import `http/`、不碰 DOM；跨层只经导出函数。

---

## 12. 自动化：GitHub Actions 与线路1自动同步

### 12.1 工作流

| 文件 | 触发 | 做什么 |
| --- | --- | --- |
| `.github/workflows/auto-sync.yml` | `cron '55 1,9,17 * * *'`（UTC，= 北京时间 09:55/17:55/次日 01:55）+ 手动 | 线路1（huang1111 网盘）全自动更新，见下 |
| `.github/workflows/updata-verInfo.yml` | push 到 `main` | 写 `data/verInfo.json`（完整 gitHash）+ 刷新 `sitemap.xml` 的 `<lastmod>`；若最新提交以 `[GHA]` 开头则跳过（避免与自动同步互相触发） |

**auto-sync 双 job 架构**（`permissions: contents: write`，`concurrency: auto-sync`，Node 24，`TZ: Asia/Shanghai`）：

```
probe job（timeout 10min，不登录、不动网盘）
  1. checkout + setup-node
  2. node scripts/auto-sync/check-session.mjs   # 会话巡检：离线推算到期 + GET /user/me 验活
  3. node scripts/auto-sync/probe.mjs           # 比对数据源与 GitHub Releases
       → 输出 needs_sync=true/false 到 $GITHUB_OUTPUT（崩溃时默认 true，宁多跑不漏版）
sync job（timeout 30min，仅当 needs_sync == 'true' 才调度）
  4. node scripts/auto-sync/sync.mjs            # 离线下载 → 取直链 → 写 JSON → 分软件 commit → push
```

**Secrets**：`H1111_SESSION`（**必需**，会话 cookie，实测 60 天）、`H1111_USER` / `H1111_PASSWORD`（回退）。

### 12.2 `scripts/auto-sync/` 脚本职责

| 文件 | 行数 | 导出 / 职责 |
| --- | --- | --- |
| `config.mjs` | 64 | `ENV`（读环境变量）、`RETRY`（登录/验证 3 次、离线下载 3 次、其它 2 次）、`TIMING`、`LIMIT` |
| `lib.mjs` | 219 | `fetchReleases(githubRepo, includePrerelease, onLog)`（分页+重试，滤 draft/prerelease）、`compareVersionsDescending`、`versionFromTag`、`datePathFromRelease`、`parseDataSourceIndex(softwareId)`、`versionKnown`、`mapAssetsToEntries`、`entrySortKey`、`isPinnedEntry`；导出 `ROOT`、`SOFTWARES`（软件映射表） |
| `plan.mjs` | 129 | `planSoftware(sw, scope, row)`、`planAll(softwares, rootScope, makeRow)` —— 探测/同步**共用**的候选比对实现（避免口径漂移） |
| `probe.mjs` | 93 | 预探测主程序（见上）；不读凭据、不写文件、永远 `exit 0` |
| `sync.mjs` | 598 | 主流程；导出 `syncVersion`、`updateIndex`、`verifySyncedData`、`pruneSoftware`、`commitSoftware`、`push` |
| `h1api.mjs` | 844 | huang1111（Cloudreve 定制版）API 客户端：`loginWithSession`、`login`、`listDir`、`createDir`、`deleteDir`、`offlineDownload`（aria2 离线下载）、`getSources`（取直链）、`isAuthed`、`H1Error` |
| `session.mjs` | 216 | `SESSION_COOKIE_NAME='cloudreve-session'`、`SESSION_TTL_SECONDS`（60 天）、`SESSION_BANDS=[30,10,1]`（临期提醒阈值）、`sessionInfo`、`maskSession`、`fmtRemaining`、`decodeSessionIssuedAt` |
| `logger.mjs` | 331 | `Logger`/`Scope`（作用域树自动缩进、无时间戳前缀、无 `::group::`、末尾不重打）、`renderSoftwareTable`（写 `GITHUB_STEP_SUMMARY`）、`newRow`、`fmt*` |
| `check-session.mjs` | 264 | 会话只读验活：离线时间戳判断 + 实际 `GET /user/me`（区分 401 与网络异常）；临期/失效写日志 + GHA 注解 |
| `tools/refresh-session.mjs` | 244 | 辅助更新会话 cookie |
| `softwares.json` | — | 参与自动同步的软件配置 |

### 12.3 同步流水线（`sync.mjs`）

1. **比对**（与 probe 同源 `plan.mjs`）：数据源最新版本 vs GitHub Release —— 落后几个版本就下载几个；数据源无版本则只取最新一个。
2. **登录**：`loginWithSession(H1111_SESSION)`（cookie 认证；密码登录因交互式验证已不可自动化）。
3. **离线下载**：目标目录 `foldcraftlauncher_cn_auto/{id}/{date}/{version}` → `offlineDownload` 提交 aria2 任务并轮询。
4. **成功判据**：`listDir` 中出现全部期望文件且 **size 与 GitHub asset 精确相等**（不依赖 aria2 status / 返回码）。
5. **取直链**：`getSources(fileIds)`（`purpose=direct_link` 仅需 PoW，不受交互式验证影响）。
6. **写数据**：`data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json`，再更新 `index.json`（新条目置 `default`，保留 `pinned`，按 `entrySortKey` 排序）。
7. **验证与提交**：`verifySyncedData` → 每软件一个 commit，消息格式
   `[GHA] 新增：内容：数据源：资源id-{id}：{版本列表&分隔}呜~`（正文为该软件作用域日志）→ 全部完成后统一 `push`。

---

## 13. 工程约定与注意事项

1. **无构建**：不引入打包器/linter 配置；代码风格以「与周边一致」为准。
2. **分层纪律**：适配器只转换数据；网络只走 `http/client.js`；远程富文本只走 `security/content.js`；DOM 只在 `views/`。
3. **i18n 纪律**：短文案进语言包（稳定 ID/序号寻址）；长文档按语言后缀放文件；数据源保持单一语言；新文案必须同时补 `js/i18n/zh-CN.js` 与对应语言包。
4. **localStorage 键**（前缀 `fdn-`）：`fdn-bookmarks`、`fdn-language`、`fdn-language-order`、`fdn-theme`、`fdn-theme-primary`、`fdn-theme-accent`、`fdn-default-format-prefix`、`fdn-default-open-method`、`fdn-bookmark-open-method`、`fdn-list-icon-size`、`fdn-detail-icon-size`、`fdn-logger-enableToast`、`fdn-logger-duration`、`fdn-logger-analyticsToastDisabled`、`fdn-downVisitCount`、`fdn-sponsorRemindPermanentDisabled`。
5. **提交消息**：CI 产生的提交以 `[GHA]` 开头，`updata-verInfo.yml` 据此防循环；人工提交请勿使用该前缀。
6. **新增线路**：数据结构相同 → 只加 `data/mirror.json` 条目；结构不同 → `js/adapters/download/` 新增纯函数适配器并登记 `apiVer`。
7. **新增页面**：复制 `html/template.html` → 新建 `js/{page}.js` → 依需新增 controller/view → 页面同时引 `common.js`。
8. **已知技术债**（源码自述）：`i18n → logger → content → i18n` 循环依赖（暂安全）；日志/文案有「能跑就行」的历史包袱，改动时优先保持行为不变。

---

### 附：现有文档索引

| 文档 | 内容 |
| --- | --- |
| [i18n.md](i18n.md) | 国际化 API、DOM 用法、维护指南（语言顺序/键路径/插值/存储） |
| [auto-sync-design.md](auto-sync-design.md) | 线路1自动更新设计（双 job、版本路径映射、JSON 生成、验证协议、风险） |
| [huang1111-api-notes.md](huang1111-api-notes.md) | 网盘 API 逆向笔记（认证/CSRF/PoW/目录/直链/aria2/踩坑） |
| [../scripts/auto-sync/README.md](../scripts/auto-sync/README.md) | 自动同步脚本用法、会话 cookie 获取与更新 |
| [../README.md](../README.md) | 项目主页说明 |
| [../AGENTS.md](../AGENTS.md) | AI 助手在本项目的工作约定 |
