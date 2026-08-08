# MVP implementation checklist

| Requirement | MVP implementation |
| --- | --- |
| Project tree | Collapsible Category → Project → Agent tree with search, three-level drag reorder, cross-Category Project moves, and cross-Project Agent moves |
| Dashboard first | Application opens on All Projects; no terminal is embedded or shown by default |
| Agent status | Running, Thinking, Waiting, Idle, Finished, Error, Stopped, and Offline models |
| Agent card data | Fixed-size Codex card with Project/name, effective goal, edit/delete, creation time, cwd, first/latest user prompt, latest completed response, manual note, status, and Focus |
| Agent navigation | Sidebar single-click focuses and centers the exact external terminal; card Focus reuses the exact window and creates one only when no live instance exists |
| Terminal management | GNOME Terminal, Kitty, Ghostty, Konsole, XFCE Terminal, and x-terminal-emulator adapters |
| Window title | Unique `Agent Console · …` title; imported TTY processes receive an OSC title when possible |
| Workspace restore | Starts missing tmux sessions and opens configured Agents in Project order; new/imported Agents opt in by default |
| Auto-discovery | Unassigned Codex/AI CLI processes only, including Codex inside tmux panes |
| Discovery import | Chinese/English keyword hints, exact TTY-identified direct window Focus, multi-select, and one-Project bulk import |
| Agent identity | User-defined name, note, manual goal, and process matching; a live Codex `/goal` takes display priority, while visual accent is inherited from the Project with no separate Agent icon/color control |
| Local persistence | Console Core is the sole writer of the atomic JSON state file; local task events use a private SQLite ledger |
| Background continuity | A user-level Core stays active after the desktop window closes; `KillMode=process` avoids sending termination to tmux/Agent children when Core stops |
| Local IPC | Protocol-v5 JSON-RPC over separate desktop/Gateway `0600` Unix sockets in `0700` directories; channel-bound allowlists and package verification assert zero Core TCP listeners |
| Mobile Remote settings | Honest unconfigured/secure-storage states, account verification, enable/disable, pairing SAS, device revocation, per-Agent capabilities, workstation rename, and Doctor checks; workstation removal remains fail-closed |
| Remote deployment | Private `remote.env`, localhost-only Gateway, autossh reverse tunnel, restricted VPS key/account, Caddy/Nginx 443 templates, install/render/doctor/uninstall CLI |
| Remote packaging | Exact extraResources allowlist, deb `agent-console-remote` PATH command, AppImage Settings/bootstrap route, systemd/package acceptance, and no configured env/key material |
| Security | Sandboxed renderer, context isolation, narrow contextBridge/RPC allowlists, navigation blocked, private umask |
| Editor reliability | Native Electron zoom, non-interactive hidden overlays, focus recovery, and deferred visual snapshots while forms are open |
| Scale direction | Compact cards, Project grouping, sidebar overview, global search, process classification |
| Application updates | Stable-channel checks, release notes, progress, checksum validation, and restart-to-install for AppImage/deb |

## Known MVP limits

- A generic external process does not expose its stdout to another application. Accurate last output therefore comes from tmux capture or an optional log file.
- Reliable external window focus and close on Linux requires `wmctrl` or `xdotool`; the deb installs `wmctrl` automatically, while source/AppImage runs rely on a system-provided helper.
- Existing manually configured non-AI Agents remain monitorable, but automatic discovery deliberately stays AI CLI-only.
- Windows process discovery and terminal adapters are a later cross-platform milestone; the current scanner is Linux-first.
- Mobile Remote is deliberately disabled until an administrator supplies a real Supabase project and VPS deployment; no production endpoint, service-role key, VPS host, or SSH key ships in the repository.
- The separately distributed phone client, push-notification delivery, production Supabase migrations, DNS, certificates, firewall policy, and VPS operations still require environment-specific deployment and acceptance.
