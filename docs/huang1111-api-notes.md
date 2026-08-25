# huang1111 网盘 API 逆向解析（Cloudreve v3 定制版）

> 状态：3.8.5 已重测通过（e2e 12/12）；标注"仅 JS 发现"的端点未实测
> 记录日期：2026-08-25（3.8.5 重测 2026-08-26）
> 来源：真实登录态会话实测 + 前端 JS bundle 分析（`pan.huang1111.cn/static/js/`，`webpackJsonpcloudreve-frontend-pro`）
> 用途：支撑 `docs/auto-sync-design.md` 的自动化方案；所有调用已实测通过（除标注"仅 JS 发现"外）

---

## 0. 通用约定

### 0.1 Base URL

```
https://pan.huang1111.cn/api/v3
```

### 0.2 认证

- 全部 API 基于**会话 cookie**：`cloudreve-session`（`pan.huang1111.cn` 域）
- 请求需带 `credentials: include`（同源 fetch 默认带，跨域需显式）
- cookie 过期时 API 返回 `code: 401`（前端拦截器会跳转登录页）
- 登录用户信息同时存于 `localStorage.user`（JSON），含 `id`、`user_name`、`nickname`、`group`（等级、权限）

### 0.2.1 登录（3.8.5：账号密码 + 验证码 + CSRF）

3.8.5 起登录**必须**先取验证码（`GET /site/captcha`）再 POST，且所有写请求都要带 CSRF 头（见 0.2.2）。完整流程：

```
① GET  /site/captcha?_=<时间戳>      → data: "data:image/png;base64,..." + Set-Cookie 会话
② GET  /site/config                  → 响应头 x-csrf-token（此时拿到的 token 用于下面 POST）
③ POST /user/session                 → body {userName, Password, captchaCode}；cookies 带①的会话
```

- **验证码**：4 位字符 PNG（base64 in `data`）。识别用 OCR；识别结果需 `.upper()` + 过滤非 ASCII 字母数字（会把中文误识别进去），长度必须为 4，否则重取重试
- **登录失败重试**：`code: 40026`（Verification failed）多为验证码识别错误，重试时重新 GET captcha（captcha 一次性，且 GET captcha 可能**轮换会话 cookie**——必须用新 cookie 重新 GET /site/config 拿新 CSRF，再 POST）
- 实测 1~2 次即可登录成功（OCR 偶尔给出错误的 4 位猜测）；失败重试上限 10 次兜底
- 登录成功响应 `data.user_name` / `nickname` / `group` 可直接确认身份等级

### 0.2.2 CSRF（3.8.5 新增，写请求必须）

- **`GET /site/config` 是唯一已确认的 `x-csrf-token` 响应头来源**（前端用 axios，3.8.5 起对写请求统一校验该头）
- 每次写请求（POST/PUT/DELETE）前都应重新 `GET /site/config` 拿最新 token，并带 `X-CSRF-Token: <token>` 请求头
- 实测：`GET /site/config` **不会**轮换 cookie/token；同一 token 可复用于多次写请求；但登录或 GET captcha 轮换会话 cookie 后必须重取
- 漏带/带旧 token 的写请求 → `code: 40026`（Verification failed）

### 0.3 响应信封（所有 API 统一）

```jsonc
{
  "code": 0,        // 0=成功；非 0 见 0.4
  "data": ...,      // 成功时的业务数据
  "msg": ""         // 错误时的消息
}
```

### 0.4 常见错误码（实测 + JS i18n）

| code | 含义 |
|---|---|
| 0 | 成功 |
| 401 | 未登录 / 会话过期 |
| 40001 | 参数错误（Invalid input parameters） |
| 40016 | 路径不存在 / 对象不存在（Path not exist / Object not exist） |
| 40026 | 验证失败（Verification failed）：验证码识别错误 / 会话轮换后用了旧 cookie / 漏带或带旧 CSRF token |
| 40007 | 当前用户组无权限执行该操作 |
| 40008 | 站点配置缺失/异常（前端跳 /home） |

---

## 1. 列目录 — `GET /directory/{路径}`

获取指定路径下的文件/目录列表。

### 请求

```
GET /api/v3/directory/{路径}
```

- 根目录：`/api/v3/directory/`（路径为空）
- 路径**不要**以 `/` 开头（`directory//xxx` 会 40016）
- 路径中的特殊字符（空格、中文）不需要手动编码，直接拼接即可（实测 `/foldcraftlauncher_cn/FCL/1.3.2.7` 可用；带空格的目录名如 ` 1.2.5.0` 需用 `encodeURIComponent` 整段编码后拼接）

### 实测响应

```jsonc
{
  "code": 0,
  "data": {
    "parent": "ZqDKk8UX",           // 目录 id（实测：GET /directory/{name} 的 data.parent = 该目录自身 id，删除目录时用这个，见 §5.2）
    "objects": [
      {
        "id": "ZqDKk8UX",           // 文件/目录唯一 id（后续取直链用）
        "name": "FCL",              // 名称
        "path": "/foldcraftlauncher_cn/FCL",  // 完整路径
        "thumb": false,
        "size": 0,                  // 文件字节数；目录为 0
        "type": "dir",              // "dir" | "file"
        "date": "2026-01-01T01:05:18+08:00",
        "create_date": "2025-05-22T22:08:57+08:00",
        "source_enabled": false     // 是否支持生成直链（关键字段，见 §4）
      }
    ],
    "policy": {                     // 当前目录所属存储策略
      "id": "wVXuQ",
      "name": "V2直链空间（单文件上限2G）",
      "type": "remote",
      "max_size": 2147483648,       // 单文件上限 2GB
      "file_type": null
    }
  },
  "msg": ""
}
```

### 要点

- **`source_enabled`**：只有 `true` 的文件才能走 §4 取直链。实测 `foldcraftlauncher_cn` 整棵目录树的文件都是 `true`（因为存储策略是 V2 直链空间）；若文件在 SCx 自建存储则通常为 `false`
- `policy.max_size` 即当前直链空间单文件上限，可用于前置校验（FCL all 版 326MB < 2GB ✅）

---

## 2. URL 离线下载 — `POST /aria2/url`

从 URL（HTTP/HTTPS，含 GitHub 直链）拉文件到网盘指定目录，由网盘服务器执行。

### 请求

```
POST /api/v3/aria2/url
Content-Type: application/json

{
  "url": ["https://github.com/FCL-Team/FoldCraftLauncher/releases/download/1.3.2.8/FCL-release-1.3.2.8-armeabi-v7a.apk"],
  "dst": "/foldcraftlauncher_cn_auto/0/1/3/2/8",   // 自动根目录/软件id/版本逐位拆分（见 auto-sync-design.md）
  "preferred_node": 0
}
```

- `url`：**字符串数组**，可一次提交多个 URL（实测数组元素会逐个建任务）
- `dst`：目标目录完整路径（**不存在时会自动创建**，e2e 实测把文件下进了全新目录；3.8.5 已放开自动建目录）
- `preferred_node`：下载节点选择，`0` = 自动选择节点（前端 JS 里 `value:0` 对应"自动"）；实测不传/传 0 均成功

### 实测响应

```jsonc
{
  "code": 0,
  "data": [
    { "code": 0, "msg": "" }        // 每个 URL 一个结果；code 非 0 表示该任务提交失败
  ],
  "msg": ""
}
```

### 要点

- **提交响应不含 gid**：`data[]` 里只有 `{code,msg}`，没有任务 gid。gid 只能事后从 `GET /aria2/finished`（或 `/downloading`）里按 `files[0].path` 反查（e2e 已实现，见 §3.4 反查）
- ⚠️ 提交 POST 也必须带 CSRF 头（见 §0.2.2）；e2e 实测只需 CSRF，**不需要验证码**（验证码只用于登录和 `/file/source`）
- GitHub release 下载 URL（`https://github.com/.../releases/download/{tag}/{asset}`）实测可下载成功（README.md 6166 字节秒下；用户自测 164MB APK 也完成）
- 下载的**文件名 = URL 最后一段路径名**（`README.md`、`FCL-release-...apk`）
- ⚠️ **`dst` 会自动创建**（已实测，不再是 40016）；但自动化里仍建议显式 `PUT /directory` 建目录，既保证幂等又拿得到目录 id（见 §5.2）
- 并行上限：VIP2 年付 6（3.8.5 更新后升至 8）；超出会排队或失败（未实测超限行为）
- 结果数组与 `url` 数组一一对应，可逐项判断成功/失败

---

## 3. 下载任务状态

### 3.1 下载中 — `GET /aria2/downloading`

```
GET /api/v3/aria2/downloading
```

实测响应（无任务时）：

```jsonc
{ "code": 0, "data": [], "msg": "" }
```

有任务时 `data` 为任务对象数组（结构见 §3.3）。

### 3.2 已完成/历史 — `GET /aria2/finished`

```
GET /api/v3/aria2/finished?page=1
```

- `page`：从 1 开始，每页 10 条（前端逻辑 `t.data.length >= 10` 判断是否继续翻页）

### 3.3 任务对象结构（实测）

```jsonc
{
  "name": "README.md",                          // 文件名
  "gid": "6f492401808422ca",                    // aria2 任务 gid（提交响应里没有，只能靠反查拿到）
  "status": 4,                                  // 状态码（实测）：1=排队/等待中, 2=下载中, 4=完成, 5=失败/错误
  "dst": "/foldcraftlauncher_cn",               // 下载到的目录
  "error": "",                                  // 失败原因（空=无）
  "total": 6166,                                // 总字节数
  "files": [
    {
      "index": "1",
      "path": "README.md",                      // 文件相对路径
      "length": "6166",
      "completedLength": "6166",
      "selected": "true",
      "uris": [
        { "uri": "https://raw.githubusercontent.com/...", "status": "used" },
        { "uri": "...", "status": "waiting" }   // 同一 URL 的重试副本
      ]
    }
  ],
  "task_status": 4,
  "task_error": "",
  "create": "2026-08-25T14:13:23+08:00",
  "update": "2026-08-25T14:13:36+08:00",
  "node": "专用离线下载节点"
}
```

### 要点

- **任务完成判定**：`status === 4` 且 `error === ''` 且 `files[0].completedLength === files[0].length`
- 下载完成后文件出现在 `dst` 目录下，文件名 = `files[0].path`
- 可用 `dst` + `files[0].path` 拼出完整路径，供 §1 列目录定位文件 id

### 3.4 提交后如何拿到 gid（e2e 实测方案）

提交 `/aria2/url` 后**没有 gid**，轮询两种信号取其一：

1. **看目录**：`GET /directory/<dst目录名>`，`objects[]` 里出现我们的文件名 → 下载完成，`objects[0].id` 就是文件 id。
2. **看 finished**：`GET /aria2/finished?page=1`，按 `dst` + `files[0].path` 匹配本任务 → `gid` 反查成功，同时可读 `status`/`error` 判断成败。

e2e 判定规则：

- 每 2s 轮询一次，上限 ~100s（164MB APK 用时远小于此）
- 先查 finished：存在 `status === 5`（错误）且文件名匹配 → 判失败
- 再查目录：出现文件 → 判成功，并用 finished 里的 gid 补记任务号
- 两处都查到才算闭环（防止 finished 页暂未刷新导致误判）

---

## 4. 批量取直链 — `POST /file/source`

获取一个或多个文件的直链（公共可访问，无需登录）。

### 请求

```
POST /api/v3/file/source
Content-Type: application/json

{
  "items": ["zdobenu1"],        // 文件 id 数组（来自 §1 的 objects[].id）
  "captchaCode": "XXXX"         // ⚠️ 3.8.5 起必需：最新验证码（见下）
}
```

- 头部必需：`X-CSRF-Token: <来自 GET /site/config 的最新 token>`（见 §0.2.2 CSRF）
- ⚠️ **`items` 是文件 id 数组，不是路径**（前端代码 `c = selected.filter(e => e.source_enabled && e.type==="file").map(e => e.id)`）

### 3.8.5 实测补充：需要 验证码 + CSRF（重要）

取直链虽然是"读"操作，但 3.8.5 站点要求带最新验证码 + CSRF token，否则报错：

- 请求体带 `captchaCode`：验证码来源与登录共用 `GET /site/captcha` → OCR（大写 + 过滤非字母数字，期望长度 4）
- 头部带 `X-CSRF-Token`：删/改类请求同款（详见 §0.2.2），建议每次取直链前都 GET 一次 `/site/config` 拿最新 token
- ⚠️ **验证码一次性**：每次校验（无论对错）后即作废，**同码重试必败**（40026）；失败只能换新验证码再来
- ⚠️ **OCR 误读率高，必须失败重试**（2026-08-26 实测）：OCR 对这类图误读约 50%（V↔Y、6↔B、漏字符；真实验证码恒为 4 位）。`POST /file/source` 偶发 `40026` 大多是 OCR 认错字，不是流程错。正确姿势：按登录同款循环，**失败就换新验证码重试（e2e 上限 10 次，大力出奇迹）**；OCR 结果长度≠4 直接判定必错，换图重来，不浪费 POST
- 若 session 在登录后被轮换过，需先重取 captcha + 重新 GET /site/config

### 实测响应

```jsonc
{
  "code": 0,
  "data": [
    {
      "id": "zdobenu1",                          // 文件 id（回显）
      "url": "https://pan.huang1111.cn/f/z2mwtE/FCL-release-1.3.2.7-arm64-v8a.apk",
      "name": "FCL-release-1.3.2.7-arm64-v8a.apk",
      "parent": 4610440            // 文件父级数字 id（用途不明）
    }
  ],
  "msg": ""
}
```

- 返回**不含 size**；文件大小要走 §1 `GET /directory` 的 `objects[].size`
- 直链 `https://pan.huang1111.cn/f/{code}/{name}` 长期有效、无需登录

### 要点

- 一次可批量传多个文件 id（前端有 `group.sourceBatch` 上限，实测 VIP2 的 `sourceBatch` 为 10000）
- **`url` 是长期有效的公共直链**：
  - 无需登录即可访问（实测无 cookie 的 curl 302 正常）
  - 302 重定向到真实下载服务器：`https://download-sc1.huang1111.cn/api/v3/slave/source/{...}?sign=...`（签名带时间戳，但入口 `/f/` URL 长期有效）
  - 实测 2026-04 上传的文件直链，2026-08 仍可访问
- 返回顺序与 `items` 一致

---

## 5. 目录创建/删除

### 5.1 创建目录 — `PUT /directory`

```
PUT /api/v3/directory
Content-Type: application/json

{ "path": "/foldcraftlauncher_cn_auto/1/3/2/8" }
```

- ⚠️ 是 **PUT** 不是 POST（`POST /directory` 实测 404）
- ⚠️ 写请求需带 CSRF：先 GET `/site/config` 拿最新 `x-csrf-token` 再 PUT（见 §0.2.2）
- 请求体只需 `path`（目标目录完整路径，会连同中间目录一起创建）
- **删除目录时用的 id** 在创建后用 `GET /directory/{路径}` 的 `.data.parent` 拿（等于该目录对象 id；见 §1）

### 5.2 删除文件/目录 — `DELETE /object`

删除一个或多个文件/目录。

### 请求

```
DELETE /api/v3/object
Content-Type: application/json

{
  "items": ["O37jlEhz"],     // 文件 id 数组
  "dirs": [],                // 目录 id 数组（删除目录时用，必须传 id 不能传名称）
  "force": true,             // 实测：并不能跳过回收站，删除后文件仍进回收站（48h 自动清除）
  "unlink": false            // 彻底删除开关（未深究，保持 false）
}
```

### 实测响应

```jsonc
{ "code": 0, "data": null, "msg": "" }
```

### 要点

- 实测删除根目录文件成功（README.md，id=`8d6mPLtv`），HTTP 200 + `code: 0`
- `items` 传**文件 id**，`dirs` 传**目录 id**（同 `file/source` 的约定；目录 id 来自 §1 的 `GET /directory` 响应 `.data.parent` 或列表里的 `id`）
- ⚠️ **每次 DELETE 前必须重取 CSRF**：必要时先 GET `/site/config` 拿最新 token（漏带/旧 token → `40026`）
- **`force:true` 实测并不绕过回收站**：文件仍出现在回收站（`purge_status: "ready"`，48 小时后自动清除）。本端删除低频，按 `{force:true, unlink:false}` 删除会把文件放进回收站等待自动清理，符合"不留永久垃圾"预期
- **`dirs` 必须传 id 不能传名称**：传目录名 → `40016`（probe4 教训）
- 测试脚本用此端点**自动清理测试产生的文件**，网盘不留垃圾（e2e 第⑧步实测通过：删文件 + 删目录 + 再列目录确认 `40016`）

---

## 6. 直链前置条件（重要）

官方文档 + 实测确认：

| 条件 | 说明 |
|---|---|
| 文件所在存储策略 | 必须在**直链空间**（如 V2 直链空间），SCx 自建存储不支持直链 |
| 单文件大小 | ≤ 会员直链上限（VIP2 年付 = 2GB） |
| 用户组权限 | `group.allowShare`（分享/直链权限） |

`source_enabled` 字段可直接判断：`true` 才能取直链。

---

## 7. 前端 JS 中发现但**未实测**的端点（3.8.5 前代码）

以下端点从 `main.51b96baf.chunk.js` / chunks 中提取，供参考；**未在本会话实测**，使用时需自行验证（创建目录已实测，见 §5.1）：

| 用途 | 方法/路径 | 请求体（来自 JS） |
|---|---|---|
| 磁力/种子离线下载 | `POST /aria2/torrent/{torrentId}` | `{dst, preferred_node}` |
| 选择下载任务中的文件 | `PUT /aria2/select/{gid}` | `{indexes: [...]}` |
| 删除下载任务 | `DELETE /aria2/task/{gid}` | — |
| 用户信息 | `GET /me` | — （⚠️ 实测 `/api/v3/me` 返回 404，此端点可能已变更或需特殊头） |
| 目录搜索 | `GET /file/search/{关键词}` | — |
| 分享列表 | `GET /share/list/{shareKey}` | — |
| 分享预览 | `GET /share/preview/{key}?path=...` | — |
| 上传会话 | `POST /file/upload`（Cloudreve 标准） | 未在本站验证 |

---

## 8. 已验证的完整自动化调用链（3.8.5 重测通过，e2e 12/12）

```
① GET  /site/captcha + OCR + GET /site/config            → 登录（含验证码+CSRF，失败重试≤5次）
② PUT  /directory        {path:"/foldcraftlauncher_cn_auto/0/1/3/2/8"}  → 建目录（幂等）
③ GET  /directory/...    → 拿目录 id（.data.parent），确认已存在（去重）
④ POST /aria2/url        {url:[...], dst:"...", preferred_node:0}   → 提交离线下载（响应无 gid）
⑤ GET  /aria2/finished?page=1 + GET /directory/{dst}     → 轮询：finished.status==4/5 或目录出现文件（反查 gid）
⑥ GET  /directory/{dst}  → 按文件名匹配，拿新文件 id + size
⑦ GET  /site/captcha + OCR + GET /site/config            → 取直链前重取 验证码 + CSRF
⑧ POST /file/source      {items:[id...], captchaCode}    → 批量取直链（带 X-CSRF-Token）
⑨ 写 data/down JSON + git push
⑩ DELETE /object         {items:[id...], dirs:[dirId...], force:true}  → 删除测试/临时文件（重取 CSRF）
```

---

## 9. 踩坑记录

| 坑 | 现象 | 解决 |
|---|---|---|
| **JSON body 带 BOM** | `code: 40001` 参数错误 | body 必须无 BOM（`UTF8Encoding($false)` 写入） |
| **PowerShell 传参剥引号** | 请求体变成 `{items:[id]}` 缺引号 → 40001 | body 写入临时文件，脚本从文件读取 |
| **目录路径多前导斜杠** | `directory//foldcraftlauncher_cn` → `40016 Path not exist` | 路径去前导 `/` |
| **目录名含空格/特殊字符** | ` 1.2.5.0`（前导空格）直接拼接可能失败 | 整段 `encodeURIComponent` 后拼接 |
| **BiDi awaitPromise 不生效** | `JSON.stringify(async fn)` 返回 `{}` | 两步式：先注入 `window.__out=null; (fn).then(r=>window.__out=r)`，再轮询读取 |
| **items 传路径** | `POST /file/source {items:["/路径"]}` → 40001 | items 必须是**文件 id** |
| **GET /source/{path}** | 404 | 取直链是 `POST /file/source`，不是 `GET /source/{path}` |
| **POST /directory** | 404 | 创建目录是 **`PUT /directory`**，body 只传 `{path}`（§5.1） |
| **DELETE /object/{id}** | 404 | 删除是 **`DELETE /object`**，body 传 `{items:[文件id], dirs:[目录id]}`（§5.2） |
| **dirs 传目录名** | `40016` | `dirs` 必须传**目录 id**（来自 §1 `.data.parent`），不能传名称 |
| **提交 aria2 后拿 gid** | 提交响应里没有 gid | 按 §3.4：轮询 `finished` + 目录出现文件来反查 |
| **file/source 漏验证码/CSRF** | 报错（`40026` 类） | 3.8.5 起取直链也要 `captchaCode` + `X-CSRF-Token`（§4） |
| **file/source 验证码一次性 + OCR 误读** | 偶发 `40026`；**同码重试必败**（验证码已作废） | 失败**换新验证码**重试（e2e 上限 10 次）；OCR 长度≠4 直接换图（§4） |
| **DELETE 漏 CSRF** | `40026` | 每次写请求前 GET `/site/config` 重取 token（§0.2.2） |
| **force:true 想跳过回收站** | 文件仍进回收站（purge_status: ready） | 接受"进回收站 48h 后自动清除"，或按需处理回收站（§5.2） |

---

## 10. 3.8.5 更新影响（2026-08-26 01:00-04:00 站点关闭）—— 重测结论

官方预告（blog 文章 74）涉及 API 可能变动的点，**3.8.5 实机重测结果如下**：

| 预告点 | 实测结论 |
|---|---|
| 1. 直链系统重构 | `POST /file/source` **仍在用**，但请求需新增 `captchaCode` + `X-CSRF-Token`（此前不带也能成功）；响应结构不变（`{id,url,name,parent}`） |
| 2. 离线下载重构 | `POST /aria2/url` **仍在用**，行为变化：`dst` 目录不存在时会**自动创建**（此前 40016）；提交响应仍无 gid，需轮询反查 |
| 3. 新增工具箱（GitHub 下载） | 不影响本方案端点 |
| 4. 权益升级（并行 6→8） | 不影响本方案（单任务串行） |

**认证变化（3.8.5 新增，最重要）**：

- 登录改为 账号密码 + 图形验证码（`/site/captcha`）+ CSRF（`/site/config`），流程见 §0.2.1 / §0.2.2
- **所有写请求（POST/PUT/DELETE）都要带 `X-CSRF-Token`**，否则 `40026`
- 登录/验证码 GET 会轮换 session cookie，CSRF 头必须用最新 token；建议每次写请求前都 GET 一次 `/site/config`

**§1~§4 兼容性：全部通过**（e2e 12/12：登录 → 建目录 → aria2 提交 → 离线下载完成 → 列目录 → 取直链 → HTTP 验证 → 删除清理）。
