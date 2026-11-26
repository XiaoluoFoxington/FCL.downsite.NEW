# 创想镜像 API v3 接入文档

> 版本：v3
> 更新日期：2026-11-26
> 适用对象：第三方程序、脚本、客户端、网站前端
> 人机验证：CXCAPTCHA PoW（工作量证明）

---

## 1. 概述

创想镜像为 Minecraft 启动器提供公益镜像加速下载服务。API v3 面向第三方程序开放，提供以下能力：

- 读取启动器清单、版本信息与文件列表
- 读取可用下载节点及其健康检查、流量统计地址
- 读取人机验证服务的调用参数
- 在通过 PoW 人机验证后下载真实文件

**公共接口 Base URL**

```text
https://cxmc.net/api/pub/v3/
```

**验证服务 Base URL**

```text
https://captcha.cxsjmc.cn/api/public/v1/
```

### 1.1 设计目标

与 API v2 相比，v3 围绕三个目标重新组织：

1. **地址预拼装。** 所有对外地址在服务端构建阶段完成拼接，响应中直接给出可直接请求的绝对地址，接入方不再需要按规则组合域名、目录与文件名。
2. **精简字段。** 公共接口仅返回接入所需字段，运营数据、前端渲染常量与服务端实现细节不下发。
3. **公私分离。** 对外公共接口与站内私有接口分属不同命名空间，公共接口的字段一经发布不再变更，站内接口可随官网迭代演进，二者由同一份数据源生成，避免数据不一致。

### 1.2 命名空间

| 命名空间 | 前缀 | 用途 | 稳定性 |
| :--- | :--- | :--- | :--- |
| 公共接口 | /api/pub/v3/ | 对外开放，供第三方接入 | 字段只增不删，破坏性变更升级主版本 |
| 私有接口 | /api/v3/ | 官网前端内部使用 | 随官网迭代，不对外承诺稳定性 |

本文档描述公共接口。私有接口的用途与边界见第 9 章。

---

## 2. 基础约定

### 2.1 数据格式与编码

- 所有请求与响应均使用 application/json; charset=utf-8
- 除特别说明外，所有接口均为 GET 请求
- 字段命名统一使用小驼峰（camelCase）
- 文件路径字段统一以斜杠开头，例如 /FCL/FCL-release-latest-arm64-v8a.apk
- 时间字段统一使用 ISO 8601 格式并带时区偏移，例如 2026-11-26T13:00:00+08:00

### 2.2 跨域策略

全部接口开放跨域访问：

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

预检请求（OPTIONS）返回 204，不产生响应体。

### 2.3 缓存策略

| 接口 | 建议缓存时长 | 说明 |
| :--- | :--- | :--- |
| catalog/ | 10 分钟 | 聚合视图，随版本发布与节点变更更新 |
| launchers/ | 10 分钟 | 启动器与文件清单 |
| nodes/ | 5 分钟 | 节点上下线需要及时反映 |
| captcha/ | 1 小时 | 验证服务参数极少变更 |
| github/<id>/ | 10 分钟 | 上游版本信息 |
| doc/ | 1 天 | 接口文档 |

服务端已在响应中给出 Last-Modified，接入方可通过 If-Modified-Since 做条件请求以降低开销。

### 2.4 版本策略

- 公共接口主版本号包含在路径中，当前为 v3
- 同一主版本内新增字段不视为破坏性变更，接入方应忽略未知字段
- 字段的删除、重命名与语义变更将升级主版本
- 历史版本不随新版发布下线，v1 与 v2 继续提供原有服务，字段与地址保持不变，仅修复缺陷，不再新增能力

### 2.5 请求频率

下表为建议的请求频率，正常接入遵循 2.3 的缓存时长即可远低于该频率：

| 请求类型 | 建议频率 | 说明 |
| :--- | :--- | :--- |
| 公共数据接口 | 单 IP 不超过 60 次/分钟 | 数据变更频率低，无需高频轮询 |
| 文件下载 | 单 IP 不超过 10 次/分钟 | 以节点实际配置为准 |
| 节点健康检查 | 单 IP 不超过 120 次/分钟 | 用于节点测速与存活判断 |

服务端可能对异常高频的请求返回 429 Too Many Requests，响应头 Retry-After 给出建议等待秒数，接入方应据此退避后重试。

---

## 3. 地址规范

下载地址分为三种用途，公共接口已为每种用途给出可直接使用的绝对地址。

### 3.1 分享页地址（page）

面向人的访问地址，打开后是创想镜像的下载页面，页面自动完成节点测速与人机验证，并在验证通过后开始下载。适用于在网页、文档或聊天窗口中分享。

```text
https://cxmc.net/<launcher.dir>/<file.file>
```

该地址由页面逻辑处理，服务器直接返回 404 状态码与下载页面，属于预期行为。程序不应将此地址作为文件流来源。

### 3.2 节点直连地址（downloads）

面向程序的真实文件地址，响应体为文件流。适用于命令行工具、第三方启动器内置更新器等场景。

```text
https://<node.host>/<launcher.dir>/<file.file>
```

未通过人机验证时返回 302，响应头 location 指向验证页面：

```text
HTTP/2 302
location: https://captcha.cxsjmc.cn/verify?redirect=<URL 编码后的本地址>
```

必须先在验证服务完成 PoW 计算，使客户端 IP 进入白名单，再请求该地址才会返回 200（无 Range）或 206（带 Range）。

**程序实现要求：** 判断下载是否真正开始，应依据状态码是否为 200 或 206，而不能仅依据请求是否成功。curl 默认不跟随 302，会直接得到 419 字节的跳转页；开启 -L 则会下载到验证页面。两种情况都不会得到文件流。

### 3.3 多线程下载地址（multithread）

面向浏览器的分段下载入口，适用于需要断点续传或分段并发的大文件。

```text
https://cxmc.net/download/?file=<file.path>
```

该字段仅在启动器支持多线程下载时返回，否则为 null。程序化场景建议使用 3.2 的节点直连地址。

### 3.4 占位符约定

部分字段以模板形式给出，占位符使用尖括号表示，替换时不需要再次进行 URL 编码以外的处理。

| 占位符 | 含义 | 示例取值 |
| :--- | :--- | :--- |
| <path> | 文件路径，取自 file 条目的 path 字段 | /FCL/FCL-release-latest-arm64-v8a.apk |
| <url> | 需要验证后访问的完整地址 | 节点直连地址 |
| <id> | 启动器标识，取值为 FCL、HMCL、ZL、MG | FCL |
| <ip> | 客户端公网 IP，缺省时由服务端依据来源地址判定 | 203.0.113.10 |

---

## 4. 公共接口

### 4.1 接口索引

**端点**

```text
GET https://cxmc.net/api/pub/v3/
```

返回当前版本全部公共接口的清单与地址，可用于接入方自检与文档导航。

```json
{
  "api": {
    "name": "创想镜像公共 API",
    "version": "v3",
    "scope": "public",
    "base": "https://cxmc.net/api/pub/v3/",
    "generatedAt": "2026-11-26T13:00:00+08:00",
    "doc": "https://cxmc.net/api/pub/v3/doc/",
    "markdown": "https://cxmc.net/api.md"
  },
  "endpoints": [
    {
      "id": "catalog",
      "url": "https://cxmc.net/api/pub/v3/catalog/",
      "desc": "聚合视图：站点、节点、启动器与全部下载地址，一次请求即可完成接入。"
    }
  ],
  "compatibility": {
    "v2": { "base": "https://cxmc.net/api/v2/", "state": "保留可用，不再演进" }
  }
}
```

### 4.2 聚合视图 catalog/

**端点**

```text
GET https://cxmc.net/api/pub/v3/catalog/
```

一次请求返回站点信息、验证服务参数、可用节点与全部启动器文件，其中每个文件条目已包含针对每个节点的直连地址。接入方仅需一次请求即可完成地址选择。

```json
{
  "api": { "version": "v3", "generatedAt": "2026-11-26T13:00:00+08:00" },
  "site": {
    "home": "https://cxmc.net",
    "multiThread": "https://cxmc.net/download/?file=<path>"
  },
  "captcha": {
    "origin": "https://captcha.cxsjmc.cn",
    "verifyUrl": "https://captcha.cxsjmc.cn/verify?redirect=<url>",
    "healthUrl": "https://captcha.cxsjmc.cn/api/health",
    "whitelistCheckUrl": "https://captcha.cxsjmc.cn/api/public/v1/whitelist/check",
    "powStartUrl": "https://captcha.cxsjmc.cn/api/public/v1/pow/start",
    "powSubmitUrl": "https://captcha.cxsjmc.cn/api/public/v1/pow/submit",
    "whitelistTtlSeconds": 60
  },
  "nodes": [ /* Node[]，结构见 4.4 */ ],
  "launchers": [ /* Launcher[]，结构见 4.3，含 downloads */ ]
}
```

### 4.3 启动器清单 launchers/

**端点**

```text
GET https://cxmc.net/api/pub/v3/launchers/
```

返回启动器及其文件清单。本接口的文件条目不包含按节点展开的直连地址，需要直连地址时请使用 4.2 的聚合视图。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| id | string | 启动器标识，如 FCL |
| name | string | 启动器完整名称 |
| abbr | string | 徽标缩写 |
| description | string | 启动器简介 |
| repo | string | 上游仓库，格式为 owner/repo；无上游时为空字符串 |
| version | string | 当前镜像版本号，与上游发布标签一致 |
| publishedAt | string | 上游发布日期，ISO 8601；无上游信息时为 null |
| directDownload | boolean | 是否提供节点直连下载 |
| multithread | boolean | 是否支持多线程下载 |
| files | File[] | 文件列表 |

文件条目（File）字段：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| file | string | 文件名 |
| label | string | 展示名称，含平台与架构信息 |
| arch | string | 目标架构，取值 arm64-v8a、armeabi-v7a、x86、x86_64、all |
| kind | string | 文件类型，取值 apk、exe、jar、deb、sh |
| size | number | 文件字节数；镜像尚未落盘时为 null |
| sha256 | string | SHA-256 校验值；上游未提供时为 null |
| page | string | 分享页地址，见 3.1 |
| path | string | 文件路径，用于替换 <path> 占位符 |
| multithread | string | 多线程下载地址，不支持时为 null |

### 4.4 节点清单 nodes/

**端点**

```text
GET https://cxmc.net/api/pub/v3/nodes/
```

仅返回当前开放下载的节点。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| id | string | 节点标识，如 bj |
| name | string | 节点中文名称，如 北京 |
| host | string | 节点域名，如 bj.mirror.cxsjmc.cn |
| base | string | 节点根地址，如 https://bj.mirror.cxsjmc.cn |
| health | string | 健康检查地址，见 4.7 |
| stats | string | 流量统计地址，见 4.8 |
| bandwidth | string | 节点带宽，如 100Mbps |
| launchers | string[] | 该节点服务的启动器标识，* 表示全部 |

### 4.5 验证服务配置 captcha/

**端点**

```text
GET https://cxmc.net/api/pub/v3/captcha/
```

返回人机验证服务的全部调用参数，字段均为绝对地址，无需再次拼接。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| origin | string | 验证服务根地址 |
| verifyUrl | string | 验证页面地址模板，将 <url> 替换为待访问地址 |
| healthUrl | string | 验证服务健康检查地址 |
| whitelistCheckUrl | string | 白名单查询地址，见 5.1 |
| powStartUrl | string | PoW 会话创建地址，见 5.2 |
| powSubmitUrl | string | PoW 答案提交地址，见 5.2 |
| whitelistTtlSeconds | number | 白名单有效期，单位为秒 |
| redirectParam | string | 验证页面的跳转参数名 |

### 4.6 上游版本信息 github/<id>/

**端点**

```text
GET https://cxmc.net/api/pub/v3/github/FCL/
```

返回指定启动器上游发布的精简信息，<id> 取值为 FCL、HMCL、ZL、MG。该接口用于在不直接访问 GitHub 的情况下获知上游版本与文件校验值。

```json
{
  "project": "FCL",
  "version": "1.3.4.8",
  "publishedAt": "2026-11-22T03:03:46Z",
  "fetchedAt": "2026-11-26T12:52:00+08:00",
  "assets": [
    {
      "name": "FCL-release-1.3.4.8-arm64-v8a.apk",
      "size": 168885844,
      "sha256": "9f097d470fb3a4da91f3411691242758...",
      "url": "https://github.com/FCL-Team/FoldCraftLauncher/releases/download/1.3.4.8/FCL-release-1.3.4.8-arm64-v8a.apk"
    }
  ]
}
```

### 4.7 节点健康检查 _health

**端点**

```text
GET https://<node.host>/_health
```

用于判断节点是否可用，返回：

```json
{ "ok": true }
```

- 节点必须允许跨域访问
- 节点必须在 4 秒内返回，接入方应以此作为超时上限
- 任何非 { "ok": true } 的响应均视为不健康
- 建议同时请求全部候选节点，取首个返回健康者，以缩短等待时间

### 4.8 节点流量统计 stats.json

**端点**

```text
GET https://<node.host>/stats.json
```

```json
{
  "daily_bytes": 12884901888,
  "total_bytes": 962072674304,
  "daily_requests": 12480,
  "total_requests": 891234
}
```

统计为节点侧累计值，仅用于展示，不参与下载流程。

---

## 5. 人机验证

为防止爬虫与流量滥用，所有真实文件下载请求都会校验客户端 IP 是否处于白名单中。第三方程序通过 PoW 计算获得有效期为 60 秒的白名单资格。

验证服务与镜像服务使用各自独立的路径前缀：镜像接口位于 /api/pub/v3/，验证服务公共接口固定为 /api/public/v1/。接入方不应假定两者前缀一致，所有验证服务地址均以 catalog 响应的 captcha 字段为准。

### 5.1 白名单查询

**端点**

```text
GET https://captcha.cxsjmc.cn/api/public/v1/whitelist/check?ip=<client_ip>
```

参数 ip 可选，缺省时由服务端依据来源地址判定。

```json
{
  "ip": "203.0.113.10",
  "whitelisted": true,
  "blocked": false,
  "expires_in": 60
}
```

### 5.2 PoW 验证流程

**第一步：创建会话**

**端点**

```text
POST https://captcha.cxsjmc.cn/api/public/v1/pow/start
```

```json
// 请求
{ "redirect": "https://captcha.cxsjmc.cn/verify?redirect=<URL 编码后的下载地址>" }

// 响应
{
  "ok": true,
  "session_id": "123e4567-e89b-12d3-a456-426614174000",
  "challenge": "a1b2c3d4e5f6...",
  "difficulty": 24
}
```

**第二步：本地计算 nonce**

对字符串 <challenge>:<nonce> 计算 SHA-256，其摘要的前导零二进制位数必须不小于 difficulty。nonce 从 0 开始递增。

```javascript
function leadingZeroBits(bytes) {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) { count += 8; continue; }
    count += Math.clz32(b) - 24;
    break;
  }
  return count;
}
```

**第三步：提交答案**

**端点**

```text
POST https://captcha.cxsjmc.cn/api/public/v1/pow/submit
```

```json
// 请求
{ "session_id": "123e4567-e89b-12d3-a456-426614174000", "nonce": 12345678 }

// 成功
{ "ok": true, "finished": true }
```

提交成功后，客户端 IP 立即进入白名单，有效期为 60 秒。接入方必须在该有效期内发起真实文件下载，超时后需重新计算。

---

## 6. 完整接入流程

以下流程使用聚合视图，全程仅需一次数据请求。

```text
阶段 1：获取接入数据
  GET https://cxmc.net/api/pub/v3/catalog/
  → 取 captcha 字段作为验证服务参数
  → 取 launchers 中目标启动器与目标文件
  → 取该文件的 downloads 数组作为候选直连地址

阶段 2：选择节点
  1. 并发请求 downloads 中每个节点的 health 地址（超时 4 秒）
  2. 取首个返回 { "ok": true } 的节点
  3. 全部失败时，提示服务不可用或稍后重试

阶段 3：人机验证
  1. GET captcha.whitelistCheckUrl，确认当前 IP 是否已在白名单
  2. 未在白名单时，POST captcha.powStartUrl 创建会话
  3. 本地计算 nonce，POST captcha.powSubmitUrl 提交

阶段 4：发起下载
  GET 已选节点的直连地址
  → 200 或 206：读取文件流，可用 sha256 字段校验完整性
  → 302：白名单已失效，返回阶段 3 重新验证
  → 404：文件或目录不存在，检查 path 字段
  → 503：节点维护，改用其余候选节点
```

---

## 7. 接入代码示例

以下示例演示从获取数据到下载落盘的完整过程（Node.js 18 及以上）。

```javascript
const crypto = require('crypto');
const fs = require('fs');

const CATALOG_URL = 'https://cxmc.net/api/pub/v3/catalog/';

function leadingZeroBits(buf) {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) { count += 8; continue; }
    count += Math.clz32(b) - 24;
    break;
  }
  return count;
}

function solvePow(challenge, difficulty) {
  let nonce = 0;
  for (;;) {
    const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= difficulty) return nonce;
    nonce += 1;
  }
}

async function pickNode(downloads) {
  const results = await Promise.all(downloads.map(async (item) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`https://${new URL(item.url).host}/_health`, { signal: controller.signal });
      const data = await res.json();
      return data.ok === true ? item : null;
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }));
  return results.find((item) => item !== null) || null;
}

async function ensureWhitelist(captcha, targetUrl) {
  const check = await fetch(`${captcha.whitelistCheckUrl}`).then((res) => res.json());
  if (check.whitelisted) return;

  const start = await fetch(captcha.powStartUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect: targetUrl })
  }).then((res) => res.json());

  const nonce = solvePow(start.challenge, start.difficulty);

  await fetch(captcha.powSubmitUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: start.session_id, nonce })
  });
}

async function download(fileName, outputPath) {
  const catalog = await fetch(CATALOG_URL).then((res) => res.json());
  const launcher = catalog.launchers.find((item) =>
    item.files.some((file) => file.file === fileName));
  if (!launcher) throw new Error(`未找到文件：${fileName}`);

  const file = launcher.files.find((item) => item.file === fileName);
  const node = await pickNode(file.downloads);
  if (!node) throw new Error('无可用下载节点');

  await ensureWhitelist(catalog.captcha, node.url);

  const res = await fetch(node.url);
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`下载未开始，HTTP ${res.status}`);
  }

  const stream = fs.createWriteStream(outputPath);
  for await (const chunk of res.body) stream.write(chunk);
  await new Promise((resolve) => stream.end(resolve));
  return file.sha256;
}
```

---

## 8. 错误码

### 8.1 公共数据接口

| HTTP | 含义 | 处理建议 |
| :--- | :--- | :--- |
| 200 | 成功 | 正常解析 |
| 304 | 内容未变更 | 使用本地缓存 |
| 404 | 接口或资源不存在 | 检查路径拼写与版本号 |
| 429 | 请求过多 | 按 Retry-After 等待后重试 |
| 500 | 服务端错误 | 重试三次，采用指数退避 |

### 8.2 人机验证接口

| error 字段 | 含义 | 处理建议 |
| :--- | :--- | :--- |
| wrong | nonce 不满足难度要求 | 重新计算并提交 |
| expired | 会话已过期 | 重新创建会话 |
| blocked | 来源 IP 已被封禁 | 等待 block_remaining 秒后重试 |

### 8.3 下载接口

| HTTP | 含义 | 处理建议 |
| :--- | :--- | :--- |
| 200 | 成功，无 Range 请求 | 读取文件流 |
| 206 | 成功，带 Range 请求 | 读取分段数据 |
| 302 | 未通过人机验证，location 指向验证页 | 返回第 5 章重新验证 |
| 404 | 文件或目录不存在 | 检查 path 字段拼写 |
| 503 | 节点维护中 | 切换至其余候选节点 |

---

## 9. 命名空间与兼容性

### 9.1 公共接口

公共接口位于 /api/pub/v3/，字段以本文档为准，属于对外承诺的稳定接口。

### 9.2 私有接口

私有接口位于 /api/v3/，供官网前端内部使用，包含运营字段（节点成本、广告位、页面文案）与渲染所需的实现细节，其字段随官网迭代调整，不对外承诺稳定性，接入方不应依赖。

| 端点 | 内容 |
| :--- | :--- |
| /api/v3/site/ | 站点常量、界面参数、广告与文案 |
| /api/v3/launchers/ | 启动器全量元数据，含版本转换策略 |
| /api/v3/nodes/ | 节点全量数据，含成本、聚合标记 |
| /api/v3/captcha/ | 验证服务全量配置 |
| /api/v3/meta/ | 构建元数据、数据版本与告警 |
| /api/v3/github/<id>/ | 精简上游版本信息 |

公共接口与私有接口由同一份源数据构建生成，二者内容保持一致，差异仅在于字段裁剪与地址预拼装。

### 9.3 版本兼容

- API v2 继续提供，地址与字段保持不变，仅修复缺陷，不再新增能力
- API v1 继续提供，仅保留原有地址清单；该清单中的地址为分享页地址，访问返回下载页而非文件流，不再演进
- 验证服务公共接口固定为 /api/public/v1/，为唯一对外路径
- 镜像服务公共接口固定为 /api/pub/v3/，与验证服务的路径规则相互独立
- 新接入项目应直接使用 v3

---

## 10. 变更日志

| 版本 | 日期 | 变更 |
| :--- | :--- | :--- |
| v3 | 2026-11-26 | 新增公共命名空间与私有命名空间；地址预拼装，提供聚合视图；精简对外字段；文件条目增加大小与 SHA-256 校验值；接口地址统一为目录形式；验证服务公共接口固定为 /api/public/v1/ |
| v2 | 2026-10-19 | 数据查询接口全部公开；引入 CXCAPTCHA PoW 人机验证；区分分享页与真实文件流 |
| v1 | 2025-12-01 | 初始版本 |

文档维护：创想世界
问题反馈：cxsjmc@qq.com
