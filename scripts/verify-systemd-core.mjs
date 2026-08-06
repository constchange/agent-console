import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const executable = process.argv[2] ? path.resolve(process.argv[2]) : ''
const { renderCoreServiceUnit } = require(path.join(root, 'dist/electron/core/services/core-service-unit.js'))
const serviceName = 'agent-console-core.service'
const runtimeRoot = process.env.XDG_RUNTIME_DIR
const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
const unitPath = path.join(configHome, 'systemd', 'user', serviceName)
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-systemd-verification-'))
const userData = path.join(fixtureRoot, 'user-data')
const socketPath = runtimeRoot ? path.join(runtimeRoot, 'agent-console', 'core.sock') : ''
const tmuxSession = `agent-console-ci-${process.pid}`
let unitCreated = false
let tmuxTouched = false

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

async function verifySystemdUnit(targetPath) {
  const { stdout, stderr } = await execFileAsync('systemd-analyze', ['verify', targetPath], { maxBuffer: 4_000_000 })
  invariant(!stdout.trim() && !stderr.trim(), `systemd-analyze reported a unit problem:\n${stdout}${stderr}`)
}

function createRpcClient(targetSocket) {
  const socket = net.createConnection({ path: targetSocket })
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method === 'core.event') continue
      const request = pending.get(message.id)
      if (!request) continue
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else request.resolve(message.result)
    }
  })
  socket.on('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Console Core socket closed'))
    }
    pending.clear()
  })
  return {
    socket,
    connected: new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    }),
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timed out waiting for ${method}`))
        }, 10_000)
        pending.set(id, { resolve, reject, timer })
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
      })
    },
  }
}

async function connectToCore(previousPid = null, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    const isSocket = await fs.stat(socketPath).then((stat) => stat.isSocket(), () => false)
    if (!isSocket) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    const rpc = createRpcClient(socketPath)
    try {
      await rpc.connected
      await rpc.request('initialize', {
        protocolVersion: 1,
        client: { name: 'systemd-package-verifier', version: packageJson.version },
      })
      await rpc.request('events.subscribe', { afterSeq: 0 })
      const health = await rpc.request('core.health')
      if (previousPid && health.pid === previousPid) {
        rpc.socket.destroy()
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      return { rpc, health }
    } catch (error) {
      lastError = error
      rpc.socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${socketPath}`)
}

async function listeningTcpSocketsOwnedBy(pid) {
  const descriptors = await fs.readdir(`/proc/${pid}/fd`)
  const inodes = new Set()
  await Promise.all(descriptors.map(async (descriptor) => {
    const target = await fs.readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => '')
    const match = target.match(/^socket:\[(\d+)]$/)
    if (match) inodes.add(match[1])
  }))
  const owned = []
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = (await fs.readFile(table, 'utf8')).trim().split('\n').slice(1)
    for (const row of rows) {
      const columns = row.trim().split(/\s+/)
      if (columns[3] === '0A' && inodes.has(columns[9])) owned.push(columns[1])
    }
  }
  return owned
}

async function systemctl(...args) {
  return execFileAsync('systemctl', ['--user', ...args], { timeout: 20_000, maxBuffer: 4_000_000 })
}

async function writeFixtureState() {
  const state = {
    version: 1,
    projects: [{ id: 'systemd-project', name: 'Systemd Verification', emoji: '◇', color: '#55a6ff', collapsed: false, order: 0 }],
    agents: [{
      id: 'systemd-agent',
      projectId: 'systemd-project',
      name: 'Systemd Agent',
      emoji: '◇',
      color: '#55a6ff',
      kind: 'process',
      terminalTitle: '◇ Systemd Agent',
      terminalApp: 'auto',
      tmuxSession,
      command: 'sleep 300',
      cwd: fixtureRoot,
      matchPattern: '',
      logPath: '',
      autoStart: true,
      order: 0,
      pid: null,
      statusOverride: null,
    }],
    settings: { defaultTerminal: 'auto', scanIntervalMs: 2500, compactMode: true, fontSizePx: 25, theme: 'navy-gold' },
  }
  await fs.mkdir(userData, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(userData, 'mission-control-state.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

try {
  invariant(process.platform === 'linux', 'The systemd Core verification only runs on Linux.')
  invariant(executable, 'Pass the installed Agent Console executable as the first argument.')
  invariant(runtimeRoot && path.isAbsolute(runtimeRoot), 'XDG_RUNTIME_DIR must be an absolute user runtime directory.')
  await Promise.all([fs.access(executable), execFileAsync('tmux', ['-V']), systemctl('show-environment')])
  invariant(!await fs.stat(socketPath).then(() => true, () => false), `Refusing to replace an existing Core socket: ${socketPath}`)
  invariant(!await fs.stat(unitPath).then(() => true, () => false), `Refusing to replace an existing user service: ${unitPath}`)

  await writeFixtureState()
  await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 })
  await fs.writeFile(unitPath, renderCoreServiceUnit(executable, userData), { mode: 0o600, flag: 'wx' })
  unitCreated = true
  await verifySystemdUnit(unitPath)
  await systemctl('daemon-reload')
  await systemctl('enable', '--now', serviceName)

  const active = (await systemctl('is-active', serviceName)).stdout.trim()
  invariant(active === 'active', `User service is not active: ${active}`)
  const first = await connectToCore()
  invariant(first.health.appVersion === packageJson.version, `systemd Core reports ${first.health.appVersion}`)
  invariant(first.health.transport === 'unix' && first.health.tcpListening === false, 'systemd Core reports an unsafe transport')
  invariant((await listeningTcpSocketsOwnedBy(first.health.pid)).length === 0, 'systemd Core opened a TCP listener')
  const environment = (await fs.readFile(`/proc/${first.health.pid}/environ`, 'utf8')).split('\u0000')
  invariant(!environment.some((entry) => entry.startsWith('DISPLAY=') && entry !== 'DISPLAY='), 'systemd Core inherited DISPLAY')
  invariant(!environment.some((entry) => entry.startsWith('WAYLAND_DISPLAY=') && entry !== 'WAYLAND_DISPLAY='), 'systemd Core inherited WAYLAND_DISPLAY')

  tmuxTouched = true
  const prepared = await first.rpc.request('terminal.open', { agentId: 'systemd-agent' })
  invariant(prepared.preparation?.ok === true, `Core could not create the tmux fixture: ${JSON.stringify(prepared)}`)
  await execFileAsync('tmux', ['has-session', '-t', tmuxSession])
  first.rpc.socket.destroy()

  await systemctl('restart', serviceName)
  const second = await connectToCore(first.health.pid)
  invariant(second.health.pid !== first.health.pid, 'systemd restart did not replace the Core process')
  await execFileAsync('tmux', ['has-session', '-t', tmuxSession])
  const bootstrap = await second.rpc.request('core.bootstrap')
  invariant(bootstrap.state.projects[0].name === 'Systemd Verification', 'systemd restart did not preserve state')
  invariant((await listeningTcpSocketsOwnedBy(second.health.pid)).length === 0, 'restarted systemd Core opened a TCP listener')
  second.rpc.socket.destroy()

  console.log(`Verified Agent Console v${packageJson.version} with a real systemd --user start/restart and surviving tmux session.`)
} finally {
  if (unitCreated) {
    await systemctl('stop', serviceName).catch(() => undefined)
    await systemctl('disable', serviceName).catch(() => undefined)
  }
  if (tmuxTouched) await execFileAsync('tmux', ['kill-session', '-t', tmuxSession]).catch(() => undefined)
  if (unitCreated) {
    await fs.rm(unitPath, { force: true }).catch(() => undefined)
    await systemctl('daemon-reload').catch(() => undefined)
    await systemctl('reset-failed', serviceName).catch(() => undefined)
  }
  await fs.rm(fixtureRoot, { recursive: true, force: true })
}
