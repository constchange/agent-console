# MVP implementation checklist

| Requirement | MVP implementation |
| --- | --- |
| Project tree | Collapsible Project Explorer with search, Emoji, color labels, drag reorder, and cross-Project move |
| Dashboard first | Application opens on All Projects; no terminal is embedded or shown by default |
| Agent status | Running, Thinking, Waiting, Idle, Finished, Error, Stopped, and Offline models |
| Agent card data | Name, Project, title, tmux, PID, cwd, CPU, memory, uptime, status, update time, last output |
| Double-click Agent | Focus matching external terminal; create only when no live instance is found |
| Terminal management | GNOME Terminal, Kitty, Ghostty, Konsole, XFCE Terminal, and x-terminal-emulator adapters |
| Window title | Unique `Agent Console · …` title; imported TTY processes receive an OSC title when possible |
| Workspace restore | Starts missing tmux sessions and opens configured Agents in Project order |
| Auto-discovery | Codex, terminals, tmux panes, backend patterns, Python, Node, workers, and Docker containers |
| Manual rename | Discovery import opens full identity and matching editor before saving |
| Local persistence | Console Core is the sole writer of the atomic JSON state file; local task events use a private SQLite ledger |
| Background continuity | A user-level Core stays active after the desktop window closes; `KillMode=process` avoids sending termination to tmux/Agent children when Core stops |
| Local IPC | Versioned JSON-RPC over a `0600` Unix socket in a `0700` per-user directory; production package verification asserts zero Core TCP listeners |
| Security | Sandboxed renderer, context isolation, narrow contextBridge/RPC allowlists, navigation blocked, private umask |
| Editor reliability | Native Electron zoom, non-interactive hidden overlays, focus recovery, and deferred visual snapshots while forms are open |
| Scale direction | Compact cards, Project grouping, sidebar overview, global search, process classification |
| Application updates | Stable-channel checks, release notes, progress, checksum validation, and restart-to-install for AppImage/deb |

## Known MVP limits

- A generic external process does not expose its stdout to another application. Accurate last output therefore comes from tmux capture or an optional log file.
- Reliable external window focus and close on Linux requires `wmctrl` or `xdotool`.
- Docker containers are discovered and can be monitored, but container log/exec actions are reserved for a later version.
- Windows process discovery and terminal adapters are a later cross-platform milestone; the current scanner is Linux-first.
- Supabase authentication, device pairing, the VPS Gateway, push notifications, and the mobile client are later milestones and are not enabled by the desktop Core.
