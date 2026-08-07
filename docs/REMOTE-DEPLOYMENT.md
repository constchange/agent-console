# Mobile Remote deployment (Linux)

Agent Console Remote is opt-in and fail-closed. The desktop Core still exposes no TCP listener: it creates two private Unix sockets, one for the desktop API and one for the smaller redacted Gateway API. A separate user service binds the HTTP Gateway to `127.0.0.1`, and `autossh` carries that loopback port to another loopback-only port on a VPS. Caddy or Nginx is the only public listener, on HTTPS 443.

An unconfigured desktop shows **Administrator setup required**. Registration and pairing are not presented as successful until Core reports a configured Supabase project, secure credential storage, and healthy services.

## 1. Create the workstation configuration

Copy the packaged `remote.env.example` to:

```text
~/.config/agent-console/remote/remote.env
```

Set its permissions before adding values:

```bash
chmod 0600 ~/.config/agent-console/remote/remote.env
```

Use only a Supabase project URL and its publishable/anon key. Never put a `sb_secret_` key, `service_role` JWT, VPS password, private-key contents, or access/refresh token in this file. The deployment CLI rejects those Supabase secret-key forms. Keep `AGENT_CONSOLE_REMOTE_ARMED=0` until all checks pass.

The local Gateway host must remain exactly `127.0.0.1`. The reverse port on the VPS is also loopback-only; it must never be opened in the VPS firewall or bound with SSH `GatewayPorts`.

Create one dedicated, unattended ED25519 key pair for this tunnel. Do not reuse a personal SSH key:

```bash
install -d -m 0700 ~/.config/agent-console/remote/ssh
ssh-keygen -t ed25519 -N '' -f ~/.config/agent-console/remote/ssh/id_ed25519
chmod 0600 ~/.config/agent-console/remote/ssh/id_ed25519
```

Obtain the VPS ED25519 host-key fingerprint through an independent administrative channel. Put only that exact host key in the dedicated `known_hosts` file and set it to mode `0600`. `doctor` checks the host, port, ED25519 algorithm, and configured SHA-256 fingerprint; it does not accept `StrictHostKeyChecking=no` or a global known-hosts fallback.

## 2. Validate and render locally

The deb package installs `/usr/bin/agent-console-remote` through `update-alternatives`; package removal removes only that registered alternative. Confirm it before continuing:

```bash
command -v agent-console-remote
REMOTE_CLI=$(command -v agent-console-remote)
```

For a source checkout, set `REMOTE_CLI="$PWD/resources/remote/bin/agent-console-remote"` instead.

AppImage users normally use **Settings → Mobile Remote**. On first enable, the desktop reads only the packaged public CLI, verifies that it is a regular non-writable package resource, and atomically installs a private mode-`0700` CLI plus service launcher under `~/.local/share/agent-console/remote`. Before writing that launcher it also requires the stable AppImage to be one executable, non-linked regular file owned by root or the current user, with no group/world write bit, in a non-writable trusted parent directory. The generated launcher points to that stable AppImage copy; it never copies `remote.env`, SSH keys, Supabase credentials, or session material. For an administrator who specifically needs the CLI before opening Settings, extract the AppImage in a private temporary directory, run its packaged launcher with `APPIMAGE` set to the stable outer file, and remove only that temporary extraction afterward:

```bash
APPIMAGE_PATH=$(readlink -f /absolute/stable/path/to/Agent-Console.AppImage)
APPIMAGE_CLI_DIR=$(mktemp -d)
(cd "$APPIMAGE_CLI_DIR" && "$APPIMAGE_PATH" --appimage-extract >/dev/null)
REMOTE_CLI=$(find "$APPIMAGE_CLI_DIR/squashfs-root" -type f -path '*/resources/remote/bin/agent-console-remote' -print -quit)
test -n "$REMOTE_CLI" && test -x "$REMOTE_CLI"
export APPIMAGE="$APPIMAGE_PATH"
```

After either the first Settings enable attempt or the first AppImage `install`, the stable generated service helper is at `~/.local/share/agent-console/remote/bin/agent-console-remote-service`, so extraction is not needed for later `doctor` or `uninstall` commands.

```bash
"$REMOTE_CLI" validate --env-file "$HOME/.config/agent-console/remote/remote.env"
"$REMOTE_CLI" render \
  --env-file "$HOME/.config/agent-console/remote/remote.env" \
  --output "$PWD/agent-console-vps-bundle"
```

`render` makes a secret-free review bundle: Caddy and Nginx alternatives, one restricted public key, deployment metadata, and VPS install/uninstall scripts. It never connects to the VPS. Transfer the reviewed bundle through the organization’s approved administrative channel.

The authorized key has these restrictions:

- `restrict` disables PTY, agent forwarding, X11, user rc, and forwarding by default.
- `port-forwarding` re-enables forwarding, while `permitlisten="127.0.0.1:PORT"` limits `-R` to the selected loopback port.
- The VPS `Match User` policy independently uses `AllowTcpForwarding remote`, `PermitOpen none`, `GatewayPorts no`, and `MaxSessions 0`; the dedicated account uses a `nologin` shell. Thus `-L`, shell, command, and subsystem sessions remain blocked without a forced command that would terminate `ssh -N -R`.

The VPS installer refuses an existing unrelated authorized key for the dedicated tunnel user. It never silently overwrites broader access.

## 3. Install the VPS side

Review every rendered file before running anything as root. On the VPS:

```bash
sudo ./install.sh --bundle /absolute/path/to/agent-console-vps-bundle
```

The installer validates the current SSH configuration, the staged `Match User` policy, and the staged proxy site before its first persistent change. It then snapshots every managed file. Caddy installations require an existing valid `/etc/caddy/Caddyfile`; the installer validates the full Caddyfile before reload. Nginx installations require the expected certificate and key and validate the full Nginx configuration. If any installed-config validation or any Caddy/Nginx/SSH reload fails, the exit trap restores the previous `authorized_keys`, SSH drop-in, proxy site, Caddyfile import, deployment metadata, and removes a tunnel user created by that attempt. A rollback reload failure is reported explicitly and must be resolved before retrying.

The installer intentionally does not change firewall rules. Only 443 (and the administrator’s existing SSH port) should be reachable publicly. The Gateway reverse port must remain absent from public firewall policy.

### Public rate-limit and DoS boundary

The rendered Nginx site limits requests and concurrent connections by the public peer's `$binary_remote_addr`, before traffic is proxied to loopback. Tune those limits against measured traffic, but do not replace the peer address with an untrusted forwarded header. It also keeps `proxy_request_buffering on` for every POST route, so a slow or incomplete public request body is rejected at the VPS instead of occupying one of the workstation Gateway's bounded body-admission slots.

The portable Caddy template intentionally does not pretend that stock Caddy provides an equivalent per-source limiter. A Caddy deployment **must** put an independently administered CDN/WAF, firewall rate limiter, or a reviewed Caddy rate-limit module in front of this site before enabling public Remote access. Configure that outer control from the actual network peer and preserve the HTTPS/authentication boundary described here. That outer control must also enforce short header/body timeouts, per-source connection limits, and complete bounded-body buffering before proxying POST requests into the reverse tunnel; a source limiter alone does not stop slow-body slot exhaustion.

The workstation Gateway sees the reverse tunnel’s loopback address, not the original public client IP. Before authentication, a caller can also rotate an asserted device identifier. Consequently, Gateway/device-ID throttles are defense in depth only: they are not the public DoS boundary and must not be used as a substitute for source-IP controls at the VPS edge.

## 4. Install and enable workstation services

The default command installs a private copy of `remote.env`, a stable service launcher, and two user units, then runs `systemd-analyze verify`. It does not enable either service:

```bash
"$REMOTE_CLI" install \
  --env-file "$HOME/.config/agent-console/remote/remote.env" \
  --app-executable /absolute/stable/path/to/agent-console
```

The AppImage path must be stable, not a temporary mount path. The generated launcher executes the CLI through that Electron runtime with `ELECTRON_RUN_AS_NODE=1`; a system Node installation is not required at service runtime.

After administrator setup is complete, set `AGENT_CONSOLE_REMOTE_ARMED=1`, keep the file at `0600`, reopen Agent Console (or use the desktop’s Core service refresh action), then explicitly enable:

```bash
"$REMOTE_CLI" install \
  --env-file "$HOME/.config/agent-console/remote/remote.env" \
  --app-executable /absolute/stable/path/to/agent-console \
  --enable
```

The Core user unit references the private file with `EnvironmentFile=-/absolute/path`; values are never copied into a unit. If the file is missing, linked, too large, not owned by the user, or group/world accessible, Core starts without Remote configuration.

Gateway systemd hardening includes `IPAddressDeny=any` and `IPAddressAllow=localhost`. The tunnel service does not use that restriction because it must reach the VPS. Both services load the same private `remote.env`; logs and unit files contain no key values.

## 5. Verify and operate

```bash
"$REMOTE_CLI" doctor --env-file "$HOME/.config/agent-console/remote/remote.env"
```

The default doctor is local-only. It validates configuration/file modes, the key pair, exact known host, user-unit state, and the exact IPv4 loopback listener. Add `--network` only when an outbound HTTPS `/healthz` check is intended. `--json` is suitable for the desktop Settings panel.

Useful checks during acceptance:

```bash
systemctl --user status agent-console-core.service agent-console-gateway.service agent-console-tunnel.service
ss -ltn
journalctl --user -u agent-console-gateway.service -u agent-console-tunnel.service
```

Acceptance requires both private Core sockets, no Core TCP listener, a Gateway listener only on `127.0.0.1`, a reverse listener only on VPS `127.0.0.1`, valid HTTPS, and method-boundary tests proving the desktop socket cannot call `remote.*` while the Gateway socket cannot call `config.*`.

## Removal

On the workstation:

```bash
"$REMOTE_CLI" uninstall
```

This disables/removes only the generated Gateway/Tunnel units and runtime helper files. It preserves `remote.env` and SSH keys for explicit administrator disposal.

On the VPS, run the reviewed rendered `uninstall.sh` as root. It preflights the current SSH/proxy configuration, snapshots the managed files, removes the marker key, SSH Match policy, proxy site, and metadata, then validates/reloads the services. A validation or reload failure restores the snapshots; the dedicated Unix account is always preserved. Delete the account or remaining configuration only as a separate, deliberate administrative action.
