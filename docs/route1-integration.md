# 线路一（站长提供）第三方接入指南

> 面向：希望在自己网站、工具或脚本里展示并分发本站「线路一」资源的第三方开发者。
> 依据：2026-10-31 线上实测与仓库现状。数据由 GitHub Actions 自动维护，字段以实际 JSON 为准。

## 1. 线路一是什么

线路一是本站 `data/mirror.json` 中 `id: 0` 的下载线路，显示名为「站长提供 (huang1111)」：

```json
{
  "id": 0,
  "name": "站长提供 (huang1111)",
  "baseUrl": "/data/down",
  "description": "由GitHub Actions自动更新。",
  "contributeId": [0]
}
```

它由两部分组成：

- **目录数据**：纯静态 JSON，放在本站 `data/down/` 下，按软件 id 分目录；
- **文件本体**：托管在 huang1111 网盘，JSON 里存的是公共直链（`https://pan.huang1111.cn/f/...`）。

接入方只需要读取 JSON；真正的文件由用户浏览器直接访问网盘直链，不经过本站服务器。

| 项 | 说明 |
|---|---|
| 鉴权 | 无。不需要 Cookie、Token、API Key |
| 协议 | HTTP GET，返回 JSON |
| 更新 | GitHub Actions 每天 UTC+8 01:55 / 09:55 / 17:55 检测新 Release，有更新才写文件 |
| 自动覆盖 | 7 个软件（id 0、3、4、12、15、16、17）；其余条目由站长手动维护 |
| 数据形态 | 多层下拉节点；层级不固定，需递归解析（见 §4） |

## 2. 三步接入

### 2.1 取版本索引

```http
GET https://foldcraftlauncher.cn/data/down/0/index.json
```

返回（节选）：

```json
[
  {
    "name": "最后一个有Boat后端的版本",
    "nextUrl": "/data/down/0/boat.json",
    "description": "这是最后一个有Boat后端的版本。可以与已安装的版本共存。",
    "pinned": true
  },
  {
    "name": "1.3.4.3",
    "nextUrl": "/data/down/0/auto/2026/10/30/1.3.4.3.json",
    "tag": "1.3.4.3",
    "default": true
  },
  {
    "name": "1.3.4.2",
    "nextUrl": "/data/down/0/auto/2026/10/25/1.3.4.2.json",
    "tag": "1.3.4.2"
  }
]
```

### 2.2 取版本文件

优先取 `default: true` 的条目（没有就取第一条），再请求它的 `nextUrl`：

```http
GET https://foldcraftlauncher.cn/data/down/0/auto/2026/10/30/1.3.4.3.json
```

返回（节选）：

```json
[
  {
    "arch": "all",
    "url": "https://pan.huang1111.cn/f/OKxEF2/FCL-release-1.3.4.3-all.apk",
    "size": 321887206
  },
  {
    "arch": "arm64-v8a",
    "url": "https://pan.huang1111.cn/f/34MZi6/FCL-release-1.3.4.3-arm64-v8a.apk",
    "size": 168689168
  }
]
```

### 2.3 展示与下载

- `arch` → 架构标签；
- `size` → 字节数，展示时自行换算 KB/MB；
- `url` → 下载按钮的链接；
- `name` 可能缺失（部分条目只有 `url`），展示时按「未命名」处理即可。

> **关键点**：`nextUrl` 是**本站根路径**（以 `/` 开头）。第三方解析时必须用
> `https://foldcraftlauncher.cn` 作为基址，不能相对自己的站点解析，否则会请求到自己的 404。

## 3. 接口约定

| 项 | 值 |
|---|---|
| 基址 | `https://foldcraftlauncher.cn/data/down` |
| 方法 | `GET`（`HEAD` 可用） |
| 鉴权 | 无 |
| Content-Type | `application/json` |
| 缓存头 | 响应带 `ETag` 与 `Last-Modified`，支持 `If-None-Match` / `If-Modified-Since` |
| 跨域 | **未返回 `Access-Control-Allow-Origin`**（2026-10-31 实测），浏览器直连会被同源策略拦截，见 §8 |
| 404 | 表示该软件没有线路一数据，或该版本已被清理 |
| 目录命名空间 | 软件 id，与 `data/software.json` 中的 `id` 一致 |

拼接规则与本站 `js/security/content.js` 的 `joinUrl` 一致：

```js
// baseUrl + key：去掉首尾多余斜杠后拼接
const entryUrl = `${baseUrl.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
```

本站 `data/software/{id}/detail.json` 里，线路一的引用形如：

```json
{ "mirrorId": 0, "key": "/0/index.json" }
```

即实际请求 `https://foldcraftlauncher.cn/data/down/0/index.json`。第三方可以直接使用这个 URL 模板，不需要解析 `detail.json`。

## 4. 数据结构

一个软件的数据是一棵「下拉节点树」，叶子才是真正的下载项：

```
index.json（入口）
├─ 分组节点 { name, tag, nextUrl } ──► 版本文件（叶子数组）
├─ 分组节点 { name, children }     ──► 内联叶子
├─ 分组节点 { name, nextUrl }      ──► 另一个目录索引（如 Pojav 的二级目录）
└─ 下载叶子 { name, url, arch, size }（index 直接就是清单）
```

不同软件的层级和形态并不统一，**不要假设固定两级**。

### 4.1 节点类型

**分组节点**（继续向下展开）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 显示名 |
| `tag` | string | 版本 Tag。与 `name` 不同时，本站显示为 `name(tag)` |
| `nextUrl` | string | 本站根路径，需要再请求一次 |
| `children` / `items` | array | 内联子节点，无需再请求 |
| `description` | string | 纯文本说明 |
| `default` | boolean | 默认选中项；没有则取第一条 |
| `pinned` | boolean | 置顶条目，永远排在最前，不参与版本排序 |

**下载叶子**（最终可下载项）：

| 字段 | 兼容别名 | 类型 | 说明 |
|---|---|---|---|
| `name` | `file_name` | string | 文件名或显示名 |
| `url` | `downloadUrl` / `link` / `download_link` | string | 下载直链，必须是 http(s) |
| `arch` | `architecture` | string | 架构：`all`、`arm64-v8a`、`armeabi-v7a`、`x86`、`x86_64`；也可能为空 |
| `size` | `size_bytes` | number | 字节数；旧的手动条目可能没有该字段 |
| `description` | `unavailable_reason` | string | 说明或不可用原因 |
| `available` | — | boolean | `false` 表示条目存在但暂不可用，展示时应禁用按钮 |
| `sha256` | `digest_sha256` / `digest` | string | 可选，十六进制摘要 |
| `prerelease` | — | boolean | 可选，是否预发布 |
| `published_at` | — | string | 可选，ISO 时间 |
| `content_type` | `contentType` | string | 可选，MIME |
| `asset_id` | `assetId` / `id` | string | 可选，上游条目 ID |

线路一当前生成的版本文件通常只有 `name` / `arch` / `url` / `size`；上表其余字段是本站适配器的通用能力，未提供时留空即可。未知字段请直接忽略，不要报错。

### 4.2 解析顺序

按以下优先级逐项判断（与本站选择器的行为一致）：

1. 有 `nextUrl` → 用本站基址解析并再请求一次，对返回数组继续递归；
2. `children` 或 `items` 非空 → 内联分组，递归展开；
3. 有 `url`（或任一别名）→ 作为下载叶子；
4. 以上都没有 → 跳过该项。

### 4.3 其他形态示例

**直接清单**（如 Android Openjdk Build、HMCL-PE）：`index.json` 本身就是叶子数组：

```json
[
  {
    "name": "jre21-arm64-20260223-release.tar.xz",
    "url": "https://pan.huang1111.cn/f/eWkQI1/jre21-arm64-20260223-release.tar.xz",
    "size": 29922352
  }
]
```

**内联分组**（如 Mindustry）：版本节点直接带 `children`：

```json
[
  {
    "name": "v159.7",
    "children": [
      {
        "name": "[Android][v159.7]Mindustry.apk",
        "url": "https://pan.huang1111.cn/f/g7jEfP/%5BAndroid%5D%5Bv159.7%5DMindustry.apk"
      }
    ]
  }
]
```

**多级目录**（如 Pojav Launcher）：`nextUrl` 指向另一个目录索引，路径含空格，交给 `URL` 自动编码即可：

```json
[
  { "name": "\"Gladiolus\" release", "nextUrl": "/data/down/7/Gladiolus release/index.json" }
]
```

### 4.4 排序、默认项与展示约定

- `index.json` 的条目顺序通常已是版本从新到旧，可直接按原顺序展示；
- `pinned: true` 的条目应固定在前，且通常不带 `default`；
- 默认项：取第一个 `default === true` 的条目；没有则取第一条；
- 如需自行排序，按版本号中的数字分段比较（与本站 `js/adapters/download/common.js` 的 `compareVersionsDescending` 一致），不要按字符串比较，否则 `1.10` 会排在 `1.9` 前面；
- 展示名：`tag` 存在且与 `name` 不同时显示 `name(tag)`，否则只显示 `name`。

## 5. 参考实现（Node 18+ / 服务端）

### 5.1 只要最新版（推荐）

```js
const BASE = 'https://foldcraftlauncher.cn';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function getLatest(softwareId) {
  const index = await fetchJson(`${BASE}/data/down/${softwareId}/index.json`);
  // 有 default 用 default；否则用第一条（置顶条目通常没有 default）
  const entry = index.find((item) => item.default === true) ?? index[0];
  const payload = entry.nextUrl
    ? await fetchJson(new URL(entry.nextUrl, BASE).href) // 关键：用本站基址解析
    : null;
  // nextUrl 可能返回数组，也可能是 { items / children }；没有 nextUrl 时用条目自身的子节点
  const files = Array.isArray(payload)
    ? payload
    : (payload?.items ?? payload?.children ?? entry.children ?? entry.items ?? [entry]);

  return files
    .filter((file) => file.url ?? file.downloadUrl ?? file.link ?? file.download_link)
    .map((file) => ({
      name: file.name ?? file.file_name ?? '',
      arch: file.arch ?? file.architecture ?? '',
      size: file.size ?? file.size_bytes ?? null,
      url: file.url ?? file.downloadUrl ?? file.link ?? file.download_link,
      available: file.available !== false,
      description: file.description ?? file.unavailable_reason ?? '',
    }));
}

// getLatest(0).then(console.log);
```

### 5.2 展开整棵树（版本归档场景）

```js
async function flatten(nodes, trail = [], out = []) {
  for (const node of nodes) {
    const children = node.children ?? node.items;
    const label = node.name || node.tag || '';

    if (node.nextUrl) {
      const payload = await fetchJson(new URL(node.nextUrl, BASE).href);
      const list = Array.isArray(payload) ? payload : (payload.items ?? payload.children ?? []);
      await flatten(list, [...trail, label], out);
      continue;
    }
    if (Array.isArray(children) && children.length) {
      await flatten(children, [...trail, label], out);
      continue;
    }
    const url = node.url ?? node.downloadUrl ?? node.link ?? node.download_link;
    if (!url) continue;
    out.push({
      group: trail.filter(Boolean).join(' / '),
      name: node.name ?? node.file_name ?? '',
      arch: node.arch ?? node.architecture ?? '',
      size: node.size ?? node.size_bytes ?? null,
      url,
      available: node.available !== false,
      description: node.description ?? node.unavailable_reason ?? '',
    });
  }
  return out;
}

// const index = await fetchJson(`${BASE}/data/down/0/index.json`);
// const all = await flatten(index);
```

> 全量展开会请求所有历史版本文件（FCL 有几十个版本），只适合归档工具；普通下载页请用 5.1。

### 5.3 安全校验

下载链接来自外部数据，写进 `href` 前必须校验：

```js
const isSafe = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};
```

不要把 JSON 里的文本当 HTML 渲染。线路一的 `description` 一律按纯文本使用；本站只有在上游显式声明 `descriptionFormat: "html"` 时才做净化后渲染，线路一当前没有该字段。

## 6. 当前收录清单

入口固定为 `https://foldcraftlauncher.cn/data/down/{id}/index.json`。

| id | 软件 | 入口形态 | 备注 |
|---|---|---|---|
| 0 | Fold Craft Launcher | 版本索引 | 含置顶条目「最后一个有Boat后端的版本」 |
| 3 | Zalith Launcher 2 | 版本索引 | 自动同步 |
| 4 | Amethyst-Android | 版本索引 | 自动同步 |
| 7 | Pojav Launcher | 多级目录 | `index.json` 先指向 `Gladiolus release/index.json` |
| 8 | Android Openjdk Build | 直接清单 | `index.json` 即下载叶子数组 |
| 9 | Pojav FFmpeg Plugin | 直接清单 | 同上 |
| 10 | HMCL-PE | 直接清单 | 同上 |
| 11 | EnchantNet | 直接清单 | 同上 |
| 12 | Axe Minecraft Launcher | 版本索引 | 自动同步 |
| 14 | Mindustry | 内联分组 | 版本节点直接带 `children` |
| 15 | Axolotl Launcher | 版本索引 | 仅保留最新 3 个版本 |
| 16 | Acode | 版本索引 | 自动同步 |
| 17 | RikkaHub | 版本索引 | 自动同步 |

以下软件暂无线路一数据，请求会返回 404：id 1（MobileGlues）、2（Zalith Launcher）、5（Krypton Wrapper）、6（FCL Driver Plugin）、13（HMCL）。以实际请求结果为准。

## 7. 三种接入方式

### 方式 A：直接消费 JSON（任意技术栈）

按 §5 的实现读取并展示。服务端、构建期、Electron/CLI 都可以直接抓取；纯浏览器前端会受 CORS 限制，见 §8。

### 方式 B：复用本站代码（fork 本项目）

本站使用无 `apiVer` 的 plain 适配器解析线路一，因此 fork 后有两种做法：

**B1. 自己托管一份 JSON 副本（推荐）**

把线路一的目录同步进自己的仓库/站点（`data/down/{id}/`），`data/mirror.json` 保持：

```json
{
  "id": 0,
  "name": "站长提供 (huang1111)",
  "baseUrl": "/data/down",
  "description": "由 GitHub Actions 自动更新。"
}
```

并在对应软件的 `data/software/{id}/detail.json` 的 `download` 数组中引用：

```json
{ "mirrorId": 0, "key": "/0/index.json" }
```

因为 JSON 在自家域名下，`nextUrl` 的相对路径可直接解析，行为与本站一致，且没有跨域问题。同步方式可参考本站 `.github/workflows/auto-sync.yml`，或在构建期定时拉取。

**B2. 直接远程引用（需要重写 nextUrl）**

把 `baseUrl` 改成绝对地址：

```json
{ "id": 0, "name": "站长提供 (huang1111)", "baseUrl": "https://foldcraftlauncher.cn/data/down", "apiVer": "route1" }
```

此时**必须**补一个适配器，把上游返回的根相对 `nextUrl` 重写为绝对地址，否则它会被解析到你自己的站点：

```js
// js/adapters/download/route1.js
import { adaptPlain } from './plain.js';

export function adaptRoute1(payload, context) {
  const nodes = adaptPlain(payload, context);
  const rebase = (items) => items.map((item) => ({
    ...item,
    nextUrl: typeof item.nextUrl === 'string' && item.nextUrl.startsWith('/')
      ? new URL(item.nextUrl, context.baseUrl).href
      : item.nextUrl,
    children: Array.isArray(item.children) ? rebase(item.children) : item.children,
  }));
  return rebase(nodes);
}
```

并在 `js/adapters/download/index.js` 的注册表初始化时加入：

```js
import { adaptRoute1 } from './route1.js';

const ADAPTERS = new Map([
  // …原有项…
  ['route1', adaptRoute1],
]);
```

`context.baseUrl` 由 `js/repositories/downloadRepository.js` 按「入口 URL 的 origin」传入，因此二级目录返回的 `nextUrl` 也会被正确重写。

### 方式 C：只做外链跳转

不想解析数据时，直接把用户引导到本站下载页：

```text
https://foldcraftlauncher.cn/html/down.html?id=0
```

`id` 即上表的软件 id。没有跨域、没有数据同步成本，但用户会离开你的站点。

## 8. 跨域（CORS）、缓存与部署

### 8.1 实测结论

2026-10-31 对本接口发起 `GET/HEAD`（带 `Origin`）的实测结果：

- 返回 `200`，`Content-Type: application/json`；
- 带 `ETag`、`Last-Modified`；
- **没有 `Access-Control-Allow-Origin`**。

因此浏览器里跨域 `fetch` 会被拦截。可选的解决方式：

1. **服务端代理**（最常见）：自己的后端抓取并转发，同时加缓存；不要在浏览器里直连。
2. **构建期/定时抓取**：把 JSON 生成自己的静态副本，最稳定，也省流量。
3. **让站长加 CORS 头**（见 8.2）。
4. **不请求，直接外链**（方式 C）。

如果自行代理，请只放行 `GET`、限制软件 id 为数字、限制上游为 `foldcraftlauncher.cn`，避免变成任意 URL 代理。

### 8.2 站长侧可选配置

若本站部署在 nginx，可给目录加跨域与短缓存（示例，按实际配置调整）：

```nginx
location ^~ /data/down/ {
    add_header Access-Control-Allow-Origin "*" always;
    add_header Cache-Control "public, max-age=600" always;
}
```

即使开放了 `*`，接入方仍应保留自己的 URL 协议校验和域名白名单。

### 8.3 缓存建议

- 自动同步每天 3 次，建议缓存 10–30 分钟，不要秒级轮询；
- 复用 `ETag`：带 `If-None-Match` 条件请求，未变化时返回 `304`；
- 版本文件是快照，缓存时间可以比 `index.json` 更长；
- 不要长期缓存 `nextUrl` 与下载条目，旧版本可能被清理（见 §9）。

## 9. 维护特性与注意事项

- **数据可能滞后**：自动同步只覆盖 7 个软件，且依赖 Actions 运行；Release 发布后到 JSON 更新存在延迟。手动维护的条目更新更慢。
- **旧版本会被清理**：`Axolotl Launcher`（id 15）配置了只保留最新 3 个版本，超出部分会同时删除 JSON 条目、版本文件与网盘目录。**不要把具体版本路径写死**，始终从 `index.json` 进入。
- **层级会变化**：现在有版本索引、直接清单、内联分组、多级目录四种形态，未来可能新增字段或形态。解析器应忽略未知字段、递归处理 `children`/`nextUrl`，不要假设固定两级。
- **置顶条目**：`pinned: true` 的条目不参与版本排序，也不一定代表最新版本（例如 FCL 的 Boat 版本）。
- **直链稳定性**：`pan.huang1111.cn/f/{code}/{文件名}` 是公共直链，入口 URL 长期有效，通常 302 到真实下载服务器；文件是否保留由网盘策略决定，本站无法保证永久可用。
- **域名**：本文所有 URL 以 `https://foldcraftlauncher.cn` 为准。若本站更换域名，接入方应把基址做成配置项，不要散落在代码里。
- **404 处理**：软件不在收录清单、版本被清理、或路径拼错都会 404。接入方应把它当作「无数据」而非致命错误。

## 10. 署名与免责

- 建议在页面标注来源「线路一 · 站长提供 (huang1111)」并链接回 `https://foldcraftlauncher.cn`。
- 请勿把直链二次转存后收费或伪装成自有资源；下载流量由网盘承担，请尊重网盘的使用策略。
- 资源版权归各软件开发者所有。本站仅为公益性质的资源整合与分享站点，与 Mojang、微软及各启动器开发者均无隶属关系。
- 数据可能不完整或滞后，接入方需自行校验可用性并承担接入风险。

## 11. FAQ

**Q：`index.json` 返回 404？**
A：该软件没有线路一数据（见 §6），或该版本已被清理。

**Q：`nextUrl` 返回 404？**
A：多半是没有用本站基址解析。`nextUrl` 是根路径，必须拼 `https://foldcraftlauncher.cn`。

**Q：浏览器 `fetch` 报 CORS？**
A：接口当前不返回 `Access-Control-Allow-Origin`，请改用服务端代理、构建期抓取或外链方式，见 §8。

**Q：下载链接点开跳到了别的域名？**
A：`pan.huang1111.cn` 的直链会 302 到真实下载服务器，属正常行为。

**Q：有 SHA256 吗？**
A：线路一当前生成的版本文件只有 `name` / `arch` / `url` / `size`，不提供校验值。需要校验请以软件官方发布渠道为准。

**Q：能只拿最新版吗？**
A：可以。取 `default: true` 的条目（没有则取第一条），只请求它的 `nextUrl`，不要展开整棵树，见 §5.1。

**Q：能新增收录软件吗？**
A：本站收录与自动同步配置以仓库 `data/software.json`、`data/software/{id}/detail.json`、`scripts/auto-sync/softwares.json` 为准；可到 [Issues](https://github.com/XiaoluoFoxington/FCL.downsite.NEW/issues/new) 提交需求。
