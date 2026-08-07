#!/bin/sh
set -eu

die() {
  printf '%s\n' "agent-console-vps-uninstall: $*" >&2
  exit 1
}

warn() {
  printf '%s\n' "agent-console-vps-uninstall: WARNING: $*" >&2
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

snapshot_path() {
  snapshot_source=$1
  snapshot_name=$2
  if path_exists "$snapshot_source"; then
    cp -a "$snapshot_source" "$work_dir/snapshot.$snapshot_name"
    : > "$work_dir/snapshot.$snapshot_name.present"
  fi
}

restore_path() {
  restore_target=$1
  restore_name=$2
  rm -f "$restore_target"
  if [ -f "$work_dir/snapshot.$restore_name.present" ]; then
    cp -a "$work_dir/snapshot.$restore_name" "$restore_target"
  fi
}

reload_sshd() {
  systemctl reload sshd 2>/dev/null || systemctl reload ssh
}

cleanup_work_dir() {
  case "${work_dir:-}" in
    /tmp/agent-console-vps-uninstall.*) rm -rf "$work_dir" ;;
    '') ;;
    *) warn "refusing to remove unexpected temporary directory $work_dir" ;;
  esac
}

rollback() {
  [ "$transaction_started" -eq 1 ] || return 0
  set +e
  warn 'uninstall failed; restoring the exact managed-file snapshots'
  if [ -n "$installed_keys" ]; then restore_path "$installed_keys" authorized-keys; fi
  restore_path "$sshd_dropin" sshd-dropin
  restore_path "$deployment_file" metadata
  if [ "$proxy" = caddy ]; then
    restore_path "$caddy_site" caddy-site
    if caddy validate --config "$caddy_main" >/dev/null 2>&1; then
      systemctl reload caddy >/dev/null 2>&1 || warn 'Caddy files were restored, but its rollback reload failed'
    fi
  else
    restore_path "$nginx_enabled" nginx-enabled
    restore_path "$nginx_available" nginx-available
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx >/dev/null 2>&1 || warn 'Nginx files were restored, but its rollback reload failed'
    fi
  fi
  if sshd -t >/dev/null 2>&1; then
    reload_sshd >/dev/null 2>&1 || warn 'SSH files were restored, but its rollback reload failed'
  else
    warn 'SSH snapshot restoration completed, but the restored global configuration does not validate'
  fi
}

finish() {
  exit_status=$?
  trap - 0 HUP INT TERM
  if [ "$committed" -ne 1 ]; then rollback; fi
  cleanup_work_dir
  exit "$exit_status"
}

[ "$(id -u)" -eq 0 ] || die 'run as root on the VPS'
[ "$#" -eq 0 ] || die 'uninstall.sh accepts no arguments'

system_etc=/etc
deployment_dir="$system_etc/agent-console-remote"
deployment_file="$deployment_dir/deployment.env"
[ -f "$deployment_file" ] && [ ! -L "$deployment_file" ] || die 'installed deployment metadata is missing or is a link'

read_value() {
  key=$1
  value=$(awk -F= -v wanted="$key" '$1 == wanted { print substr($0, index($0, "=") + 1); count += 1 } END { if (count != 1) exit 1 }' "$deployment_file") || die "installed metadata must define $key exactly once"
  [ -n "$value" ] || die "installed metadata has an empty $key"
  printf '%s' "$value"
}

tunnel_user=$(read_value VPS_TUNNEL_USER)
proxy=$(read_value VPS_PROXY)
printf '%s' "$tunnel_user" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die 'installed tunnel user is invalid'
[ "$tunnel_user" != root ] || die 'refusing to act on root'
[ "$proxy" = caddy ] || [ "$proxy" = nginx ] || die 'installed proxy value is invalid'

for required_command in sshd systemctl install cp getent mktemp; do
  command -v "$required_command" >/dev/null 2>&1 || die "$required_command is required"
done

sshd_dropin="$system_etc/ssh/sshd_config.d/90-agent-console-remote.conf"
caddy_main="$system_etc/caddy/Caddyfile"
caddy_site="$system_etc/caddy/conf.d/agent-console.caddy"
nginx_available="$system_etc/nginx/sites-available/agent-console"
nginx_enabled="$system_etc/nginx/sites-enabled/agent-console"
installed_keys=''
tunnel_group=''
if id "$tunnel_user" >/dev/null 2>&1; then
  home_dir=$(getent passwd "$tunnel_user" | awk -F: 'NR == 1 { print $6 }')
  tunnel_group=$(id -gn "$tunnel_user")
  case "$home_dir" in
    /*) ;;
    *) die 'tunnel user has no absolute home directory' ;;
  esac
  case "$home_dir" in
    /|/root|/etc|/usr|/var|/home) die 'tunnel user has an unsafe broad home directory' ;;
  esac
  installed_keys="$home_dir/.ssh/authorized_keys"
  if path_exists "$installed_keys"; then
    [ -f "$installed_keys" ] && [ ! -L "$installed_keys" ] || die 'installed authorized_keys must be a regular file, not a link'
  fi
fi

if path_exists "$sshd_dropin"; then
  [ -f "$sshd_dropin" ] && [ ! -L "$sshd_dropin" ] || die 'installed SSH drop-in must be a regular file, not a link'
fi
sshd -t || die 'the current SSH configuration is invalid; refusing to mutate it'

if [ "$proxy" = caddy ]; then
  command -v caddy >/dev/null 2>&1 || die 'caddy is required to remove the installed Caddy site'
  [ -f "$caddy_main" ] && [ ! -L "$caddy_main" ] || die 'Caddyfile is missing or is a link'
  if path_exists "$caddy_site"; then
    [ -f "$caddy_site" ] && [ ! -L "$caddy_site" ] || die 'installed Caddy site must be a regular file, not a link'
  fi
  caddy validate --config "$caddy_main" || die 'the current Caddy configuration is invalid; refusing to mutate it'
else
  command -v nginx >/dev/null 2>&1 || die 'nginx is required to remove the installed Nginx site'
  for nginx_path in "$nginx_available" "$nginx_enabled"; do
    if path_exists "$nginx_path"; then [ ! -d "$nginx_path" ] || die "$nginx_path must not be a directory"; fi
  done
  nginx -t || die 'the current Nginx configuration is invalid; refusing to mutate it'
fi

work_dir=$(mktemp -d /tmp/agent-console-vps-uninstall.XXXXXX)
chmod 0700 "$work_dir"
committed=0
transaction_started=0
trap finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$installed_keys" ]; then snapshot_path "$installed_keys" authorized-keys; fi
snapshot_path "$sshd_dropin" sshd-dropin
snapshot_path "$deployment_file" metadata
if [ "$proxy" = caddy ]; then
  snapshot_path "$caddy_site" caddy-site
else
  snapshot_path "$nginx_available" nginx-available
  snapshot_path "$nginx_enabled" nginx-enabled
fi
transaction_started=1

if [ -n "$installed_keys" ] && path_exists "$installed_keys"; then
  filtered="$work_dir/authorized_keys"
  grep -v ' agent-console-remote$' "$installed_keys" > "$filtered" || true
  install -o "$tunnel_user" -g "$tunnel_group" -m 0600 "$filtered" "$installed_keys"
fi

rm -f "$sshd_dropin"
sshd -t || die 'sshd configuration is invalid after removing the Agent Console policy'

if [ "$proxy" = caddy ]; then
  rm -f "$caddy_site"
  caddy validate --config "$caddy_main" || die 'Caddy configuration is invalid after removing the Agent Console site'
else
  rm -f "$nginx_enabled" "$nginx_available"
  nginx -t || die 'Nginx configuration is invalid after removing the Agent Console site'
fi

rm -f "$deployment_file"
if [ "$proxy" = caddy ]; then
  systemctl reload caddy || die 'caddy reload failed'
else
  systemctl reload nginx || die 'nginx reload failed'
fi
reload_sshd || die 'SSH reload failed'

committed=1
rmdir "$deployment_dir" 2>/dev/null || true
printf '%s\n' 'Removed Agent Console VPS key, SSH policy, proxy site, and deployment metadata. The dedicated user was preserved.'
