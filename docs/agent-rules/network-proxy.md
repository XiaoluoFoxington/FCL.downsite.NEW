# 网络与代理

> 来自 `GLOBAL_AGENTS.md` 第 5 节。

## 5. 网络与代理

本机装有 **v2rayN**（内核 xray），用于访问被 GFW 限制的站点。

- **装在哪**：`C:\Users\XiaoluoFoxington\AppData\Local\Programs\v2rayN\`（用户级安装，不在 `Program Files`）。
- **入站端口**：SOCKS，`127.0.0.1:10808`。它同时兼容 HTTP 代理协议（`curl --proxy http://127.0.0.1:10808` 可用）。
- **系统代理**：v2rayN 已开系统代理（`HKCU\...\Internet Settings` 里 `ProxyEnable=1`，`ProxyServer=127.0.0.1:10808`），并带 `localhost;127.*;10.*;172.16-31.*;192.168.*` 的绕过列表。  
  也就是说 **GUI 程序、火狐等走系统代理的软件通常不用额外配置**。
- **什么叫「被 GFW 限制的网站」**：Google、YouTube、GitHub 的部分资源、HuggingFace、x.com 等直连不通或极慢的站点。  
  判断方法：先直连试一次，超时/连接被重置就挂代理。

### 怎么用

**命令行里临时走代理**（最常见）：

```powershell
# curl 走 HTTP 代理（注意 --proxy 只是单次生效，不会污染全局）
curl.exe -s --max-time 20 --proxy http://127.0.0.1:10808 https://www.google.com

# 需要走 SOCKS5（含远端 DNS 解析）时
curl.exe -s --max-time 20 --proxy socks5h://127.0.0.1:10808 https://www.google.com
```

**让 Node / Python 等程序走代理**：这些运行时认环境变量，而**系统代理设置它们不认**，必须显式给：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:HTTP_PROXY  = "http://127.0.0.1:10808"
```

⚠️ 环境变量是**会话级**的，只在当前 pwsh 进程有效；每个新的 pwsh 调用都是全新进程，需要重新设置。不要写进用户的环境变量里（用户本机直连本来就好，别污染）。

**git 走代理**：`git config --global` 里已有代理配置的话不用管；若某次直连超时，可单次覆盖：

```powershell
git -c http.proxy=http://127.0.0.1:10808 clone <url>
```

**验证代理是否生效**（看出口 IP 是不是境外）：

```powershell
curl.exe -s --max-time 20 --proxy http://127.0.0.1:10808 "https://api.ipify.org?format=json"
```

### 使用注意

- 代理只在**确实需要**时挂。国内站点（baidu、bing 等）直连即可，挂代理反而更慢甚至被风控。
- `127.0.0.1:10808` 是**本机回环**地址；v2rayN 的 `AllowLANConn` 是关的，别指望从别的机器访问。
- 如果代理不通，先检查 v2rayN / xray 进程是否在跑（`Get-Process v2rayN,xray`），再检查端口是否在听（`Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 10808`）。节点本身也可能失效，那就要提醒用户。

---

*长期有效。发现与现状不符时，直接改。*
