# Agent Console v0.5.1

## 简体中文

- 新增完整的简体中文界面，可在 **Settings → General → Interface language** 中与 English 即时切换；首次安装会跟随系统语言。
- Dashboard、设置、应用更新、Mobile Remote、状态、提示和错误信息均已本地化。Project 名称、Agent 名称、终端标题和终端原始输出始终保持原文。
- 状态识别新增谨慎的中文提示支持，可识别“正在分析”“等待确认”“任务已完成”“测试失败”等常见输出。
- Release 新增 `Agent-Console-0.5.1-x86_64.deb`。它与 Debian 标准命名的 `Agent-Console-0.5.1-amd64.deb` 逐字节完全一致，Intel/AMD 64 位电脑只需下载其中一份。
- 升级会保留现有 Project、Agent、主题、字号、状态备份、tmux Session 和正在运行的 Agent；本机 Core、更新校验和 Mobile Remote 安全边界保持不变。

## English

- Added a complete Simplified Chinese interface with instant switching to and from English under **Settings → General → Interface language**. New installations follow the system language.
- Localized the Dashboard, settings, application updates, Mobile Remote, statuses, notices, and errors. Project names, Agent names, terminal titles, and raw terminal output always remain unchanged.
- Added conservative Chinese status recognition for common phrases such as analyzing, waiting for approval, completed, and failed.
- Added `Agent-Console-0.5.1-x86_64.deb` to each release. It is byte-for-byte identical to the Debian-standard `Agent-Console-0.5.1-amd64.deb`; Intel/AMD 64-bit users only need one of them.
- Existing Projects, Agents, themes, font size, state backups, tmux sessions, and running Agents are preserved. Local Core, update verification, and Mobile Remote security boundaries are unchanged.
