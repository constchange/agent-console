## Local Console Core

- Added a persistent, user-level Console Core that keeps local monitoring and coarse Agent task state alive after the desktop window closes.
- Moved configuration ownership into Core so the desktop and a future mobile Gateway can never write the same state file independently.
- Added SHA-256 revision checks, serialized writes, a one-time pre-Core checkpoint, the existing atomic backup flow, and safe shutdown flushing.
- Added a private Unix-socket protocol with a version handshake, strict method allowlist, 1 MiB message cap, reconnect cursors with fresh-bootstrap reset handling, request limits, and `0700`/`0600` permissions.
- Added a local SQLite task ledger whose current automatic snapshot path stores fixed coarse summaries instead of terminal output, commands, paths, process arguments, tmux identifiers, or model reasoning.
- Added a redacted future-Gateway projection containing only Agent identity, status, and update time. No Gateway or network listener is enabled in this release.
- Added a read-only Local Console Core panel in Settings and a live Core connection indicator in the status bar.
- Reduced background discovery work when no desktop client is connected and hardened persisted-PID matching against PID reuse.
- Kept normal exits fully flushing queued saves while giving an unresponsive Core one shared 30-second shutdown deadline instead of multiplying every save timeout.

Existing Projects, Agents, themes, interface settings, state backups, tmux sessions, and running Agent processes are not deleted or replaced during the update. The Core service uses `KillMode=process`, so stopping it does not actively terminate tmux/Agent children. Supabase login, device pairing, VPS routing, public ports, and the mobile app are intentionally not included yet.
