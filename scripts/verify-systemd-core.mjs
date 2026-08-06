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
const COMMAND_TIMEOUT_MS = 20_000
const RPC_CONNECT_TIMEOUT_MS = 5_000
const RPC_REQUEST_TIMEOUT_MS = 10_000
const RPC_MAX_MESSAGE_BYTES = 1024 * 1024
let unitCreated = false
let tmuxTouched = false
const openRpcClients = new Set()

function checkpoint(message) {
  process.stdout.write(`[systemd-core] ${new Date().toISOString()} ${message}\n`)
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

async function verifySystemdUnit(targetPath) {
  const { stdout, stderr } = await runCommand('systemd-analyze', ['verify', targetPath])
  invariant(!stdout.trim() && !stderr.trim(), `systemd-analyze reported a unit problem:\n${stdout}${stderr}`)
}

function runCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 4_000_000,
    ...options,
  })
}

function createRpcClient(
  targetSocket,
  { connectTimeoutMs = RPC_CONNECT_TIMEOUT_MS, requestTimeoutMs = RPC_REQUEST_TIMEOUT_MS } = {},
) {
  const socket = net.createConnection({ path: targetSocket })
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  let connectionSettled = false
  let resolveConnection
  let rejectConnection
  let connectionTimer

  const connected = new Promise((resolve, reject) => {
    resolveConnection = resolve
    rejectConnection = reject
  })

  function settleConnection(error) {
    if (connectionSettled) return
    connectionSettled = true
    clearTimeout(connectionTimer)
    if (error) rejectConnection(error)
    else resolveConnection()
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  function close(error = new Error('Console Core socket closed')) {
    settleConnection(error)
    rejectPending(error)
    openRpcClients.delete(client)
    socket.destroy()
  }

  function fail(error) {
    close(error instanceof Error ? error : new Error(String(error)))
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer, 'utf8') > RPC_MAX_MESSAGE_BYTES + 1 && !buffer.includes('\n')) {
      fail(new Error('Console Core response exceeded the 1 MiB message limit'))
      return
    }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line, 'utf8') > RPC_MAX_MESSAGE_BYTES) {
        fail(new Error('Console Core response exceeded the 1 MiB message limit'))
        return
      }
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        fail(new Error(`Console Core returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        fail(new Error('Console Core returned a non-object JSON-RPC message'))
        return
      }
      if (message.method === 'core.event') continue
      const request = pending.get(message.id)
      if (!request) continue
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else request.resolve(message.result)
    }
  })
  socket.once('connect', () => settleConnection())
  socket.on('error', (error) => fail(error))
  socket.on('close', () => {
    settleConnection(new Error('Console Core socket closed before connecting'))
    rejectPending(new Error('Console Core socket closed'))
    openRpcClients.delete(client)
  })
  const client = {
    socket,
    connected,
    close,
    request(method, params, timeoutMs = requestTimeoutMs) {
      if (socket.destroyed || !socket.writable) {
        return Promise.reject(new Error('Console Core socket is not connected'))
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(new Error(`Timed out after ${timeoutMs} ms waiting for ${method}`))
        }, Math.max(1, timeoutMs))
        pending.set(id, { resolve, reject, timer })
        try {
          socket.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
            (error) => {
              if (error) fail(error)
            },
          )
        } catch (error) {
          fail(error)
        }
      })
    },
  }
  openRpcClients.add(client)
  connectionTimer = setTimeout(() => {
    fail(new Error(`Timed out after ${connectTimeoutMs} ms connecting to ${targetSocket}`))
  }, Math.max(1, connectTimeoutMs))
  return client
}

async function connectToCore(previousPid = null, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  checkpoint(`waiting up to ${timeoutMs} ms for ${previousPid ? 'a replacement' : 'the'} Core`)
  while (Date.now() < deadline) {
    const isSocket = await fs.stat(socketPath).then((stat) => stat.isSocket(), () => false)
    if (!isSocket) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    const remaining = () => Math.max(1, deadline - Date.now())
    const rpc = createRpcClient(socketPath, {
      connectTimeoutMs: Math.min(RPC_CONNECT_TIMEOUT_MS, remaining()),
      requestTimeoutMs: Math.min(RPC_REQUEST_TIMEOUT_MS, remaining()),
    })
    try {
      await rpc.connected
      await rpc.request('initialize', {
        protocolVersion: 1,
        client: { name: 'systemd-package-verifier', version: packageJson.version },
      }, Math.min(RPC_REQUEST_TIMEOUT_MS, remaining()))
      await rpc.request('events.subscribe', { afterSeq: 0 }, Math.min(RPC_REQUEST_TIMEOUT_MS, remaining()))
      const health = await rpc.request('core.health', undefined, Math.min(RPC_REQUEST_TIMEOUT_MS, remaining()))
      if (previousPid && health.pid === previousPid) {
        rpc.close()
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      checkpoint(`connected to Core process ${health.pid}`)
      return { rpc, health }
    } catch (error) {
      lastError = error
      rpc.close(error instanceof Error ? error : new Error(String(error)))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const timeout = new Error(`Timed out after ${timeoutMs} ms waiting for ${socketPath}`)
  if (lastError instanceof Error) timeout.cause = lastError
  throw timeout
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
  return runCommand('systemctl', ['--user', ...args])
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

async function runVerification() {
  checkpoint('starting preflight checks')
  invariant(process.platform === 'linux', 'The systemd Core verification only runs on Linux.')
  invariant(executable, 'Pass the installed Agent Console executable as the first argument.')
  invariant(runtimeRoot && path.isAbsolute(runtimeRoot), 'XDG_RUNTIME_DIR must be an absolute user runtime directory.')
  await Promise.all([fs.access(executable), runCommand('tmux', ['-V']), systemctl('show-environment')])
  invariant(!await fs.stat(socketPath).then(() => true, () => false), `Refusing to replace an existing Core socket: ${socketPath}`)
  invariant(!await fs.stat(unitPath).then(() => true, () => false), `Refusing to replace an existing user service: ${unitPath}`)

  checkpoint('writing and validating the isolated user service')
  await writeFixtureState()
  await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 })
  await fs.writeFile(unitPath, renderCoreServiceUnit(executable, userData), { mode: 0o600, flag: 'wx' })
  unitCreated = true
  await verifySystemdUnit(unitPath)
  await systemctl('daemon-reload')
  await systemctl('enable', '--now', serviceName)

  checkpoint('verifying the first systemd-managed Core')
  const active = (await systemctl('is-active', serviceName)).stdout.trim()
  invariant(active === 'active', `User service is not active: ${active}`)
  const first = await connectToCore()
  invariant(first.health.appVersion === packageJson.version, `systemd Core reports ${first.health.appVersion}`)
  invariant(first.health.transport === 'unix' && first.health.tcpListening === false, 'systemd Core reports an unsafe transport')
  invariant((await listeningTcpSocketsOwnedBy(first.health.pid)).length === 0, 'systemd Core opened a TCP listener')
  const environment = (await fs.readFile(`/proc/${first.health.pid}/environ`, 'utf8')).split('\u0000')
  invariant(!environment.some((entry) => entry.startsWith('DISPLAY=') && entry !== 'DISPLAY='), 'systemd Core inherited DISPLAY')
  invariant(!environment.some((entry) => entry.startsWith('WAYLAND_DISPLAY=') && entry !== 'WAYLAND_DISPLAY='), 'systemd Core inherited WAYLAND_DISPLAY')

  checkpoint('creating the real tmux fixture through Core')
  tmuxTouched = true
  const prepared = await first.rpc.request('terminal.open', { agentId: 'systemd-agent' }, 15_000)
  invariant(prepared.preparation?.ok === true, `Core could not create the tmux fixture: ${JSON.stringify(prepared)}`)
  await runCommand('tmux', ['has-session', '-t', tmuxSession])
  first.rpc.close()

  checkpoint('restarting the real user service')
  await systemctl('restart', serviceName)
  const second = await connectToCore(first.health.pid)
  invariant(second.health.pid !== first.health.pid, 'systemd restart did not replace the Core process')
  await runCommand('tmux', ['has-session', '-t', tmuxSession])
  const bootstrap = await second.rpc.request('core.bootstrap')
  invariant(bootstrap.state.projects[0].name === 'Systemd Verification', 'systemd restart did not preserve state')
  invariant((await listeningTcpSocketsOwnedBy(second.health.pid)).length === 0, 'restarted systemd Core opened a TCP listener')
  second.rpc.close()

  checkpoint('verification completed successfully')
  console.log(`Verified Agent Console v${packageJson.version} with a real systemd --user start/restart and surviving tmux session.`)
}

function cleanupError(step, error) {
  const wrapped = new Error(`${step}: ${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof Error) wrapped.cause = error
  return wrapped
}

async function attemptCleanup(step, action, failures) {
  checkpoint(step)
  try {
    await action()
    return true
  } catch (error) {
    failures.push(cleanupError(step, error))
    return false
  }
}

async function serviceIsStopped() {
  const { stdout } = await systemctl('show', serviceName, '--property=ActiveState', '--property=LoadState')
  const properties = Object.fromEntries(stdout.trim().split('\n').map((line) => line.split('=', 2)))
  return properties.LoadState === 'not-found'
    || properties.ActiveState === 'inactive'
    || properties.ActiveState === 'failed'
}

async function cleanup() {
  const failures = []
  checkpoint('starting bounded cleanup')
  for (const rpc of [...openRpcClients]) rpc.close(new Error('Systemd verification cleanup closed the Core connection'))

  let stopped = !unitCreated
  let unitRemoved = !unitCreated
  if (unitCreated) {
    const stopSucceeded = await attemptCleanup('stopping the isolated user service', () => systemctl('stop', serviceName), failures)
    const stateKnown = await attemptCleanup('confirming the isolated user service stopped', async () => {
      stopped = await serviceIsStopped()
      invariant(stopped, `Refusing cleanup while ${serviceName} is still active`)
    }, failures)
    if (!stopSucceeded && stateKnown && stopped) {
      checkpoint('the stop command failed but the isolated service is confirmed inactive')
    }
    await attemptCleanup('disabling the isolated user service', () => systemctl('disable', serviceName), failures)
  }

  if (tmuxTouched) {
    await attemptCleanup('removing the isolated tmux session', async () => {
      try {
        await runCommand('tmux', ['has-session', '-t', tmuxSession])
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 1) return
        throw error
      }
      await runCommand('tmux', ['kill-session', '-t', tmuxSession])
    }, failures)
  }

  if (unitCreated && stopped) {
    await attemptCleanup('clearing the isolated service failure state', () => systemctl('reset-failed', serviceName), failures)
    unitRemoved = await attemptCleanup('removing the isolated unit file', () => fs.rm(unitPath, { force: true }), failures)
    await attemptCleanup('reloading the user service manager', () => systemctl('daemon-reload'), failures)
  } else if (unitCreated) {
    failures.push(new Error(`Preserved ${unitPath} and ${fixtureRoot} because the isolated service was not confirmed stopped.`))
  }

  if (stopped && unitRemoved) {
    await attemptCleanup('removing the isolated fixture directory', () => fs.rm(fixtureRoot, { recursive: true, force: true }), failures)
  } else if (stopped && !unitRemoved) {
    failures.push(new Error(`Preserved ${fixtureRoot} because the isolated unit file could not be removed.`))
  }
  checkpoint(`bounded cleanup completed with ${failures.length} failure(s)`)
  return failures
}

let mainFailure = null
try {
  await runVerification()
} catch (error) {
  mainFailure = error instanceof Error ? error : new Error(String(error))
  checkpoint(`verification failed: ${mainFailure.message}`)
}

let cleanupFailures
try {
  cleanupFailures = await cleanup()
} catch (error) {
  cleanupFailures = [cleanupError('unexpected cleanup failure', error)]
}
if (mainFailure && cleanupFailures.length) {
  throw new AggregateError(
    [mainFailure, ...cleanupFailures],
    `Systemd verification failed and cleanup reported ${cleanupFailures.length} additional error(s).`,
    { cause: mainFailure },
  )
}
if (mainFailure) throw mainFailure
if (cleanupFailures.length) {
  throw new AggregateError(cleanupFailures, `Systemd verification cleanup reported ${cleanupFailures.length} error(s).`)
}
