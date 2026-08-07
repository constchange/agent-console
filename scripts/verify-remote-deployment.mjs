import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-remote-unit-verification-'))
const { renderGatewayServiceUnit, renderTunnelServiceUnit } = require(
  path.join(root, 'dist', 'electron', 'core', 'services', 'remote-service-unit.js'),
)

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const gatewaySocket = path.join(temporaryDirectory, 'run', 'agent-console', 'gateway', 'core.sock')
  const desktopSocket = path.join(temporaryDirectory, 'run', 'agent-console', 'desktop', 'core.sock')
  const environmentFile = path.join(temporaryDirectory, 'remote.env')
  const sshKey = path.join(temporaryDirectory, 'id_ed25519')
  const knownHosts = path.join(temporaryDirectory, 'known_hosts')
  const sshPublicKey = path.join(temporaryDirectory, 'id_ed25519.pub')
  const gatewayUnit = renderGatewayServiceUnit({
    executable: process.execPath,
    remoteEnvironmentFile: environmentFile,
    gatewaySocketPath: gatewaySocket,
    desktopCoreSocketPath: desktopSocket,
  })
  const tunnelUnit = renderTunnelServiceUnit({
    launcher: '/usr/bin/true',
    remoteEnvironmentFile: environmentFile,
    sshKeyPath: sshKey,
    sshPublicKeyPath: sshPublicKey,
    knownHostsPath: knownHosts,
  })
  invariant(gatewayUnit.includes('IPAddressDeny=any') && gatewayUnit.includes('IPAddressAllow=localhost'), 'Gateway unit is not locked to localhost')
  invariant(gatewayUnit.includes(`InaccessiblePaths=${desktopSocket}`), 'Gateway unit can see the desktop Core socket')
  invariant(!tunnelUnit.includes('IPAddressDeny=any'), 'Tunnel unit cannot reach the VPS')
  const gatewayPath = path.join(temporaryDirectory, 'agent-console-gateway.service')
  const tunnelPath = path.join(temporaryDirectory, 'agent-console-tunnel.service')
  await Promise.all([
    fs.writeFile(gatewayPath, gatewayUnit, { mode: 0o600 }),
    fs.writeFile(tunnelPath, tunnelUnit, { mode: 0o600 }),
  ])
  const verification = await execFileAsync('systemd-analyze', ['verify', gatewayPath, tunnelPath], { timeout: 30_000, maxBuffer: 4_000_000 })
  invariant(!verification.stdout.trim() && !verification.stderr.trim(), `systemd-analyze reported a problem:\n${verification.stdout}${verification.stderr}`)
  invariant(
    gatewayUnit.includes(' --disable-gpu --ozone-platform=headless --remote-gateway '),
    'Rendered Gateway unit does not use the headless Electron flags',
  )
  invariant(tunnelUnit.includes(`BindReadOnlyPaths=${environmentFile}`), 'Tunnel sandbox cannot read remote.env')
  invariant(tunnelUnit.includes(`BindReadOnlyPaths=${sshPublicKey}`), 'Tunnel sandbox cannot read the SSH public key')
  await execFileAsync(process.execPath, ['--check', path.join(root, 'resources', 'remote', 'cli', 'agent-console-remote.mjs')])
  for (const script of [
    path.join(root, 'resources', 'remote', 'bin', 'agent-console-remote'),
    path.join(root, 'resources', 'remote', 'vps', 'install.sh'),
    path.join(root, 'resources', 'remote', 'vps', 'uninstall.sh'),
  ]) await execFileAsync('sh', ['-n', script])
  const installer = await fs.readFile(path.join(root, 'resources', 'remote', 'vps', 'install.sh'), 'utf8')
  const uninstaller = await fs.readFile(path.join(root, 'resources', 'remote', 'vps', 'uninstall.sh'), 'utf8')
  const staticGatewayUnit = await fs.readFile(path.join(root, 'resources', 'remote', 'systemd', 'agent-console-gateway.service.tmpl'), 'utf8')
  const staticTunnelUnit = await fs.readFile(path.join(root, 'resources', 'remote', 'systemd', 'agent-console-tunnel.service.tmpl'), 'utf8')
  const nginxTemplate = await fs.readFile(path.join(root, 'resources', 'remote', 'vps', 'nginx', 'agent-console.conf.tmpl'), 'utf8')
  const deploymentGuide = await fs.readFile(path.join(root, 'docs', 'REMOTE-DEPLOYMENT.md'), 'utf8')
  invariant(installer.includes('AllowTcpForwarding remote') && installer.includes('PermitOpen none'), 'VPS SSH policy does not block local forwarding')
  invariant(installer.includes('MaxSessions 0'), 'VPS SSH policy does not block sessions')
  invariant(installer.includes('trap finish 0') && installer.includes('rollback()'), 'VPS installer has no transactional rollback trap')
  invariant(installer.includes('snapshot_path "$caddy_main" caddy-main'), 'VPS installer does not snapshot the Caddy import owner')
  invariant(installer.includes('userdel --remove "$tunnel_user"'), 'VPS installer cannot roll back a newly created tunnel user')
  const transactionStart = installer.indexOf('\ntransaction_started=1\n')
  invariant(transactionStart > 0, 'VPS installer does not mark its mutation boundary')
  invariant(installer.indexOf("caddy validate --config \"$bundle_dir/agent-console.caddy\"") < transactionStart, 'Caddy staged validation is not preflighted')
  invariant(installer.indexOf("nginx -t -c \"$staged_nginx\"") < transactionStart, 'Nginx staged validation is not preflighted')
  invariant(uninstaller.includes('trap finish 0') && uninstaller.includes('snapshot_path "$deployment_file" metadata'), 'VPS uninstaller is not transactional')
  invariant(staticGatewayUnit.includes('--disable-gpu --ozone-platform=headless --remote-gateway'), 'Static Gateway unit lacks headless Electron flags')
  invariant(staticTunnelUnit.includes('BindReadOnlyPaths=@@REMOTE_ENV_FILE@@'), 'Static Tunnel unit cannot read remote.env')
  invariant(staticTunnelUnit.includes('BindReadOnlyPaths=@@SSH_PUBLIC_KEY_PATH@@'), 'Static Tunnel unit cannot read the SSH public key')
  invariant(nginxTemplate.includes('limit_req_zone $binary_remote_addr'), 'Nginx edge has no source-IP request limiter')
  invariant(nginxTemplate.includes('limit_conn_zone $binary_remote_addr'), 'Nginx edge has no source-IP connection limiter')
  invariant(nginxTemplate.includes('proxy_request_buffering on;'), 'Nginx edge does not buffer request bodies before the tunnel')
  invariant(nginxTemplate.includes('location ~ ^/v1/events(?:/stream)?$') && nginxTemplate.includes('proxy_read_timeout 330s'), 'Nginx SSE route is not covered by its long-lived event policy')
  invariant(deploymentGuide.includes('Gateway sees the reverse tunnel’s loopback address'), 'Deployment guide omits the Gateway loopback DoS boundary')
  invariant(deploymentGuide.includes('CDN/WAF') && deploymentGuide.includes('not the public DoS boundary')
    && deploymentGuide.includes('complete bounded-body buffering'), 'Deployment guide omits the required Caddy edge rate-limit/slow-body boundary')
  process.stdout.write('Remote deployment CLI, shell templates, and isolated systemd units passed verification.\n')
}

try {
  await main()
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}
