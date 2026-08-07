# Agent Console v0.5.3

## 简体中文

- 修复多个 Agent 可能聚焦到同一个 Codex CLI 窗口的问题。现在每个 Agent 都有独立、不可混淆的终端窗口身份，即使名称和终端标题相同，也会定位到各自的窗口。
- 修复正在运行的非 tmux Agent 无法聚焦、并要求用户自行安装 `wmctrl` 的问题。deb 安装包现在会自动安装所需的窗口聚焦组件，无需用户另行配置。
- 终端标题被 Codex CLI 或 shell 改写后，Agent Console 仍会记住该 Agent 对应的准确窗口，不再退回到模糊的标题包含匹配。
- 关闭窗口与“终端已打开”状态也改用同一套精确身份，避免相同名称的 Agent 互相干扰。
- 升级会保留 v0.5.2 的 Project、Agent、语言、主题、字号、tmux Session、Mobile Remote 设置和正在运行的进程。

## English

- Fixed multiple Agents sometimes focusing the same Codex CLI window. Every Agent now receives a distinct terminal-window identity, so Agents with identical names or visible titles still resolve to separate windows.
- Fixed running non-tmux Agents failing to focus and asking the user to install `wmctrl` manually. The deb package now installs the required window-focus helper automatically.
- Agent Console retains the exact Agent-to-window association even after Codex CLI or the shell rewrites the visible terminal title; it no longer falls back to ambiguous substring matching.
- Window closing and the “terminal open” state now use the same exact identity, preventing similarly named Agents from interfering with each other.
- Updating preserves v0.5.2 Projects, Agents, language, themes, font size, tmux sessions, Mobile Remote settings, and running processes.
