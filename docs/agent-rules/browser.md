# 浏览器偏好

> 来自 `GLOBAL_AGENTS.md` 第 4 节。

## 4. 浏览器偏好

- **用户不喜欢 Chromium。** 需要用浏览器做事时（自动化、抓页面、调试前端），**优先用 Gecko，即 Firefox**。
- 本机 Firefox 的确切位置**以实际探测为准**，不要假设它在标准路径——`where firefox` 找不到、`C:\Program Files\Mozilla Firefox` 不存在，都**不代表没装**。  
  已知的一处位置：`C:\Program Files (User)\Firefox Developer Edition\firefox.exe`  
  （用户级安装，在 `Program Files (User)` 这个非标准目录下；版本是 **Developer Edition**。若该路径失效，去 `AppData\Roaming\Mozilla\Firefox\profiles.ini` 和开始菜单快捷方式里找线索。）
- 确实绕不过去再考虑别的内核；如果连 Firefox 也走不通，就如实说明「做不了」，不要硬换 Chromium 然后当没这回事。

---

*长期有效。发现与现状不符时，直接改。*
