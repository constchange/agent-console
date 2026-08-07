import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const cli = path.join(root, 'resources', 'remote', 'cli', 'agent-console-remote.mjs')
const fixtures: string[] = []

function run(args: string[], environment: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...environment } })
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent console remote cli-'))
  fixtures.push(directory)
  const sshDirectory = path.join(directory, 'ssh')
  mkdirSync(sshDirectory, { mode: 0o700 })
  const privateKey = path.join(sshDirectory, 'id_ed25519')
  const publicKey = `${privateKey}.pub`
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'cli-test', '-f', privateKey])
  const keyFields = readFileSync(publicKey, 'utf8').trim().split(/\s+/u)
  const hostKey = keyFields[1]
  const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(hostKey, 'base64')).digest('base64').replace(/=+$/u, '')}`
  const knownHosts = path.join(sshDirectory, 'known_hosts')
  writeFileSync(knownHosts, `vps.remote.test ssh-ed25519 ${hostKey}\n`, { mode: 0o600 })
  const environmentFile = path.join(directory, 'remote.env')
  const environment = [
    'AGENT_CONSOLE_REMOTE_ARMED=0',
    'AGENT_CONSOLE_SUPABASE_URL=https://project.supabase.co',
    'AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_abcdefghijklmnopqrstuvwxyz0123456789',
    'AGENT_CONSOLE_PUBLIC_BASE_URL=https://remote.test',
    'AGENT_CONSOLE_GATEWAY_LOCAL_HOST=127.0.0.1',
    'AGENT_CONSOLE_GATEWAY_LOCAL_PORT=43127',
    'AGENT_CONSOLE_GATEWAY_VPS_PORT=43128',
    'AGENT_CONSOLE_VPS_HOST=vps.remote.test',
    'AGENT_CONSOLE_VPS_USER=agent-console-tunnel',
    'AGENT_CONSOLE_VPS_SSH_PORT=22',
    `AGENT_CONSOLE_VPS_HOST_ED25519_SHA256=${fingerprint}`,
    `AGENT_CONSOLE_SSH_KEY_PATH=${privateKey}`,
    `AGENT_CONSOLE_SSH_PUBLIC_KEY_PATH=${publicKey}`,
    `AGENT_CONSOLE_SSH_KNOWN_HOSTS_PATH=${knownHosts}`,
    'AGENT_CONSOLE_VPS_PROXY=caddy',
    '',
  ].join('\n')
  writeFileSync(environmentFile, environment, { mode: 0o600 })
  return { directory, environmentFile, environment }
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true })
})

describe('Remote deployment CLI', () => {
  it('packages a discoverable deb command with bounded install/remove hooks', () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(packageJson.version).toBe('0.5.1')
    expect(packageJson.build.deb).toEqual({
      afterInstall: 'resources/remote/deb/after-install.tpl',
      afterRemove: 'resources/remote/deb/after-remove.tpl',
    })
    const launcher = readFileSync(path.join(root, 'resources', 'remote', 'bin', 'agent-console-remote'), 'utf8')
    const afterInstall = readFileSync(path.join(root, 'resources', 'remote', 'deb', 'after-install.tpl'), 'utf8')
    const afterRemove = readFileSync(path.join(root, 'resources', 'remote', 'deb', 'after-remove.tpl'), 'utf8')
    expect(launcher).toContain('readlink -f -- "$0"')
    expect(afterInstall).toContain("update-alternatives --install \"$REMOTE_COMMAND\" 'agent-console-remote'")
    expect(afterInstall).toContain('Refusing to replace unrelated $REMOTE_COMMAND')
    expect(afterRemove).toContain("update-alternatives --remove 'agent-console-remote' \"$REMOTE_TARGET\"")
  })

  it('validates only a private, non-secret workstation configuration', () => {
    const item = fixture()
    const result = JSON.parse(run(['validate', '--env-file', item.environmentFile, '--json']))
    expect(result).toMatchObject({
      ok: true,
      armed: false,
      publicOrigin: 'https://remote.test',
      localGateway: '127.0.0.1:43127',
      vpsLoopbackPort: 43128,
      proxy: 'caddy',
    })

    const secretEnvironment = path.join(item.directory, 'secret.env')
    writeFileSync(secretEnvironment, item.environment.replace(/sb_publishable_[^\n]+/u, 'sb_secret_should-never-be-installed'), { mode: 0o600 })
    expect(() => run(['validate', '--env-file', secretEnvironment])).toThrow(/secret\/service_role keys are forbidden/u)
  })

  it('requires an exact 0600 env file and an origin-only Supabase URL', () => {
    const item = fixture()
    const pathEnvironment = path.join(item.directory, 'supabase-path.env')
    writeFileSync(
      pathEnvironment,
      item.environment.replace('https://project.supabase.co', 'https://project.supabase.co/auth/v1?debug=1#fragment'),
      { mode: 0o600 },
    )
    expect(() => run(['validate', '--env-file', pathEnvironment])).toThrow(/origin without a path, query, or fragment/u)

    chmodSync(item.environmentFile, 0o400)
    expect(() => run(['validate', '--env-file', item.environmentFile])).toThrow(/exact mode 0600/u)
  })

  it('rejects a group- or world-writable SSH public key', () => {
    const item = fixture()
    chmodSync(path.join(item.directory, 'ssh', 'id_ed25519.pub'), 0o666)
    expect(() => run([
      'install', '--offline',
      '--env-file', item.environmentFile,
      '--target-env-file', path.join(item.directory, 'config', 'remote.env'),
      '--data-directory', path.join(item.directory, 'data'),
      '--systemd-directory', path.join(item.directory, 'systemd'),
      '--app-executable', process.execPath,
    ])).toThrow(/must not be group- or world-writable/u)
  })

  it('renders a secret-free VPS bundle with a no-shell restricted key', () => {
    const item = fixture()
    const output = path.join(item.directory, 'rendered')
    run(['render', '--env-file', item.environmentFile, '--output', output])

    const authorizedKey = readFileSync(path.join(output, 'authorized_key'), 'utf8')
    expect(authorizedKey).toContain('restrict,port-forwarding,permitlisten="127.0.0.1:43128",permitopen="127.0.0.1:1"')
    expect(authorizedKey).not.toContain('command=')
    expect(readFileSync(path.join(output, 'agent-console.caddy'), 'utf8')).toContain('reverse_proxy @remote_api 127.0.0.1:43128')
    const nginx = readFileSync(path.join(output, 'agent-console.nginx.conf'), 'utf8')
    expect(nginx).toContain('server_name remote.test;')
    expect(nginx).toContain('limit_req_zone $binary_remote_addr')
    expect(nginx).toContain('limit_conn_zone $binary_remote_addr')
    expect(nginx).toContain('proxy_request_buffering on;')
    expect(nginx).toContain('location ~ ^/v1/events(?:/stream)?$')
    expect(nginx).toContain('proxy_read_timeout 330s')
    expect(readFileSync(path.join(output, 'deployment.env'), 'utf8')).not.toContain('SUPABASE')
  })

  it('offline-installs verified units with the actual Core socket namespaces', () => {
    const item = fixture()
    const installedEnvironment = path.join(item.directory, 'config', 'remote.env')
    const dataDirectory = path.join(item.directory, 'data')
    const systemdDirectory = path.join(item.directory, 'systemd')
    const gatewaySocket = path.join(item.directory, 'run', 'agent-console', 'gateway', 'core.sock')
    const desktopSocket = path.join(item.directory, 'run', 'agent-console', 'desktop', 'core.sock')
    run([
      'install', '--offline',
      '--env-file', item.environmentFile,
      '--target-env-file', installedEnvironment,
      '--data-directory', dataDirectory,
      '--systemd-directory', systemdDirectory,
      '--app-executable', process.execPath,
      '--gateway-socket', gatewaySocket,
      '--desktop-core-socket', desktopSocket,
    ])

    const gateway = readFileSync(path.join(systemdDirectory, 'agent-console-gateway.service'), 'utf8')
    const tunnel = readFileSync(path.join(systemdDirectory, 'agent-console-tunnel.service'), 'utf8')
    expect(gateway).toContain('--disable-gpu --ozone-platform=headless --remote-gateway')
    expect(gateway).toContain(`--remote-gateway-socket=${gatewaySocket.replaceAll(' ', '\\x20')}`)
    expect(gateway).toContain(`InaccessiblePaths=${desktopSocket.replaceAll(' ', '\\x20')}`)
    expect(gateway).toContain('IPAddressDeny=any')
    expect(tunnel).not.toContain('IPAddressDeny=any')
    expect(tunnel).toContain(`BindReadOnlyPaths=${installedEnvironment.replaceAll(' ', '\\x20')}`)
    expect(tunnel).toContain(`BindReadOnlyPaths=${`${item.directory}/ssh/id_ed25519.pub`.replaceAll(' ', '\\x20')}`)
    expect(tunnel).toContain(`BindReadOnlyPaths=${dataDirectory.replaceAll(' ', '\\x20')}`)
    expect(statSync(installedEnvironment).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(dataDirectory, 'bin', 'agent-console-remote-service')).mode & 0o777).toBe(0o700)
  })

  it('disables both services if enable --now fails partway', () => {
    const item = fixture()
    writeFileSync(item.environmentFile, item.environment.replace('AGENT_CONSOLE_REMOTE_ARMED=0', 'AGENT_CONSOLE_REMOTE_ARMED=1'), { mode: 0o600 })
    const fakeBin = path.join(item.directory, 'bin')
    const systemctlLog = path.join(item.directory, 'systemctl.log')
    mkdirSync(fakeBin)
    const fakeSystemctl = path.join(fakeBin, 'systemctl')
    writeFileSync(fakeSystemctl, `#!/bin/sh
printf '%s\\n' "$*" >> '${systemctlLog}'
case "$*" in
  *' is-active agent-console-core.service'*) printf '%s\n' active ; exit 0 ;;
  *' enable --now '*) exit 42 ;;
  *) exit 0 ;;
esac
`, { mode: 0o700 })
    chmodSync(fakeSystemctl, 0o700)

    expect(() => run([
      'install', '--enable',
      '--env-file', item.environmentFile,
      '--target-env-file', path.join(item.directory, 'config', 'remote.env'),
      '--data-directory', path.join(item.directory, 'data'),
      '--systemd-directory', path.join(item.directory, 'systemd'),
      '--app-executable', process.execPath,
      '--gateway-socket', path.join(item.directory, 'run', 'gateway', 'core.sock'),
      '--desktop-core-socket', path.join(item.directory, 'run', 'desktop', 'core.sock'),
    ], { PATH: `${fakeBin}:${process.env.PATH ?? ''}` })).toThrow()

    const log = readFileSync(systemctlLog, 'utf8')
    expect(log).toContain('--user restart agent-console-core.service')
    expect(log).toContain('--user enable --now agent-console-gateway.service agent-console-tunnel.service')
    expect(log).toContain('--user disable --now agent-console-gateway.service agent-console-tunnel.service')
  })
})
