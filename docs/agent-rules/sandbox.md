# 沙箱环境的硬性限制

> 来自 `GLOBAL_AGENTS.md` 第 6 节。
>
> 这些坑来自 dsh 的沙箱，但**默认视为通用**——如果你跑在别的 harness 里，同样先按本节怀疑一遍。
>
> ⚠️ 反过来说：**不确定自己在哪个环境，就问用户**，别靠环境变量猜（见 `interaction.md`）。

## 6. 沙箱环境的硬性限制

### 6.1 TLS：别用 schannel

- **沙箱环境无法用 Windows schannel 建立 TLS**，报 `SEC_E_NO_CREDENTIALS`。
- 受影响的主要是 **git 推送**；`git ls-remote` / `clone` 走 HTTPS 一般没事（实测可通），所以**不要**因为「推送失败」就怀疑整个网络的 TLS 都坏了。
- 绕过办法——**单次覆盖 TLS 后端**，不要动全局配置：
  ```powershell
  git -c http.sslbackend=openssl push
  ```
- ⚠️ **不要因此去改全局 git 配置**（`git config --global http.sslBackend openssl`）。用户本机自己的终端没有这个毛病，改了会污染他的环境。永远是「单次命令行覆盖」。

### 6.2 文件权限

- 文件沙箱策略不止一种（只读 / 可写工作区 / 完全访问）。被拒绝的写入会明确报 `[sandbox: file access denied under <mode> mode]`，那是**策略拒绝，不是 bug**，换个写法重试也没用。
- 只读模式下 pwsh 跑在 PowerShell 的 ConstrainedLanguage 模式，`.NET` 静态调用（`[System.IO.*]::`）、`Add-Type`、COM 对象会报「only core types」错误——这时改用 cmdlet 和 `[string]`、`[datetime]`、`[regex]` 这类核心类型。
- **`.git` 下的写入被拒，先怀疑沙箱策略，别急着修 ACL。**  
  若 `git add/commit` 报 `.git/index.lock` 的 `Permission denied`、而该锁文件**实际并不存在**（即不是残留锁），几乎可以确定是沙箱在拦，不是权限损坏。  
  放宽会话的**文件策略**（如 `danger-full-access`）后往往立刻恢复，**什么都不用修**。  
  ⚠️ 反过来：**不要为了让自己能提交，去改写用户仓库的权限。** 哪怕在 `.git` 的权限项里查到了拒绝条目，也不构成「损坏」的证据——那常常正是沙箱自己布下的。  
  正确顺序是：报告症状与证据 → **问用户** → 由他决定放宽会话权限还是换做法。擅自运行改写权限的脚本属于越界。

---

*长期有效。发现与现状不符时，直接改。*
