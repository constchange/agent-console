# Agent Console v0.5.7

## 简体中文

- 左侧升级为“大类 → Project → Agent”三级树：三层均可拖动排序；Project 可连同全部 Agent 跨大类移动，Agent 也可跨 Project 移动。项目与 Agent 行距进一步收紧，名称采用 1.5 倍行高。
- 发现进程支持多选并一次加入同一个 Project，同时提取中英文特征关键词。自动发现仅保留尚未管理的 Codex/AI CLI，避免普通终端和后台服务淹没列表。
- 移除容易串到第一扇终端的截图预览，改为“聚焦”：通过所选进程自己的 TTY 写入唯一窗口身份，再将准确窗口放到当前屏幕中央并调整为宽、高各 3/5。
- 新增 VS Code 深色、VS Code 浅色和纯黑白主题；Agent 不再单独设置图标或颜色，标记色始终继承所属 Project。
- Codex 卡片改为固定尺寸和自适应列数，显示 Project、名称、创建时间、运行文件夹、首条/最近用户命令、最近完成回复、备注、目标、当前状态及聚焦按钮。
- 每个 Agent 新增可编辑的“备注”和手动“目标”。Codex 当前会话存在 `/goal` 时会读取真实目标并优先显示；目标位于 Agent 名称右侧并继承 Project 颜色。
- 修复活跃 Codex 等待模型、工具或子进程时被误判为“空闲”的问题；状态现在跟随准确 session 中的 `task_started`、`task_complete` 与 `turn_aborted` 生命周期。
- 新建和导入的 Agent 默认加入工作区恢复。升级会保留原有大类、Project、Agent、主题、字号、tmux Session 和运行进程。
- 本地 Core 协议升级到 v5；桌面端会安全重启自己管理的旧 Core，不覆盖状态文件，也不启动第二个写入者。

## English

- Replaced the sidebar with a Category → Project → Agent tree. All three levels can be reordered; Projects move across Categories with their Agents, and Agents move across Projects. Project and Agent rows are tighter with a 1.5 line height.
- Added multi-select discovery import into one Project and Chinese/English keyword hints. Automatic discovery now lists only unmanaged Codex/AI CLI processes, keeping regular terminals and background services out of the list.
- Replaced discovery screenshots, which could resolve to the first terminal, with direct Focus. Agent Console writes a unique identity through the selected process's own TTY, then centers and resizes the exact window to three fifths of the current display.
- Added VS Code Dark, VS Code Light, and pure black-and-white themes. Agents no longer have separate icons or colors; their accent always inherits the Project color.
- Reworked Codex cards into a fixed-size responsive grid showing Project, name, creation time, working folder, first/latest user command, latest completed response, note, goal, current status, and Focus.
- Added editable Notes and manual Goals to every Agent. A live Codex `/goal` objective from the exact session takes display priority; Goals appear beside the Agent name in the Project color.
- Fixed active Codex tasks appearing Idle while waiting for a model, tool, or subprocess. Status now follows `task_started`, `task_complete`, and `turn_aborted` from the exact session lifecycle.
- New and imported Agents opt into workspace restore by default. Upgrades preserve Categories, Projects, Agents, themes, font size, tmux sessions, and running processes.
- Upgraded the private local Core protocol to v5. The desktop safely restarts its managed older Core without replacing state or starting a second writer.
