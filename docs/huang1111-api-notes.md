# huang1111 网盘 API 逆向解析（Cloudreve v3 定制版）

> 状态：逆向笔记（随 3.8.5 更新需重新验证）
> 记录日期：2026-08-25
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
| 40016 | 路径不存在（Path not exist） |
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
    "parent": "ZqDKk8UX",           // 当前目录的父目录 id（根目录为 null/空）
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
        "source_enabled": false     // 是否支持生成直链（关键字段，见 §5）
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

- **`source_enabled`**：只有 `true` 的文件才能走 §5 取直链。实测 `foldcraftlauncher_cn` 整棵目录树的文件都是 `true`（因为存储策略是 V2 直链空间）；若文件在 SCx 自建存储则通常为 `false`
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
  "dst": "/foldcraftlauncher_cn/FCL/new/1/3/2/8",
  "preferred_node": 0
}
```

- `url`：**字符串数组**，可一次提交多个 URL（实测数组元素会逐个建任务）
- `dst`：目标目录完整路径（不存在时自动创建，实测可行）
- `preferred_node`：下载节点选择，`0` = 自动选择节点（前端 JS 里 `value:0` 对应"自动"）

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

- GitHub release 下载 URL（`https://github.com/.../releases/download/{tag}/{asset}`）实测可下载成功（README.md 6166 字节秒下；用户自测 164MB APK 也完成）
- 下载的**文件名 = URL 最后一段路径名**（`README.md`、`FCL-release-...apk`）
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
  "gid": "6f492401808422ca",                    // aria2 任务 gid（后续取消/选择用）
  "status": 4,                                  // 状态码：4=完成（1=等待中? 2=下载中? 3=暂停? 4=完成/结束，具体码表未全实测）
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

---

## 4. 批量取直链 — `POST /file/source`

获取一个或多个文件的直链（公共可访问，无需登录）。

### 请求

```
POST /api/v3/file/source
Content-Type: application/json

{
  "items": ["zdobenu1"]          // 文件 id 数组（来自 §1 的 objects[].id）
}
```

⚠️ **`items` 是文件 id 数组，不是路径**（前端代码 `c = selected.filter(e => e.source_enabled && e.type==="file").map(e => e.id)`）

### 实测响应

```jsonc
{
  "code": 0,
  "data": [
    {
      "url": "https://pan.huang1111.cn/f/z2mwtE/FCL-release-1.3.2.7-arm64-v8a.apk",
      "name": "FCL-release-1.3.2.7-arm64-v8a.apk",
      "parent": 4610440            // 文件父级数字 id（用途不明）
    }
  ],
  "msg": ""
}
```

### 要点

- 一次可批量传多个文件 id（前端有 `group.sourceBatch` 上限，实测 VIP2 的 `sourceBatch` 为 10000）
- **`url` 是长期有效的公共直链**：
  - 无需登录即可访问（实测无 cookie 的 curl 302 正常）
  - 302 重定向到真实下载服务器：`https://download-sc1.huang1111.cn/api/v3/slave/source/{...}?sign=...`（签名带时间戳，但入口 `/f/` URL 长期有效）
  - 实测 2026-04 上传的文件直链，2026-08 仍可访问
- 返回顺序与 `items` 一致

---

## 5. 直链前置条件（重要）

官方文档 + 实测确认：

| 条件 | 说明 |
|---|---|
| 文件所在存储策略 | 必须在**直链空间**（如 V2 直链空间），SCx 自建存储不支持直链 |
| 单文件大小 | ≤ 会员直链上限（VIP2 年付 = 2GB） |
| 用户组权限 | `group.allowShare`（分享/直链权限） |

`source_enabled` 字段可直接判断：`true` 才能取直链。

---

## 6. 前端 JS 中发现但**未实测**的端点（3.8.5 前代码）

以下端点从 `main.51b96baf.chunk.js` / chunks 中提取，供参考；**未在本会话实测**，使用时需自行验证：

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

## 7. 已验证的完整自动化调用链（2026-08-25 实测通过）

```
① GET  /directory/foldcraftlauncher_cn_auto/0/1/3/2/8     → 拿到文件 id（或确认已存在，去重）
② POST /aria2/url          {url:[...], dst:"...", preferred_node:0}   → 提交离线下载
③ GET  /aria2/downloading / /aria2/finished?page=N        → 轮询 status===4 完成
④ GET  /directory/{dst}    → 按文件名匹配，拿新文件 id
⑤ POST /file/source        {items:[id...]}                → 批量取直链
⑥ 写 data/down JSON + git push
```

---

## 8. 踩坑记录

| 坑 | 现象 | 解决 |
|---|---|---|
| **JSON body 带 BOM** | `code: 40001` 参数错误 | body 必须无 BOM（`UTF8Encoding($false)` 写入） |
| **PowerShell 传参剥引号** | 请求体变成 `{items:[id]}` 缺引号 → 40001 | body 写入临时文件，脚本从文件读取 |
| **目录路径多前导斜杠** | `directory//foldcraftlauncher_cn` → `40016 Path not exist` | 路径去前导 `/` |
| **目录名含空格/特殊字符** | ` 1.2.5.0`（前导空格）直接拼接可能失败 | 整段 `encodeURIComponent` 后拼接 |
| **BiDi awaitPromise 不生效** | `JSON.stringify(async fn)` 返回 `{}` | 两步式：先注入 `window.__out=null; (fn).then(r=>window.__out=r)`，再轮询读取 |
| **items 传路径** | `POST /file/source {items:["/路径"]}` → 40001 | items 必须是**文件 id** |
| **GET /source/{path}** | 404 | 取直链是 `POST /file/source`，不是 `GET /source/{path}` |

---

## 9. 3.8.5 更新影响（2026-08-26 01:00-04:00 站点关闭）

官方预告（blog 文章 74）涉及 API 可能变动的点：

1. **直链系统重构**：新增直链完全显示、无需切换存储即可生成直链 → `file/source` 可能简化或新增端点
2. **离线下载重构**：BT/HTTP/死文件/aria2 处理逻辑重构 → `/aria2/*` 端点可能调整
3. **新增工具箱**：含 GitHub 仓库下载 → 可能提供替代离线下载的官方能力
4. **权益升级**：V2 年付并行 6→8；标准版会员免广告

**更新后需重新实测 §1~§4 的全部端点确认兼容性。**
