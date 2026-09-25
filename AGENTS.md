# AGENTS.md
## 不对劲

- TRAE_CN（网页端）会自动新建一个分支然后在每一次提交后自动同步到远端。
- TRAE_CN（客户端）内置记忆功能，文件在`C:\Users\XiaoluoFoxington\.trae-cn\memory\projects\-f-XiaoluoFoxington-Project-FCL-downsite-NEW--p2-7f0fb08beb6b0543e2e0\project_memory.md`。与此记忆文件不冲突。

## 修改这里
- **时效性**：这里的内容并非是绝对准确的，有的可能已过时或不使用。如发现需修改此文件以保持最新。
- **记录**：如果发现了用户的工作偏好、 硬性约束等有变化或更新，及时记录在文件中。

## 工作偏好
- **环境**：如果不知道当前所在的环境是DSH、TRAE_CN（客户端）还是TRAE_CN（网页端），直接问用户。
- **提问**：如果用户没有明确说明"不要问我问题""我睡觉去了"，遇到任何需要决策的事时直接向用户提问，不要擅自做决定。

## 经验教训
- DeepSeekHarness 的沙箱环境无法用 schannel 建立 TLS（报 `SEC_E_NO_CREDENTIALS`），git 推送需单次覆盖 `git -c http.sslbackend=openssl push`；用户本机终端不受影响，勿因此改动全局 git 配置。
- 用 `python -m http.server` 起本地服务验证前端改动时，浏览器会缓存 ES 模块，改动可能看似没生效（可 `fetch(url, {cache:'no-store'})` 判别）。换端口（新 origin，缓存为空）或强制刷新后才能得到真实结果；换端口会丢失该 origin 的 localStorage 语言偏好，需重新设置。
