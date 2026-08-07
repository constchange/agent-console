#!/bin/sh
set -eu

die() {
  printf '%s\n' "agent-console-vps-install: $*" >&2
  exit 1
}

warn() {
  printf '%s\n' "agent-console-vps-install: WARNING: $*" >&2
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
    /tmp/agent-console-vps-install.*) rm -rf "$work_dir" ;;
    '') ;;
    *) warn "refusing to remove unexpected temporary directory $work_dir" ;;
  esac
}

rollback() {
  [ "$transaction_started" -eq 1 ] || return 0
  set +e
  warn 'installation failed; restoring the exact managed-file snapshots'

  restore_path "$installed_metadata" metadata
  [ "$metadata_dir_created" -eq 1 ] && rmdir "$metadata_dir" 2>/dev/null

  if [ "$proxy" = caddy ]; then
    restore_path "$caddy_site" caddy-site
    restore_path "$caddy_main" caddy-main
    [ "$caddy_conf_dir_created" -eq 1 ] && rmdir "$caddy_conf_dir" 2>/dev/null
    if [ -f "$caddy_main" ] && caddy validate --config "$caddy_main" >/dev/null 2>&1; then
      systemctl reload caddy >/dev/null 2>&1 || warn 'Caddy files were restored, but its rollback reload failed'
    fi
  else
    restore_path "$nginx_enabled" nginx-enabled
    restore_path "$nginx_available" nginx-available
    [ "$nginx_enabled_dir_created" -eq 1 ] && rmdir "$nginx_enabled_dir" 2>/dev/null
    [ "$nginx_available_dir_created" -eq 1 ] && rmdir "$nginx_available_dir" 2>/dev/null
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx >/dev/null 2>&1 || warn 'Nginx files were restored, but its rollback reload failed'
    fi
  fi

  restore_path "$sshd_dropin" sshd-dropin
  [ "$sshd_dir_created" -eq 1 ] && rmdir "$sshd_dir" 2>/dev/null

  if [ -n "$installed_keys" ]; then
    restore_path "$installed_keys" authorized-keys
  fi
  if [ "$ssh_dir_created" -eq 1 ] && [ -n "$ssh_dir" ]; then
    rmdir "$ssh_dir" 2>/dev/null
  elif [ "$ssh_dir_existed" -eq 1 ] && [ -n "$ssh_dir" ]; then
    chmod "$ssh_dir_mode" "$ssh_dir" 2>/dev/null
    chown "$ssh_dir_uid:$ssh_dir_gid" "$ssh_dir" 2>/dev/null
  fi

  if [ "$user_created" -eq 1 ] && id "$tunnel_user" >/dev/null 2>&1; then
    userdel --remove "$tunnel_user" >/dev/null 2>&1 || warn "could not remove newly created user $tunnel_user"
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

[ "$(id -u)" -eq 0 ] || die 'run this reviewed bundle as root on the VPS'

system_etc=/etc
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
bundle_dir=$script_dir
if [ "${1:-}" = '--bundle' ]; then
  [ "$#" -eq 2 ] || die 'usage: install.sh [--bundle ABSOLUTE_DIRECTORY]'
  bundle_dir=$2
elif [ "$#" -ne 0 ]; then
  die 'usage: install.sh [--bundle ABSOLUTE_DIRECTORY]'
fi
case "$bundle_dir" in
  /*) ;;
  *) die 'bundle directory must be absolute' ;;
esac
[ -d "$bundle_dir" ] && [ ! -L "$bundle_dir" ] || die 'bundle directory must be a real directory'

deployment_file="$bundle_dir/deployment.env"
authorized_key_file="$bundle_dir/authorized_key"
[ -f "$deployment_file" ] && [ ! -L "$deployment_file" ] || die 'deployment.env is missing or is a link'
[ -f "$authorized_key_file" ] && [ ! -L "$authorized_key_file" ] || die 'authorized_key is missing or is a link'

read_value() {
  key=$1
  value=$(awk -F= -v wanted="$key" '$1 == wanted { print substr($0, index($0, "=") + 1); count += 1 } END { if (count != 1) exit 1 }' "$deployment_file") || die "deployment.env must define $key exactly once"
  [ -n "$value" ] || die "deployment.env has an empty $key"
  printf '%s' "$value"
}

remote_domain=$(read_value REMOTE_DOMAIN)
gateway_port=$(read_value VPS_GATEWAY_PORT)
tunnel_user=$(read_value VPS_TUNNEL_USER)
proxy=$(read_value VPS_PROXY)

printf '%s' "$remote_domain" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || die 'REMOTE_DOMAIN is invalid'
printf '%s' "$gateway_port" | grep -Eq '^[0-9]{4,5}$' || die 'VPS_GATEWAY_PORT is invalid'
[ "$gateway_port" -ge 1024 ] && [ "$gateway_port" -le 65535 ] || die 'VPS_GATEWAY_PORT is outside 1024..65535'
printf '%s' "$tunnel_user" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die 'VPS_TUNNEL_USER is invalid'
[ "$tunnel_user" != root ] || die 'VPS_TUNNEL_USER must not be root'
[ "$proxy" = caddy ] || [ "$proxy" = nginx ] || die 'VPS_PROXY must be caddy or nginx'

expected_options="restrict,port-forwarding,permitlisten=\"127.0.0.1:${gateway_port}\",permitopen=\"127.0.0.1:1\""
key_line=$(sed -n '1p' "$authorized_key_file")
[ "$(wc -l < "$authorized_key_file" | tr -d ' ')" -eq 1 ] || die 'authorized_key must contain exactly one line'
case "$key_line" in
  "$expected_options ssh-ed25519 "*' agent-console-remote') ;;
  *) die 'authorized_key is not the expected restricted ED25519 key' ;;
esac

for required_command in sshd systemctl install cp getent mktemp stat; do
  command -v "$required_command" >/dev/null 2>&1 || die "$required_command is required"
done

work_dir=$(mktemp -d /tmp/agent-console-vps-install.XXXXXX)
chmod 0700 "$work_dir"
committed=0
transaction_started=0
user_created=0
ssh_dir_created=0
ssh_dir_existed=0
ssh_dir=''
ssh_dir_mode=''
ssh_dir_uid=''
ssh_dir_gid=''
installed_keys=''
sshd_dir_created=0
metadata_dir_created=0
caddy_conf_dir_created=0
nginx_available_dir_created=0
nginx_enabled_dir_created=0
trap finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

sshd_dir="$system_etc/ssh/sshd_config.d"
sshd_dropin="$sshd_dir/90-agent-console-remote.conf"
metadata_dir="$system_etc/agent-console-remote"
installed_metadata="$metadata_dir/deployment.env"
caddy_main="$system_etc/caddy/Caddyfile"
caddy_conf_dir="$system_etc/caddy/conf.d"
caddy_site="$caddy_conf_dir/agent-console.caddy"
nginx_available_dir="$system_etc/nginx/sites-available"
nginx_enabled_dir="$system_etc/nginx/sites-enabled"
nginx_available="$nginx_available_dir/agent-console"
nginx_enabled="$nginx_enabled_dir/agent-console"

for managed_regular in "$sshd_dropin" "$installed_metadata"; do
  if path_exists "$managed_regular"; then
    [ -f "$managed_regular" ] && [ ! -L "$managed_regular" ] || die "$managed_regular must be a regular file, not a link"
  fi
done

staged_policy="$work_dir/sshd-policy.conf"
{
  printf 'Match User %s\n' "$tunnel_user"
  printf '    AuthenticationMethods publickey\n'
  printf '    PasswordAuthentication no\n'
  printf '    KbdInteractiveAuthentication no\n'
  printf '    PubkeyAuthentication yes\n'
  printf '    AllowTcpForwarding remote\n'
  printf '    GatewayPorts no\n'
  printf '    PermitListen 127.0.0.1:%s\n' "$gateway_port"
  printf '    PermitOpen none\n'
  printf '    X11Forwarding no\n'
  printf '    AllowAgentForwarding no\n'
  printf '    PermitTTY no\n'
  printf '    MaxSessions 0\n'
} > "$staged_policy"
chmod 0600 "$staged_policy"

[ -r "$system_etc/ssh/sshd_config" ] || die 'the global sshd_config is missing or unreadable'
sshd -t || die 'the current SSH configuration is invalid; refusing to mutate it'
staged_sshd="$work_dir/sshd_config"
{
  printf 'Include %s\n' "$system_etc/ssh/sshd_config"
  printf 'Include %s\n' "$staged_policy"
} > "$staged_sshd"
sshd -t -f "$staged_sshd" || die 'sshd rejected the staged Match User policy before installation'

if [ "$proxy" = caddy ]; then
  command -v caddy >/dev/null 2>&1 || die 'caddy is required by VPS_PROXY=caddy'
  [ -f "$bundle_dir/agent-console.caddy" ] && [ ! -L "$bundle_dir/agent-console.caddy" ] || die 'rendered Caddy config is missing or is a link'
  [ -f "$caddy_main" ] && [ ! -L "$caddy_main" ] || die 'the existing Caddyfile is missing or is a link'
  if path_exists "$caddy_site"; then
    [ -f "$caddy_site" ] && [ ! -L "$caddy_site" ] || die "$caddy_site must be a regular file, not a link"
  fi
  caddy validate --config "$bundle_dir/agent-console.caddy" || die 'caddy rejected the staged site before installation'
else
  command -v nginx >/dev/null 2>&1 || die 'nginx is required by VPS_PROXY=nginx'
  [ -f "$bundle_dir/agent-console.nginx.conf" ] && [ ! -L "$bundle_dir/agent-console.nginx.conf" ] || die 'rendered Nginx config is missing or is a link'
  [ -r "$system_etc/letsencrypt/live/$remote_domain/fullchain.pem" ] || die 'TLS certificate is missing; obtain it before installing the Nginx template'
  [ -r "$system_etc/letsencrypt/live/$remote_domain/privkey.pem" ] || die 'TLS private key is missing; obtain it before installing the Nginx template'
  for nginx_path in "$nginx_available" "$nginx_enabled"; do
    if path_exists "$nginx_path"; then
      [ ! -d "$nginx_path" ] || die "$nginx_path must not be a directory"
    fi
  done
  staged_nginx="$work_dir/nginx.conf"
  {
    printf 'events {}\n'
    printf 'http {\n'
    printf '    include "%s";\n' "$bundle_dir/agent-console.nginx.conf"
    printf '}\n'
  } > "$staged_nginx"
  nginx -t -c "$staged_nginx" -p / || die 'nginx rejected the staged site before installation'
fi

user_was_present=0
password_hash=''
home_dir=''
login_shell=''
tunnel_group=''
if id "$tunnel_user" >/dev/null 2>&1; then
  user_was_present=1
  home_dir=$(getent passwd "$tunnel_user" | awk -F: 'NR == 1 { print $6 }')
  login_shell=$(getent passwd "$tunnel_user" | awk -F: 'NR == 1 { print $7 }')
  tunnel_group=$(id -gn "$tunnel_user")
  case "$home_dir" in
    /*) ;;
    *) die 'tunnel user has no absolute home directory' ;;
  esac
  case "$home_dir" in
    /|/root|/etc|/usr|/var|/home) die 'tunnel user has an unsafe broad home directory' ;;
  esac
  [ -d "$home_dir" ] && [ ! -L "$home_dir" ] || die 'existing tunnel user home must be a real directory'
  case "$login_shell" in
    */nologin|*/false) ;;
    *) die 'existing tunnel user must use a nologin/false shell' ;;
  esac
  ssh_dir="$home_dir/.ssh"
  installed_keys="$ssh_dir/authorized_keys"
  if path_exists "$ssh_dir"; then
    [ -d "$ssh_dir" ] && [ ! -L "$ssh_dir" ] || die 'existing .ssh must be a real directory'
    ssh_dir_existed=1
    ssh_dir_mode=$(stat -c '%a' "$ssh_dir")
    ssh_dir_uid=$(stat -c '%u' "$ssh_dir")
    ssh_dir_gid=$(stat -c '%g' "$ssh_dir")
  fi
  if path_exists "$installed_keys"; then
    [ -f "$installed_keys" ] && [ ! -L "$installed_keys" ] || die 'existing authorized_keys must be a regular file, not a link'
    if grep -Ev '^[[:space:]]*(#|$)| agent-console-remote$' "$installed_keys" | grep -q .; then
      die 'dedicated tunnel user has an unrelated authorized key; refusing to broaden access'
    fi
  fi
else
  command -v openssl >/dev/null 2>&1 || die 'openssl is required to create an unlocked account with an unknown password hash'
  command -v useradd >/dev/null 2>&1 || die 'useradd is required to create the tunnel account'
  command -v userdel >/dev/null 2>&1 || die 'userdel is required for transactional rollback'
  random_password=$(openssl rand -hex 32)
  password_hash=$(printf '%s' "$random_password" | openssl passwd -6 -stdin)
  unset random_password
fi

snapshot_path "$sshd_dropin" sshd-dropin
snapshot_path "$installed_metadata" metadata
if [ "$user_was_present" -eq 1 ]; then snapshot_path "$installed_keys" authorized-keys; fi
if [ "$proxy" = caddy ]; then
  snapshot_path "$caddy_main" caddy-main
  snapshot_path "$caddy_site" caddy-site
else
  snapshot_path "$nginx_available" nginx-available
  snapshot_path "$nginx_enabled" nginx-enabled
fi

transaction_started=1

if [ "$user_was_present" -eq 0 ]; then
  useradd --system --user-group --create-home --shell /usr/sbin/nologin --password "$password_hash" "$tunnel_user"
  user_created=1
  unset password_hash
  home_dir=$(getent passwd "$tunnel_user" | awk -F: 'NR == 1 { print $6 }')
  login_shell=$(getent passwd "$tunnel_user" | awk -F: 'NR == 1 { print $7 }')
  tunnel_group=$(id -gn "$tunnel_user")
  case "$home_dir" in
    /*) ;;
    *) die 'new tunnel user has no absolute home directory' ;;
  esac
  case "$home_dir" in
    /|/root|/etc|/usr|/var|/home) die 'new tunnel user has an unsafe broad home directory' ;;
  esac
  [ -d "$home_dir" ] && [ ! -L "$home_dir" ] || die 'useradd did not create a safe home directory'
  case "$login_shell" in
    */nologin|*/false) ;;
    *) die 'new tunnel user does not have a nologin shell' ;;
  esac
  ssh_dir="$home_dir/.ssh"
  installed_keys="$ssh_dir/authorized_keys"
fi

if [ ! -d "$ssh_dir" ]; then ssh_dir_created=1; fi
install -d -o "$tunnel_user" -g "$tunnel_group" -m 0700 "$ssh_dir"
merged_keys="$work_dir/authorized_keys"
if path_exists "$installed_keys"; then
  grep -v ' agent-console-remote$' "$installed_keys" > "$merged_keys" || true
else
  : > "$merged_keys"
fi
printf '%s\n' "$key_line" >> "$merged_keys"
install -o "$tunnel_user" -g "$tunnel_group" -m 0600 "$merged_keys" "$installed_keys"

if [ ! -d "$sshd_dir" ]; then sshd_dir_created=1; fi
install -d -o root -g root -m 0755 "$sshd_dir"
install -o root -g root -m 0600 "$staged_policy" "$sshd_dropin"
sshd -t || die 'sshd rejected the installed Match User policy'

if [ "$proxy" = caddy ]; then
  if [ ! -d "$caddy_conf_dir" ]; then caddy_conf_dir_created=1; fi
  install -d -o root -g root -m 0755 "$caddy_conf_dir"
  install -o root -g root -m 0644 "$bundle_dir/agent-console.caddy" "$caddy_site"
  if ! grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/conf\.d/\*\.caddy[[:space:]]*$' "$caddy_main"; then
    printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> "$caddy_main"
  fi
  caddy validate --config "$caddy_main" || die 'caddy rejected the installed configuration'
else
  if [ ! -d "$nginx_available_dir" ]; then nginx_available_dir_created=1; fi
  if [ ! -d "$nginx_enabled_dir" ]; then nginx_enabled_dir_created=1; fi
  install -d -o root -g root -m 0755 "$nginx_available_dir" "$nginx_enabled_dir"
  install -o root -g root -m 0644 "$bundle_dir/agent-console.nginx.conf" "$nginx_available"
  ln -sfn "$nginx_available" "$nginx_enabled"
  nginx -t || die 'nginx rejected the installed configuration'
fi

if [ ! -d "$metadata_dir" ]; then metadata_dir_created=1; fi
install -d -o root -g root -m 0700 "$metadata_dir"
install -o root -g root -m 0600 "$deployment_file" "$installed_metadata"

if [ "$proxy" = caddy ]; then
  systemctl reload caddy || die 'caddy reload failed'
else
  systemctl reload nginx || die 'nginx reload failed'
fi
reload_sshd || die 'SSH reload failed'

committed=1
printf '%s\n' "Installed restricted reverse-tunnel access for $remote_domain."
printf '%s\n' "The tunnel is limited to 127.0.0.1:$gateway_port; this installer did not open a firewall port."
