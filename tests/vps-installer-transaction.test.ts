import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const installerSource = path.join(root, 'resources', 'remote', 'vps', 'install.sh')
const uninstallerSource = path.join(root, 'resources', 'remote', 'vps', 'uninstall.sh')
const fixtures: string[] = []

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o700 })
}

interface Fixture {
  directory: string
  systemEtc: string
  home: string
  userState: string
  bundle: string
  installer: string
  uninstaller: string
  env: NodeJS.ProcessEnv
}

function fixture(proxy: 'caddy' | 'nginx', existingUser: boolean): Fixture {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent console vps transaction-'))
  fixtures.push(directory)
  const systemEtc = path.join(directory, 'etc')
  const home = path.join(directory, 'home', 'remote-test')
  const userState = path.join(directory, 'remote-test.exists')
  const bundle = path.join(directory, 'bundle')
  const fakeBin = path.join(directory, 'bin')
  mkdirSync(path.join(systemEtc, 'ssh'), { recursive: true })
  mkdirSync(bundle, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(path.join(systemEtc, 'ssh', 'sshd_config'), '# existing sshd config\n')
  if (existingUser) {
    mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o750 })
    writeFileSync(userState, 'present\n')
  }

  writeFileSync(path.join(bundle, 'deployment.env'), [
    'REMOTE_DOMAIN=remote.test',
    'VPS_GATEWAY_PORT=43128',
    'VPS_TUNNEL_USER=remote-test',
    `VPS_PROXY=${proxy}`,
    '',
  ].join('\n'))
  writeFileSync(
    path.join(bundle, 'authorized_key'),
    'restrict,port-forwarding,permitlisten="127.0.0.1:43128",permitopen="127.0.0.1:1" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest agent-console-remote\n',
  )
  writeFileSync(path.join(bundle, 'agent-console.caddy'), 'remote.test { reverse_proxy 127.0.0.1:43128 }\n')
  writeFileSync(path.join(bundle, 'agent-console.nginx.conf'), 'server { listen 443 ssl; server_name remote.test; }\n')

  writeExecutable(path.join(fakeBin, 'id'), `#!/bin/sh
case "\${1:-}" in
  -u) printf '0\\n'; exit 0 ;;
  -gn) [ -f ${shellQuote(userState)} ] || exit 1; printf 'remote-test\\n'; exit 0 ;;
  remote-test) [ -f ${shellQuote(userState)} ]; exit ;;
esac
exit 1
`)
  writeExecutable(path.join(fakeBin, 'getent'), `#!/bin/sh
[ "\${1:-}" = passwd ] && [ "\${2:-}" = remote-test ] && [ -f ${shellQuote(userState)} ] || exit 2
printf 'remote-test:x:2001:2001::%s:/usr/sbin/nologin\\n' ${shellQuote(home)}
`)
  writeExecutable(path.join(fakeBin, 'useradd'), `#!/bin/sh
mkdir -p ${shellQuote(home)}
: > ${shellQuote(userState)}
`)
  writeExecutable(path.join(fakeBin, 'userdel'), `#!/bin/sh
rm -f ${shellQuote(userState)}
rm -rf ${shellQuote(home)}
`)
  writeExecutable(path.join(fakeBin, 'openssl'), `#!/bin/sh
case "\${1:-}" in
  rand) printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\\n' ;;
  passwd) sed 's/.*/\\$6\\$transaction-test-hash/' ;;
  *) exit 2 ;;
esac
`)
  writeExecutable(path.join(fakeBin, 'sshd'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(fakeBin, 'caddy'), `#!/bin/sh
for argument in "$@"; do
  if [ -n "\${FAIL_CADDY_CONFIG:-}" ] && [ "$argument" = "$FAIL_CADDY_CONFIG" ]; then exit 43; fi
done
exit 0
`)
  writeExecutable(path.join(fakeBin, 'nginx'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(fakeBin, 'systemctl'), `#!/bin/sh
if [ "\${1:-}" = reload ] && [ "\${2:-}" = "\${FAIL_RELOAD_SERVICE:-}" ]; then
  exit 42
fi
exit 0
`)

  const transformed = readFileSync(installerSource, 'utf8')
    .replace('system_etc=/etc', `system_etc=${shellQuote(systemEtc)}`)
    .replaceAll('/etc/caddy/conf.d/*.caddy', `${systemEtc}/caddy/conf.d/*.caddy`)
    .replaceAll('-o "$tunnel_user" -g "$tunnel_group" ', '')
    .replaceAll('-o root -g root ', '')
  const installer = path.join(directory, 'install.sh')
  writeFileSync(installer, transformed, { mode: 0o700 })
  chmodSync(installer, 0o700)
  const transformedUninstaller = readFileSync(uninstallerSource, 'utf8')
    .replace('system_etc=/etc', `system_etc=${shellQuote(systemEtc)}`)
    .replaceAll('-o "$tunnel_user" -g "$tunnel_group" ', '')
  const uninstaller = path.join(directory, 'uninstall.sh')
  writeFileSync(uninstaller, transformedUninstaller, { mode: 0o700 })

  return {
    directory,
    systemEtc,
    home,
    userState,
    bundle,
    installer,
    uninstaller,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      FAIL_RELOAD_SERVICE: proxy,
    },
  }
}

function run(item: Fixture) {
  return spawnSync('sh', [item.installer, '--bundle', item.bundle], {
    cwd: item.directory,
    encoding: 'utf8',
    env: item.env,
    timeout: 10_000,
  })
}

function runUninstaller(item: Fixture) {
  return spawnSync('sh', [item.uninstaller], {
    cwd: item.directory,
    encoding: 'utf8',
    env: item.env,
    timeout: 10_000,
  })
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true })
})

describe('VPS installer transaction', () => {
  it('commits a fully validated Caddy installation only after both reloads succeed', () => {
    const item = fixture('caddy', true)
    const keys = path.join(item.home, '.ssh', 'authorized_keys')
    const caddyMain = path.join(item.systemEtc, 'caddy', 'Caddyfile')
    mkdirSync(path.dirname(caddyMain), { recursive: true })
    writeFileSync(keys, '# retained comment\n')
    writeFileSync(caddyMain, '# administrator Caddyfile\n')
    item.env.FAIL_RELOAD_SERVICE = ''

    const result = run(item)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(readFileSync(keys, 'utf8')).toContain('permitlisten="127.0.0.1:43128"')
    expect(readFileSync(path.join(item.systemEtc, 'ssh', 'sshd_config.d', '90-agent-console-remote.conf'), 'utf8')).toContain('AllowTcpForwarding remote')
    expect(readFileSync(caddyMain, 'utf8')).toContain(`import ${item.systemEtc}/caddy/conf.d/*.caddy`)
    expect(readFileSync(path.join(item.systemEtc, 'caddy', 'conf.d', 'agent-console.caddy'), 'utf8')).toContain('reverse_proxy 127.0.0.1:43128')
    expect(readFileSync(path.join(item.systemEtc, 'agent-console-remote', 'deployment.env'), 'utf8')).toContain('VPS_PROXY=caddy')
  })

  it('restores every existing managed file when Caddy reload fails', () => {
    const item = fixture('caddy', true)
    const keys = path.join(item.home, '.ssh', 'authorized_keys')
    const sshdDropin = path.join(item.systemEtc, 'ssh', 'sshd_config.d', '90-agent-console-remote.conf')
    const caddyMain = path.join(item.systemEtc, 'caddy', 'Caddyfile')
    const caddySite = path.join(item.systemEtc, 'caddy', 'conf.d', 'agent-console.caddy')
    const metadata = path.join(item.systemEtc, 'agent-console-remote', 'deployment.env')
    mkdirSync(path.dirname(sshdDropin), { recursive: true })
    mkdirSync(path.dirname(caddySite), { recursive: true })
    mkdirSync(path.dirname(metadata), { recursive: true })
    const originals = new Map([
      [keys, '# retained comment\nold-marker agent-console-remote\n'],
      [sshdDropin, '# old ssh policy\n'],
      [caddyMain, '# old Caddyfile without managed import\n'],
      [caddySite, '# old Caddy site\n'],
      [metadata, 'old deployment metadata\n'],
    ])
    for (const [filePath, contents] of originals) writeFileSync(filePath, contents)

    const result = run(item)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('caddy reload failed')
    expect(result.stderr).toContain('restoring the exact managed-file snapshots')
    for (const [filePath, contents] of originals) expect(readFileSync(filePath, 'utf8')).toBe(contents)
    expect(existsSync(item.userState)).toBe(true)
  })

  it('removes a newly created user and all managed files when Nginx reload fails', () => {
    const item = fixture('nginx', false)
    const certificateDirectory = path.join(item.systemEtc, 'letsencrypt', 'live', 'remote.test')
    const nginxAvailable = path.join(item.systemEtc, 'nginx', 'sites-available', 'agent-console')
    const nginxEnabled = path.join(item.systemEtc, 'nginx', 'sites-enabled', 'agent-console')
    mkdirSync(certificateDirectory, { recursive: true })
    mkdirSync(path.dirname(nginxAvailable), { recursive: true })
    mkdirSync(path.dirname(nginxEnabled), { recursive: true })
    writeFileSync(path.join(certificateDirectory, 'fullchain.pem'), 'test certificate\n')
    writeFileSync(path.join(certificateDirectory, 'privkey.pem'), 'test private key\n')
    const unrelatedLink = path.join(item.systemEtc, 'nginx', 'sites-enabled', 'unrelated')
    symlinkSync('/etc/nginx/sites-available/unrelated', unrelatedLink)

    const result = run(item)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('nginx reload failed')
    expect(result.stderr).toContain('restoring the exact managed-file snapshots')
    expect(existsSync(item.userState)).toBe(false)
    expect(existsSync(item.home)).toBe(false)
    expect(existsSync(nginxAvailable)).toBe(false)
    expect(existsSync(nginxEnabled)).toBe(false)
    expect(readlinkSync(unrelatedLink)).toBe('/etc/nginx/sites-available/unrelated')
    expect(existsSync(path.join(item.systemEtc, 'ssh', 'sshd_config.d', '90-agent-console-remote.conf'))).toBe(false)
    expect(existsSync(path.join(item.systemEtc, 'agent-console-remote', 'deployment.env'))).toBe(false)
  })

  it('restores the previous Caddy import and site when installed-config validation fails', () => {
    const item = fixture('caddy', true)
    const keys = path.join(item.home, '.ssh', 'authorized_keys')
    const caddyMain = path.join(item.systemEtc, 'caddy', 'Caddyfile')
    const caddySite = path.join(item.systemEtc, 'caddy', 'conf.d', 'agent-console.caddy')
    mkdirSync(path.dirname(caddySite), { recursive: true })
    const oldMain = '# administrator Caddyfile\n'
    const oldSite = '# prior managed site\n'
    writeFileSync(keys, '# retained\nold-key agent-console-remote\n')
    writeFileSync(caddyMain, oldMain)
    writeFileSync(caddySite, oldSite)
    item.env.FAIL_RELOAD_SERVICE = ''
    item.env.FAIL_CADDY_CONFIG = caddyMain

    const result = run(item)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('caddy rejected the installed configuration')
    expect(readFileSync(caddyMain, 'utf8')).toBe(oldMain)
    expect(readFileSync(caddySite, 'utf8')).toBe(oldSite)
    expect(readFileSync(keys, 'utf8')).toBe('# retained\nold-key agent-console-remote\n')
  })

  it('restores keys, policy, proxy, and metadata when uninstall reload fails', () => {
    const item = fixture('caddy', true)
    const keys = path.join(item.home, '.ssh', 'authorized_keys')
    const sshdDropin = path.join(item.systemEtc, 'ssh', 'sshd_config.d', '90-agent-console-remote.conf')
    const caddyMain = path.join(item.systemEtc, 'caddy', 'Caddyfile')
    const caddySite = path.join(item.systemEtc, 'caddy', 'conf.d', 'agent-console.caddy')
    const metadata = path.join(item.systemEtc, 'agent-console-remote', 'deployment.env')
    mkdirSync(path.dirname(sshdDropin), { recursive: true })
    mkdirSync(path.dirname(caddySite), { recursive: true })
    mkdirSync(path.dirname(metadata), { recursive: true })
    const originals = new Map([
      [keys, '# retained comment\ninstalled-key agent-console-remote\n'],
      [sshdDropin, '# installed ssh policy\n'],
      [caddyMain, 'import /etc/caddy/conf.d/*.caddy\n'],
      [caddySite, '# installed Caddy site\n'],
      [metadata, [
        'REMOTE_DOMAIN=remote.test',
        'VPS_GATEWAY_PORT=43128',
        'VPS_TUNNEL_USER=remote-test',
        'VPS_PROXY=caddy',
        '',
      ].join('\n')],
    ])
    for (const [filePath, contents] of originals) writeFileSync(filePath, contents)

    const result = runUninstaller(item)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('caddy reload failed')
    expect(result.stderr).toContain('restoring the exact managed-file snapshots')
    for (const [filePath, contents] of originals) expect(readFileSync(filePath, 'utf8')).toBe(contents)
    expect(existsSync(item.userState)).toBe(true)
  })
})
