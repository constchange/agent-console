import path from 'node:path'

export const REMOTE_GATEWAY_SERVICE_NAME = 'agent-console-gateway.service'
export const REMOTE_TUNNEL_SERVICE_NAME = 'agent-console-tunnel.service'

function systemdQuote(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function systemdPath(value: string): string {
  return value
    .replace(/%/g, '%%')
    .replace(/\\/g, '\\x5c')
    .replace(/ /g, '\\x20')
    .replace(/\t/g, '\\x09')
    .replace(/"/g, '\\x22')
}

function validateAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes('\n') || value.includes('\0')) {
    throw new Error(`${label} must be one absolute path.`)
  }
  return value
}

export interface GatewayServiceUnitOptions {
  executable: string
  remoteEnvironmentFile: string
  gatewaySocketPath: string
  desktopCoreSocketPath: string
  /** Optional read-only path required when an AppImage executable lives below $HOME. */
  applicationReadOnlyPath?: string | null
}

export interface TunnelServiceUnitOptions {
  launcher: string
  remoteEnvironmentFile: string
  sshKeyPath: string
  sshPublicKeyPath: string
  knownHostsPath: string
  applicationReadOnlyPath?: string | null
}

function bindReadOnlyLines(paths: Array<string | null | undefined>): string {
  const unique = [...new Set(paths.filter((value): value is string => Boolean(value)).map((value) => validateAbsolutePath(value, 'Read-only path')))]
  return unique.map((value) => `BindReadOnlyPaths=${systemdPath(value)}`).join('\n')
}

export function renderGatewayServiceUnit(options: GatewayServiceUnitOptions): string {
  const executable = validateAbsolutePath(options.executable, 'Gateway executable')
  const envFile = validateAbsolutePath(options.remoteEnvironmentFile, 'Remote environment file')
  const gatewaySocketPath = validateAbsolutePath(options.gatewaySocketPath, 'Gateway Core socket')
  const desktopCoreSocketPath = validateAbsolutePath(options.desktopCoreSocketPath, 'Desktop Core socket')
  if (gatewaySocketPath === desktopCoreSocketPath) throw new Error('Gateway and desktop Core sockets must be different.')
  const readOnly = bindReadOnlyLines([options.applicationReadOnlyPath])
  const args = [
    systemdQuote(executable),
    '--disable-gpu',
    '--ozone-platform=headless',
    '--remote-gateway',
    systemdQuote(`--remote-gateway-socket=${gatewaySocketPath}`),
  ].join(' ')

  return `[Unit]
Description=Agent Console restricted mobile Remote Gateway
Documentation=https://github.com/constchange/agent-console
After=agent-console-core.service
Wants=agent-console-core.service
PartOf=agent-console-core.service
ConditionPathIsReadWrite=%t
ConditionPathExists=${systemdPath(envFile)}

[Service]
Type=simple
EnvironmentFile=-${systemdPath(envFile)}
Environment=HOME=%t/agent-console-gateway/home
Environment=XDG_CONFIG_HOME=%t/agent-console-gateway/config
Environment=XDG_CACHE_HOME=%t/agent-console-gateway/cache
Environment=DISPLAY=
Environment=WAYLAND_DISPLAY=
RuntimeDirectory=agent-console-gateway
RuntimeDirectoryMode=0700
ExecCondition=/usr/bin/test -x ${systemdQuote(executable)}
ExecCondition=/usr/bin/test -r ${systemdQuote(gatewaySocketPath)}
ExecStartPre=/usr/bin/install -d -m 0700 %t/agent-console-gateway/home %t/agent-console-gateway/config %t/agent-console-gateway/cache
ExecStart=${args}
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillMode=mixed
UMask=0077
NoNewPrivileges=yes
PrivateDevices=yes
PrivateTmp=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectHome=tmpfs
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectSystem=strict
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
InaccessiblePaths=${systemdPath(desktopCoreSocketPath)}
${readOnly}

[Install]
WantedBy=default.target
`
}

export function renderTunnelServiceUnit(options: TunnelServiceUnitOptions): string {
  const launcher = validateAbsolutePath(options.launcher, 'Remote launcher')
  const envFile = validateAbsolutePath(options.remoteEnvironmentFile, 'Remote environment file')
  const sshKeyPath = validateAbsolutePath(options.sshKeyPath, 'SSH key path')
  const sshPublicKeyPath = validateAbsolutePath(options.sshPublicKeyPath, 'SSH public key path')
  const knownHostsPath = validateAbsolutePath(options.knownHostsPath, 'known_hosts path')
  const launcherResourceRoot = path.dirname(path.dirname(launcher))
  const readOnly = bindReadOnlyLines([options.applicationReadOnlyPath, launcherResourceRoot, envFile, sshKeyPath, sshPublicKeyPath, knownHostsPath])
  const args = [
    systemdQuote(launcher),
    'tunnel-run',
    systemdQuote(`--env-file=${envFile}`),
  ].join(' ')

  return `[Unit]
Description=Agent Console autossh loopback reverse tunnel
Documentation=https://github.com/constchange/agent-console
After=network-online.target ${REMOTE_GATEWAY_SERVICE_NAME}
Wants=network-online.target
Requires=${REMOTE_GATEWAY_SERVICE_NAME}
PartOf=${REMOTE_GATEWAY_SERVICE_NAME}
ConditionPathExists=${systemdPath(envFile)}

[Service]
Type=simple
EnvironmentFile=-${systemdPath(envFile)}
Environment=AUTOSSH_GATETIME=0
Environment=AUTOSSH_PORT=0
Environment=DISPLAY=
Environment=WAYLAND_DISPLAY=
ExecCondition=/usr/bin/test -x ${systemdQuote(launcher)}
ExecCondition=/usr/bin/test -r ${systemdQuote(sshKeyPath)}
ExecCondition=/usr/bin/test -r ${systemdQuote(sshPublicKeyPath)}
ExecCondition=/usr/bin/test -r ${systemdQuote(knownHostsPath)}
ExecStart=${args}
Restart=always
RestartSec=5
TimeoutStopSec=15
KillMode=mixed
UMask=0077
NoNewPrivileges=yes
PrivateDevices=yes
PrivateTmp=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectHome=tmpfs
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectSystem=strict
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
${readOnly}

[Install]
WantedBy=default.target
`
}
