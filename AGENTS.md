# AGENTS.md

> **先读全局规则：`C:\Users\XiaoluoFoxington\GLOBAL_AGENTS.md`。**
> 那里放的是跨工作区通用的东西，**一定要读**。
> 本文件只写本项目特有的东西，不重复全局内容。
>
> **优先级：本文件 ＞ 全局规则 ＞ Agent 自己的默认习惯。**
> 两者冲突时以本文件为准（它更具体）；但工具调用报错信息等硬性约束永远优先于任何规则文件。

## 注意

- TRAE_CN（网页端）
  - 跑在 TRAE 自己的服务器环境上，全局规则可见项目内的备份（更新时间：2026年10月31日），在`/docs/GLOBAL_AGENTS.md`。
    - 此时需要忽略规则中的所有有关系统环境的部分，因为TRAE_CN（网页端）在服务器环境上运行，没有本地环境。
  - 会自动新建一个分支然后在每一次提交后自动同步到远端。
- TRAE_CN（客户端）内置记忆功能，文件在`C:\Users\XiaoluoFoxington\.trae-cn\memory\projects\-f-XiaoluoFoxington-Project-FCL-downsite-NEW--p2-7f0fb08beb6b0543e2e0\project_memory.md`。其他 harness 也可手动去看看，与此记忆文件不冲突。

## 新增资源

- 用户要求新增资源时，请根据用户给出的信息自动完成资源详情与下载线路。
  - 尝试寻找最高清晰度的图标，格式转换为`avif`，有损75%，次数5，需保留透明通道。如果没找到工具就让用户自己转。