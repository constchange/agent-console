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

export function renderCoreServiceUnit(executable: string, userDataPath: string, remoteEnvironmentFile?: string | null): string {
  const args = [
    systemdQuote(executable),
    '--console-core',
    systemdQuote(`--console-core-user-data=${userDataPath}`),
    '--disable-gpu',
    '--ozone-platform=headless',
  ].join(' ')
  return `[Unit]
Description=Agent Console local control core

[Service]
Type=simple
${remoteEnvironmentFile ? `EnvironmentFile=-${systemdPath(remoteEnvironmentFile)}\n` : ''}ExecCondition=/usr/bin/test -x ${systemdQuote(executable)}
ExecStart=${args}
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillMode=process
UMask=0077
NoNewPrivileges=yes
LockPersonality=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=default.target
`
}
