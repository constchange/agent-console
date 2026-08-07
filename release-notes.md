# Agent Console v0.5.2

## 简体中文

- 修复严重的进程发现回归：已发现的本地进程不会再被下一次自动刷新错误清空，进程数量也不会从非零瞬间跳回 0。
- 修复手动发现与自动刷新同时发生时的竞态，确保最后显示的是完整、可导入的进程列表。
- 桌面连接到本地 Core 后会立即执行一次完整进程发现；桌面未连接时仍保持低频轻量扫描。
- 升级会保留 v0.5.1 的 Project、Agent、主题、字号、语言、tmux Session、Mobile Remote 设置和正在运行的进程。

## English

- Fixed a critical process-discovery regression where the next automatic refresh cleared all discovered local processes and reset the count to zero.
- Fixed the race between manual discovery and the periodic refresh so the final snapshot keeps the complete importable process list.
- A full discovery scan now starts immediately when the desktop connects to the local Core, while the disconnected Core keeps its low-frequency lightweight scan.
- Updating preserves v0.5.1 Projects, Agents, themes, font size, language, tmux sessions, Mobile Remote settings, and running processes.
