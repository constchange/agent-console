function systemdQuote(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderCoreServiceUnit(executable: string, userDataPath: string): string {
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
ExecCondition=/usr/bin/test -x ${systemdQuote(executable)}
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
