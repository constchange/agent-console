import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { filesAreByteIdentical, sha256File } from './create-deb-x86_64-alias.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const root = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const releaseDirectory = path.resolve(root, process.argv[2] || 'release')
const installedExecutable = process.argv[3] ? path.resolve(process.argv[3]) : null
const appImage = path.join(releaseDirectory, `Agent-Console-${packageJson.version}-x86_64.AppImage`)
const deb = path.join(releaseDirectory, `Agent-Console-${packageJson.version}-amd64.deb`)
const x8664Deb = path.join(releaseDirectory, `Agent-Console-${packageJson.version}-x86_64.deb`)
const latestLinux = path.join(releaseDirectory, 'latest-linux.yml')
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-package-verification-'))
const { renderCoreServiceUnit } = require(path.join(root, 'dist/electron/core/services/core-service-unit.js'))
const { matchesDetachedCoreIdentity } = require(
  path.join(root, 'dist/electron/electron/services/detached-core-identity.js'),
)
const { CORE_PROTOCOL_VERSION, CORE_RPC_ERROR } = require(
  path.join(root, 'dist/electron/shared/core-protocol.js'),
)

const RPC_CONNECT_TIMEOUT_MS = 5_000
const RPC_REQUEST_TIMEOUT_MS = 15_000
const RPC_FLUSH_TIMEOUT_MS = 20_000
const CORE_LOCK_MAX_BYTES = 4_096
const CORE_LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let processCleanupSafe = true

const legacyState = {
  version: 1,
  projects: [{ id: 'existing', name: 'Existing Project', emoji: '◇', color: '#55a6ff', collapsed: false, order: 0 }],
  agents: [],
  settings: { defaultTerminal: 'auto', scanIntervalMs: 2500, compactMode: true, fontSizePx: 32, theme: 'forest-studio' },
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function checkpoint(message) {
  process.stdout.write(`[packaged-core] ${new Date().toISOString()} ${message}\n`)
}

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function unusedLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  invariant(address && typeof address === 'object', 'Could not reserve an isolated Gateway port')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function remoteRuntimeEnvironment(port, armed = '1') {
  return {
    AGENT_CONSOLE_REMOTE_ARMED: armed,
    AGENT_CONSOLE_SUPABASE_URL: 'https://package-verifier.supabase.co',
    AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'a'.repeat(32)}`,
    AGENT_CONSOLE_PUBLIC_BASE_URL: 'https://remote.package-verifier.invalid',
    AGENT_CONSOLE_GATEWAY_LOCAL_HOST: '127.0.0.1',
    AGENT_CONSOLE_GATEWAY_LOCAL_PORT: String(port),
  }
}

async function waitForHttpStatus(url, expectedStatus, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Remote Gateway exited before ${url} returned ${expectedStatus}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000), redirect: 'error' })
      if (response.status === expectedStatus) return response
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${url} did not return ${expectedStatus}: ${errorMessage(lastError)}`)
}

function invalidSignedHeaders() {
  const emptyBody = Buffer.alloc(0)
  return {
    authorization: 'Bearer header.payload.signature',
    'x-ac-protocol': '1',
    'x-ac-workstation-id': '11111111-1111-4111-8111-111111111111',
    'x-ac-device-id': '22222222-2222-4222-8222-222222222222',
    'x-ac-request-id': randomUUID(),
    'x-ac-timestamp': String(Math.floor(Date.now() / 1_000)),
    'x-ac-nonce': randomBytes(16).toString('base64url'),
    'x-ac-body-sha256': createHash('sha256').update(emptyBody).digest('base64url'),
    'x-ac-signature': 'A'.repeat(86),
  }
}

async function expectRpcError(rpc, method, params, expectedCode) {
  let failure = null
  try {
    await rpc.request(method, params)
  } catch (error) {
    failure = error
  }
  invariant(failure instanceof Error, `${method} unexpectedly crossed the Core channel boundary`)
  invariant(failure.message.startsWith(`${expectedCode}:`), `${method} failed with an unexpected error: ${failure.message}`)
}

async function verifySystemdUnit(unitPath) {
  checkpoint('verifying generated systemd user unit')
  const { stdout, stderr } = await execFileAsync('systemd-analyze', ['verify', unitPath], {
    maxBuffer: 4_000_000,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
  invariant(!stdout.trim() && !stderr.trim(), `systemd-analyze reported a unit problem:\n${stdout}${stderr}`)
  checkpoint('generated systemd user unit passed verification')
}

async function findFile(directory, filename) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) return candidate
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename)
      if (nested) return nested
    }
  }
  return null
}

function assertAsarContents(archivePath, packageKind) {
  const entries = new Set(asar.listPackage(archivePath).map((entry) => entry.replace(/^\//, '')))
  for (const required of [
    'LICENSE',
    'dist/electron/electron/main.js',
    'dist/electron/core/console-core.js',
    'dist/electron/core/services/core-service-unit.js',
    'dist/electron/core/services/remote-service-unit.js',
    'dist/electron/core/services/instance-lock.js',
    'dist/electron/core/services/task-ledger.js',
    'dist/electron/core/transport/local-server.js',
    'dist/electron/electron/services/core-client.js',
    'dist/electron/electron/services/remote-gateway-runtime.js',
    'dist/electron/electron/services/remote-service-manager.js',
    'dist/electron/gateway/core-client.js',
    'dist/electron/gateway/http-server.js',
    'dist/electron/shared/core-protocol.js',
    'dist/electron/shared/remote-validation.js',
    'dist/renderer/index.html',
  ]) {
    invariant(entries.has(required), `${packageKind} is missing ${required}`)
  }
  const indexHtml = asar.extractFile(archivePath, 'dist/renderer/index.html').toString('utf8')
  const license = asar.extractFile(archivePath, 'LICENSE').toString('utf8')
  invariant(license.includes('MIT License') && license.includes('Agent Console contributors'),
    `${packageKind} has an unexpected project LICENSE`)
  invariant(!indexHtml.includes('127.0.0.1:5173'), `${packageKind} kept the development server in its CSP`)
  invariant(indexHtml.includes("connect-src 'self'"), `${packageKind} has an unexpected renderer connect policy`)
}

async function assertRemoteResources(archivePath, packageKind) {
  const remoteRoot = path.join(path.dirname(archivePath), 'remote')
  const required = [
    ['remote.env.example', false],
    ['bin/agent-console-remote', true],
    ['cli/agent-console-remote.mjs', true],
    ['systemd/agent-console-gateway.service.tmpl', false],
    ['systemd/agent-console-tunnel.service.tmpl', false],
    ['vps/caddy/agent-console.caddy.tmpl', false],
    ['vps/nginx/agent-console.conf.tmpl', false],
    ['vps/install.sh', true],
    ['vps/uninstall.sh', true],
  ]
  for (const [relative, executable] of required) {
    const target = path.join(remoteRoot, ...relative.split('/'))
    const stat = await fs.lstat(target).catch(() => null)
    invariant(stat?.isFile() && !stat.isSymbolicLink(), `${packageKind} is missing safe Remote resource ${relative}`)
    if (executable) invariant((stat.mode & 0o111) !== 0, `${packageKind} Remote resource ${relative} is not executable`)
  }
  const packagedFiles = []
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const target = path.join(directory, entry.name)
      invariant(!entry.isSymbolicLink(), `${packageKind} Remote resources contain a link: ${relative}`)
      if (entry.isDirectory()) await walk(target, relative)
      else packagedFiles.push(relative)
    }
  }
  await walk(remoteRoot)
  for (const relative of packagedFiles) {
    const base = path.basename(relative)
    invariant(relative !== 'remote.env', `${packageKind} accidentally contains a configured remote.env`)
    invariant(!/^id_/u.test(base) && base !== 'known_hosts' && !/\.(?:pem|key)$/iu.test(base), `${packageKind} accidentally contains SSH/TLS key material: ${relative}`)
  }
  const example = await fs.readFile(path.join(remoteRoot, 'remote.env.example'), 'utf8')
  invariant(example.includes('AGENT_CONSOLE_REMOTE_ARMED=0'), `${packageKind} Remote example is not fail-closed`)
  invariant(example.includes('REPLACE_ME'), `${packageKind} Remote example unexpectedly looks configured`)
  const cli = path.join(remoteRoot, 'cli', 'agent-console-remote.mjs')
  const help = await execFileAsync(process.execPath, [cli, 'help'], { timeout: 10_000, maxBuffer: 1_000_000 })
  invariant(help.stdout.includes('validate') && help.stdout.includes('doctor'), `${packageKind} Remote CLI did not start`)
  const [gatewayTemplate, tunnelTemplate, nginxTemplate, installer, uninstaller] = await Promise.all([
    fs.readFile(path.join(remoteRoot, 'systemd', 'agent-console-gateway.service.tmpl'), 'utf8'),
    fs.readFile(path.join(remoteRoot, 'systemd', 'agent-console-tunnel.service.tmpl'), 'utf8'),
    fs.readFile(path.join(remoteRoot, 'vps', 'nginx', 'agent-console.conf.tmpl'), 'utf8'),
    fs.readFile(path.join(remoteRoot, 'vps', 'install.sh'), 'utf8'),
    fs.readFile(path.join(remoteRoot, 'vps', 'uninstall.sh'), 'utf8'),
  ])
  invariant(gatewayTemplate.includes('--disable-gpu --ozone-platform=headless --remote-gateway'), `${packageKind} Gateway template is not headless`)
  invariant(tunnelTemplate.includes('BindReadOnlyPaths=@@REMOTE_ENV_FILE@@'), `${packageKind} Tunnel template hides remote.env from tunnel-run`)
  invariant(tunnelTemplate.includes('BindReadOnlyPaths=@@SSH_PUBLIC_KEY_PATH@@'), `${packageKind} Tunnel template hides the SSH public key`)
  invariant(nginxTemplate.includes('limit_req_zone $binary_remote_addr')
    && nginxTemplate.includes('limit_conn_zone $binary_remote_addr')
    && nginxTemplate.includes('proxy_request_buffering on;'), `${packageKind} Nginx template lacks source-IP/slow-body edge controls`)
  invariant(nginxTemplate.includes('location ~ ^/v1/events(?:/stream)?$') && nginxTemplate.includes('proxy_read_timeout 330s'), `${packageKind} Nginx template lacks the long-lived SSE policy`)
  invariant(installer.includes('trap finish 0') && installer.includes('snapshot_path "$caddy_main" caddy-main'), `${packageKind} VPS installer is not transactional`)
  invariant(uninstaller.includes('trap finish 0') && uninstaller.includes('snapshot_path "$deployment_file" metadata'), `${packageKind} VPS uninstaller is not transactional`)
  for (const script of [
    path.join(remoteRoot, 'bin', 'agent-console-remote'),
    path.join(remoteRoot, 'vps', 'install.sh'),
    path.join(remoteRoot, 'vps', 'uninstall.sh'),
  ]) await execFileAsync('sh', ['-n', script], { timeout: 10_000, maxBuffer: 1_000_000 })
}

async function verifyInstalledRemoteCommand() {
  const resolved = await execFileAsync('/bin/sh', ['-c', 'command -v agent-console-remote'], {
    timeout: 10_000,
    maxBuffer: 1_000_000,
  })
  const commandPath = resolved.stdout.trim()
  invariant(path.isAbsolute(commandPath), 'Installed deb did not expose agent-console-remote on PATH')
  const commandStat = await fs.lstat(commandPath)
  invariant(commandStat.isSymbolicLink(), 'Installed agent-console-remote command is not a package-managed link')
  const executablePath = await fs.realpath(commandPath)
  const executableStat = await fs.lstat(executablePath)
  invariant(executableStat.isFile() && !executableStat.isSymbolicLink() && (executableStat.mode & 0o111) !== 0, 'Installed Remote launcher is not one executable regular file')
  const ownership = await execFileAsync('dpkg-query', ['-S', executablePath], { timeout: 10_000, maxBuffer: 1_000_000 })
  invariant(ownership.stdout.includes(':'), 'Installed Remote launcher is not owned by a deb package')
  const help = await execFileAsync(commandPath, ['help'], { timeout: 15_000, maxBuffer: 1_000_000 })
  invariant(help.stdout.includes('Remote deployment helper'), 'Installed Remote launcher could not run its packaged CLI')
}

async function assertDebMaintainerScripts(controlDirectory) {
  const [postInstall, postRemove] = await Promise.all([
    fs.readFile(path.join(controlDirectory, 'postinst'), 'utf8'),
    fs.readFile(path.join(controlDirectory, 'postrm'), 'utf8'),
  ])
  invariant(postInstall.includes("update-alternatives --install \"$REMOTE_COMMAND\" 'agent-console-remote' \"$REMOTE_TARGET\" 100"), 'deb postinst does not register agent-console-remote')
  invariant(postInstall.includes('Refusing to replace unrelated $REMOTE_COMMAND'), 'deb postinst can overwrite an unrelated Remote command')
  invariant(postRemove.includes("update-alternatives --remove 'agent-console-remote' \"$REMOTE_TARGET\""), 'deb postrm does not remove the Remote alternative')
}

async function waitForSocket(socketPath, child, timeoutMs = 15_000, childFailure = () => null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const spawnError = childFailure()
    if (spawnError) throw new Error(`Packaged process failed to launch: ${errorMessage(spawnError)}`)
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged process exited early with code ${String(child.exitCode)} and signal ${String(child.signalCode)}`)
    }
    const isSocket = await fs.stat(socketPath).then((stat) => stat.isSocket(), () => false)
    if (isSocket) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Packaged Core did not create ${socketPath}`)
}

function createRpcClient(socketPath, connectTimeoutMs = RPC_CONNECT_TIMEOUT_MS) {
  const socket = net.createConnection({ path: socketPath })
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  let connectSettled = false
  let resolveConnected
  let rejectConnected
  const connected = new Promise((resolve, reject) => {
    resolveConnected = resolve
    rejectConnected = reject
  })
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  const settleConnectFailure = (error) => {
    if (connectSettled) return
    connectSettled = true
    clearTimeout(connectTimer)
    rejectConnected(error)
  }
  const fail = (error, destroySocket = true) => {
    settleConnectFailure(error)
    rejectPending(error)
    if (destroySocket && !socket.destroyed) socket.destroy()
  }
  const connectTimer = setTimeout(() => {
    fail(new Error(`Timed out connecting to packaged Core socket after ${connectTimeoutMs} ms`))
  }, connectTimeoutMs)

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer, 'utf8') > 4 * 1024 * 1024) {
      fail(new Error('Packaged Core response exceeded the verifier buffer limit'))
      return
    }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        fail(new Error(`Packaged Core returned invalid JSON: ${errorMessage(error)}`))
        return
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        fail(new Error('Packaged Core returned a non-object JSON-RPC message'))
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
  socket.on('close', () => {
    fail(new Error('Packaged Core socket closed'), false)
  })
  socket.on('error', (error) => {
    fail(new Error(`Packaged Core socket error: ${errorMessage(error)}`))
  })
  socket.once('connect', () => {
    if (connectSettled) return
    connectSettled = true
    clearTimeout(connectTimer)
    resolveConnected()
  })
  return {
    socket,
    connected,
    request(method, params, timeoutMs = RPC_REQUEST_TIMEOUT_MS) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        if (socket.destroyed) {
          reject(new Error(`Cannot send ${method}; the packaged Core socket is closed`))
          return
        }
        const timer = setTimeout(() => {
          fail(new Error(`Packaged Core request ${method} timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        const encoded = `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`
        try {
          socket.write(encoded, (error) => {
            if (error) fail(new Error(`Could not write packaged Core request ${method}: ${errorMessage(error)}`))
          })
        } catch (error) {
          fail(new Error(`Could not write packaged Core request ${method}: ${errorMessage(error)}`))
        }
      })
    },
    destroy() {
      fail(new Error('Packaged Core verifier closed the socket'))
    },
  }
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

function ipv4LoopbackEndpoint(port) {
  return `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`
}

function processStartTime(rawStat) {
  const commandEnd = rawStat.lastIndexOf(')')
  if (commandEnd < 0) return null
  const value = rawStat.slice(commandEnd + 2).trim().split(/\s+/)[19]
  return value && /^\d+$/.test(value) ? value : null
}

async function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return { status: 'uncertain' }
  let initialDirectory
  let initialRawStat
  try {
    ;[initialDirectory, initialRawStat] = await Promise.all([
      fs.stat(`/proc/${pid}`),
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
  } catch (error) {
    return errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH'
      ? { status: 'absent' }
      : { status: 'uncertain' }
  }
  const initialStartTime = processStartTime(initialRawStat)
  if (!initialDirectory.isDirectory() || !initialStartTime) return { status: 'uncertain' }

  let finalDirectory
  let finalRawStat
  try {
    ;[finalDirectory, finalRawStat] = await Promise.all([
      fs.stat(`/proc/${pid}`),
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
  } catch (error) {
    return errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH'
      ? { status: 'absent' }
      : { status: 'uncertain' }
  }
  const finalStartTime = processStartTime(finalRawStat)
  if (
    !finalDirectory.isDirectory()
    || !finalStartTime
    || finalStartTime !== initialStartTime
    || finalDirectory.uid !== initialDirectory.uid
  ) return { status: 'uncertain' }
  return { status: 'snapshot', identity: { pid, uid: finalDirectory.uid, startTime: finalStartTime } }
}

async function processSnapshot(pid) {
  const probe = await probeProcess(pid)
  return probe.status === 'snapshot' ? probe.identity : null
}

async function captureProcessIdentity(pid) {
  const identity = await processSnapshot(pid)
  if (!identity) return null
  if (typeof process.getuid === 'function' && identity.uid !== process.getuid()) return null
  return identity
}

async function processIdentityStatus(identity) {
  if (!identity) return 'gone'
  const probe = await probeProcess(identity.pid)
  if (probe.status === 'uncertain') return 'uncertain'
  if (probe.status === 'absent') return 'gone'
  return probe.identity.uid === identity.uid && probe.identity.startTime === identity.startTime
    ? 'match'
    : 'gone'
}

async function matchesProcessIdentity(identity) {
  const status = await processIdentityStatus(identity)
  if (status === 'uncertain') {
    throw new Error(`Process ${identity.pid} identity could not be verified from /proc`)
  }
  return status === 'match'
}

async function waitForExit(identity, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await processIdentityStatus(identity)
    if (status === 'gone') return true
    if (status === 'uncertain') {
      throw new Error(`${label} process ${identity.pid} identity became uncertain while waiting for exit`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const finalStatus = await processIdentityStatus(identity)
  if (finalStatus === 'uncertain') {
    throw new Error(`${label} process ${identity.pid} identity could not be verified after ${timeoutMs} ms`)
  }
  return finalStatus === 'gone'
}

async function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    timer.unref()
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function seedLegacyState(userData) {
  await fs.mkdir(userData, { recursive: true, mode: 0o700 })
  await fs.writeFile(
    path.join(userData, 'mission-control-state.json'),
    `${JSON.stringify(legacyState, null, 2)}\n`,
    { mode: 0o600 },
  )
}

async function signalProcess(identity, signal) {
  const status = await processIdentityStatus(identity)
  if (status === 'gone') return false
  if (status === 'uncertain') {
    throw new Error(`Refusing to send ${signal} because process ${identity.pid} identity is uncertain`)
  }
  try {
    process.kill(identity.pid, signal)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    throw error
  }
}

async function stopProcess(identity, label, gracefulTimeoutMs = 10_000) {
  if (!identity) return
  const initialStatus = await processIdentityStatus(identity)
  if (initialStatus === 'gone') return
  if (initialStatus === 'uncertain') {
    throw new Error(`Refusing to stop ${label} because process ${identity.pid} identity is uncertain`)
  }
  checkpoint(`stopping ${label} process ${identity.pid}`)
  if (!await signalProcess(identity, 'SIGTERM')) return
  if (await waitForExit(identity, label, gracefulTimeoutMs)) return
  checkpoint(`force-killing ${label} process ${identity.pid}`)
  if (!await signalProcess(identity, 'SIGKILL')) return
  if (!await waitForExit(identity, label, 3_000)) {
    throw new Error(`${label} process ${identity.pid} retained the same UID and start time after SIGKILL`)
  }
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino
}

function isPrivateUserDataDirectory(directoryStat) {
  return directoryStat.isDirectory()
    && !directoryStat.isSymbolicLink()
    && (typeof process.getuid !== 'function' || directoryStat.uid === process.getuid())
    && (directoryStat.mode & 0o077) === 0
}

function isPrivateCoreLock(lockStat) {
  return lockStat.isFile()
    && !lockStat.isSymbolicLink()
    && lockStat.nlink === 1
    && (typeof process.getuid !== 'function' || lockStat.uid === process.getuid())
    && (lockStat.mode & 0o077) === 0
    && lockStat.size > 0
    && lockStat.size <= CORE_LOCK_MAX_BYTES
}

function parseCoreLock(raw) {
  try {
    const record = JSON.parse(raw)
    if (!Number.isInteger(record?.pid) || record.pid <= 1) return null
    if (typeof record.token !== 'string' || !CORE_LOCK_TOKEN_PATTERN.test(record.token)) return null
    if (typeof record.processStartTime !== 'string' || !/^\d+$/.test(record.processStartTime)) return null
    return {
      pid: record.pid,
      token: record.token,
      processStartTime: record.processStartTime,
    }
  } catch {
    return null
  }
}

async function readStableCoreLock(userData) {
  const lockPath = path.join(userData, 'console-core.lock')
  const firstRoot = await fs.lstat(userData)
  const finalRoot = await fs.lstat(userData)
  if (
    !isPrivateUserDataDirectory(firstRoot)
    || !isPrivateUserDataDirectory(finalRoot)
    || !sameFileIdentity(firstRoot, finalRoot)
  ) throw new Error('The isolated Core user-data directory is not one stable private directory')

  let firstPathStat
  try {
    firstPathStat = await fs.lstat(lockPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  let handle = null
  try {
    if (!isPrivateCoreLock(firstPathStat)) throw new Error('The isolated Core lock is not one private regular file')
    handle = await fs.open(lockPath, 'r')
    const firstHandleStat = await handle.stat()
    if (!isPrivateCoreLock(firstHandleStat) || !sameFileIdentity(firstPathStat, firstHandleStat)) {
      throw new Error('The isolated Core lock changed before it could be opened safely')
    }
    const raw = await handle.readFile('utf8')
    const [finalHandleStat, finalPathStat] = await Promise.all([handle.stat(), fs.lstat(lockPath)])
    if (
      !isPrivateCoreLock(finalHandleStat)
      || !isPrivateCoreLock(finalPathStat)
      || !sameFileIdentity(firstHandleStat, finalHandleStat)
      || !sameFileIdentity(finalHandleStat, finalPathStat)
      || finalHandleStat.size !== firstHandleStat.size
      || finalHandleStat.mtimeMs !== firstHandleStat.mtimeMs
      || finalHandleStat.ctimeMs !== firstHandleStat.ctimeMs
    ) throw new Error('The isolated Core lock changed while it was being read')
    const record = parseCoreLock(raw)
    if (!record) throw new Error('The isolated Core lock record is invalid')
    return {
      ...record,
      device: finalHandleStat.dev,
      inode: finalHandleStat.ino,
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function sameCoreLockAnchor(first, second) {
  return first.device === second.device
    && first.inode === second.inode
    && first.pid === second.pid
    && first.token === second.token
    && first.processStartTime === second.processStartTime
}

async function verifiedCoreIdentityFromLock(userData, expectedPid = null) {
  const record = await readStableCoreLock(userData)
  if (!record) return null
  if (expectedPid !== null && record.pid !== expectedPid) {
    throw new Error(`The isolated Core lock PID ${record.pid} does not match reported Core PID ${expectedPid}`)
  }
  if (!await matchesDetachedCoreIdentity(userData, record.pid)) {
    throw new Error(`The isolated Core lock could not verify process ${record.pid}`)
  }
  const identity = await captureProcessIdentity(record.pid)
  if (!identity || !await matchesDetachedCoreIdentity(userData, record.pid)) {
    throw new Error(`The isolated Core process ${record.pid} changed while its identity was being captured`)
  }
  const finalRecord = await readStableCoreLock(userData)
  if (!finalRecord || !sameCoreLockAnchor(record, finalRecord)) {
    throw new Error(`The isolated Core lock changed while process ${record.pid} was being anchored`)
  }
  return { identity, lock: finalRecord }
}

function destroyChildPipes(child) {
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
}

async function cleanupFixtureProcesses(label, child, childIdentity, userData, coreLockAnchor, candidates) {
  const failures = []
  let lockedCore = null
  try {
    lockedCore = await verifiedCoreIdentityFromLock(userData)
    if (lockedCore && coreLockAnchor && !sameCoreLockAnchor(coreLockAnchor, lockedCore.lock)) {
      throw new Error('The isolated Core lock changed identity before process cleanup')
    }
  } catch (error) {
    failures.push(error)
  }
  const processes = []
  const identityKeys = new Set()
  for (const candidate of [
    ...candidates,
    ...(lockedCore ? [{ identity: lockedCore.identity, label: `${label} Core`, gracefulTimeoutMs: 10_000 }] : []),
  ]) {
    if (!candidate?.identity) continue
    const { identity } = candidate
    const key = `${identity.pid}:${identity.uid}:${identity.startTime}`
    if (identityKeys.has(key)) continue
    identityKeys.add(key)
    processes.push(candidate)
  }
  try {
    for (const candidate of processes) {
      try {
        await stopProcess(candidate.identity, candidate.label, candidate.gracefulTimeoutMs)
      } catch (error) {
        failures.push(error)
      }
    }
    if (child.pid && !childIdentity && child.exitCode === null && child.signalCode === null) {
      failures.push(new Error(`${label} wrapper started without a safely captured process identity`))
    }
  } finally {
    // A killed wrapper can leave an inherited pipe open in an orphan helper.
    // The verifier must not retain those read handles after process cleanup.
    destroyChildPipes(child)
    child.unref()
  }

  for (const candidate of processes) {
    try {
      if (await matchesProcessIdentity(candidate.identity)) {
        failures.push(new Error(
          `${candidate.label} process ${candidate.identity.pid} retained its captured UID and start time after cleanup`,
        ))
      }
    } catch (error) {
      failures.push(error)
    }
  }

  try {
    const remainingLock = await readStableCoreLock(userData)
    const trustedAnchor = lockedCore?.lock ?? coreLockAnchor
    if (remainingLock && (!trustedAnchor || !sameCoreLockAnchor(trustedAnchor, remainingLock))) {
      failures.push(new Error('An unverified or changed isolated Core lock remained after process cleanup'))
    }
    if (remainingLock) {
      const remainingProbe = await probeProcess(remainingLock.pid)
      if (remainingProbe.status === 'uncertain') {
        failures.push(new Error('The isolated Core lock process could not be proven absent after cleanup'))
      } else if (
        remainingProbe.status === 'snapshot'
        && remainingProbe.identity.startTime === remainingLock.processStartTime
      ) {
        failures.push(new Error('The isolated Core lock still identifies a live process after cleanup'))
      }
    }
  } catch (error) {
    failures.push(error)
  }

  if (failures.length) {
    processCleanupSafe = false
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(failures, `${label} process cleanup had multiple failures`)
  }
}

function throwVerificationFailures(label, primaryFailure, cleanupFailure) {
  if (primaryFailure && cleanupFailure) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `${label} verification and process cleanup both failed`,
      { cause: primaryFailure },
    )
  }
  if (primaryFailure) throw primaryFailure
  if (cleanupFailure) throw cleanupFailure
}

async function verifyCoreExecutable(executable, label, fixtureName, extraEnvironment = {}) {
  checkpoint(`${label}: preparing isolated headless Core fixture`)
  const fixtureRoot = path.join(temporaryDirectory, fixtureName)
  const userData = path.join(fixtureRoot, 'user-data')
  const runtimeRoot = path.join(fixtureRoot, 'runtime')
  const gatewayPort = await unusedLoopbackPort()
  const disarmedGatewayPort = await unusedLoopbackPort()
  await seedLegacyState(userData)
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 })

  const coreEnvironment = {
    ...process.env,
    ...extraEnvironment,
    ...remoteRuntimeEnvironment(gatewayPort),
    XDG_RUNTIME_DIR: runtimeRoot,
  }
  delete coreEnvironment.DISPLAY
  delete coreEnvironment.WAYLAND_DISPLAY
  const child = spawn(executable, [
    '--console-core',
    `--console-core-user-data=${userData}`,
    '--no-sandbox',
    '--disable-gpu',
    '--ozone-platform=headless',
  ], {
    env: coreEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  let childFailure = null
  child.on('error', (error) => { childFailure = error })
  child.stdout?.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })
  child.stderr?.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })

  let childIdentity = null
  let coreIdentity = null
  let coreLockAnchor = null
  let rpc = null
  let gatewayRpc = null
  let gatewayChild = null
  let gatewayIdentity = null
  let disarmedGatewayChild = null
  let disarmedGatewayIdentity = null
  let primaryFailure = null
  try {
    childIdentity = await captureProcessIdentity(child.pid)
    invariant(
      childIdentity,
      childFailure
        ? `${label} wrapper failed to launch: ${errorMessage(childFailure)}`
        : `${label} wrapper process identity could not be captured after launch`,
    )
    const desktopSocketPath = path.join(runtimeRoot, 'agent-console', 'desktop', 'core.sock')
    const gatewaySocketPath = path.join(runtimeRoot, 'agent-console', 'gateway', 'core.sock')
    checkpoint(`${label}: waiting for desktop and Gateway Core sockets`)
    await waitForSocket(desktopSocketPath, child, 15_000, () => childFailure)
    await waitForSocket(gatewaySocketPath, child, 15_000, () => childFailure)
    rpc = createRpcClient(desktopSocketPath)
    await rpc.connected
    await rpc.request('initialize', {
      protocolVersion: CORE_PROTOCOL_VERSION,
      expectedChannel: 'desktop',
      client: { name: `package-verifier-${fixtureName}`, version: packageJson.version },
    })
    await rpc.request('events.subscribe', { afterSeq: 0 })
    const health = await rpc.request('core.health')
    const bootstrap = await rpc.request('core.bootstrap')
    await expectRpcError(rpc, 'remote.health', undefined, CORE_RPC_ERROR.METHOD_NOT_FOUND)
    gatewayRpc = createRpcClient(gatewaySocketPath)
    await gatewayRpc.connected
    const gatewayInitialize = await gatewayRpc.request('initialize', {
      protocolVersion: CORE_PROTOCOL_VERSION,
      expectedChannel: 'gateway',
      client: { name: `package-gateway-verifier-${fixtureName}`, version: packageJson.version },
    })
    invariant(gatewayInitialize.channel === 'gateway', `${label} Gateway initialized on the wrong channel`)
    invariant(gatewayInitialize.capabilities?.events === false, `${label} Gateway unexpectedly advertised raw Core events`)
    await expectRpcError(gatewayRpc, 'events.subscribe', { afterSeq: 0 }, CORE_RPC_ERROR.METHOD_NOT_FOUND)
    const remoteHealth = await gatewayRpc.request('remote.health')
    invariant(remoteHealth.online === true, `${label} Gateway health is not online`)
    await expectRpcError(gatewayRpc, 'config.get', undefined, CORE_RPC_ERROR.METHOD_NOT_FOUND)
    const verifiedCore = await verifiedCoreIdentityFromLock(userData, health.pid)
    invariant(verifiedCore, `${label} Core lock did not identify its reported process`)
    coreIdentity = verifiedCore.identity
    coreLockAnchor = verifiedCore.lock
    invariant(health.appVersion === packageJson.version, `${label} Core reports unexpected version ${health.appVersion}`)
    invariant(health.transport === 'unix' && health.tcpListening === false, `${label} Core reports an unsafe transport`)
    invariant(bootstrap.state.projects[0].name === 'Existing Project', `${label} Core did not preserve the existing state`)
    invariant(bootstrap.state.settings.theme === 'forest-studio', `${label} Core did not preserve the existing theme`)
    invariant((await listeningTcpSocketsOwnedBy(coreIdentity.pid)).length === 0, `${label} Core opened a listening TCP socket`)

    const gatewayHome = path.join(fixtureRoot, 'gateway-home')
    const gatewayConfig = path.join(fixtureRoot, 'gateway-config')
    const gatewayCache = path.join(fixtureRoot, 'gateway-cache')
    await Promise.all([
      fs.mkdir(gatewayHome, { recursive: true, mode: 0o700 }),
      fs.mkdir(gatewayConfig, { recursive: true, mode: 0o700 }),
      fs.mkdir(gatewayCache, { recursive: true, mode: 0o700 }),
    ])
    checkpoint(`${label}: starting the real packaged localhost Gateway role`)
    gatewayChild = spawn(executable, [
      '--remote-gateway',
      `--remote-gateway-socket=${gatewaySocketPath}`,
      '--no-sandbox',
      '--disable-gpu',
      '--ozone-platform=headless',
    ], {
      env: {
        ...coreEnvironment,
        ...remoteRuntimeEnvironment(gatewayPort),
        HOME: gatewayHome,
        XDG_CONFIG_HOME: gatewayConfig,
        XDG_CACHE_HOME: gatewayCache,
      },
      stdio: 'ignore',
    })
    gatewayIdentity = await captureProcessIdentity(gatewayChild.pid)
    invariant(gatewayIdentity, `${label} packaged Gateway process identity could not be captured`)
    const gatewayHealthUrl = `http://127.0.0.1:${gatewayPort}/healthz`
    const healthy = await waitForHttpStatus(gatewayHealthUrl, 200, gatewayChild)
    invariant((await healthy.json()).ok === true, `${label} packaged Gateway returned an invalid health body`)
    const gatewayListeners = await listeningTcpSocketsOwnedBy(gatewayIdentity.pid)
    invariant(
      gatewayListeners.length === 1 && gatewayListeners[0] === ipv4LoopbackEndpoint(gatewayPort),
      `${label} packaged Gateway listeners were not exactly IPv4 loopback: ${gatewayListeners.join(', ')}`,
    )
    const denied = await fetch(`http://127.0.0.1:${gatewayPort}/v1/dashboard`, {
      headers: invalidSignedHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    const deniedBody = await denied.json()
    invariant(
      denied.status === 403 && deniedBody?.error?.code === 'REMOTE_DISABLED',
      `${label} packaged Gateway did not fail an unauthenticated signed candidate safely`,
    )
    const malformedSignature = await fetch(`http://127.0.0.1:${gatewayPort}/v1/dashboard`, {
      headers: { ...invalidSignedHeaders(), 'x-ac-signature': 'not-base64url!' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    const malformedSignatureBody = await malformedSignature.json()
    invariant(
      malformedSignature.status === 400 && malformedSignatureBody?.error?.code === 'INVALID_HEADERS',
      `${label} packaged Gateway did not reject malformed signature metadata at its HTTP boundary`,
    )

    const disarmedHome = path.join(fixtureRoot, 'disarmed-gateway-home')
    const disarmedConfig = path.join(fixtureRoot, 'disarmed-gateway-config')
    const disarmedCache = path.join(fixtureRoot, 'disarmed-gateway-cache')
    await Promise.all([
      fs.mkdir(disarmedHome, { recursive: true, mode: 0o700 }),
      fs.mkdir(disarmedConfig, { recursive: true, mode: 0o700 }),
      fs.mkdir(disarmedCache, { recursive: true, mode: 0o700 }),
    ])
    disarmedGatewayChild = spawn(executable, [
      '--remote-gateway',
      `--remote-gateway-socket=${gatewaySocketPath}`,
      '--no-sandbox',
      '--disable-gpu',
      '--ozone-platform=headless',
    ], {
      env: {
        ...coreEnvironment,
        ...remoteRuntimeEnvironment(disarmedGatewayPort, '0'),
        HOME: disarmedHome,
        XDG_CONFIG_HOME: disarmedConfig,
        XDG_CACHE_HOME: disarmedCache,
      },
      stdio: 'ignore',
    })
    disarmedGatewayIdentity = await captureProcessIdentity(disarmedGatewayChild.pid)
    const disarmedExited = await waitForChildExit(disarmedGatewayChild, 10_000)
    invariant(disarmedExited, `${label} disarmed packaged Gateway did not exit`)
    invariant(disarmedGatewayChild.exitCode !== 0, `${label} disarmed packaged Gateway exited successfully`)
    let disarmedListening = false
    try {
      await fetch(`http://127.0.0.1:${disarmedGatewayPort}/healthz`, { signal: AbortSignal.timeout(500) })
      disarmedListening = true
    } catch {
      // Expected: ARMED=0 must fail before creating a listener.
    }
    invariant(!disarmedListening, `${label} disarmed packaged Gateway opened an HTTP listener`)

    await rpc.request('core.flush', undefined, RPC_FLUSH_TIMEOUT_MS)
    await stopProcess(coreIdentity, `${label} Core`, 10_000)
    const unhealthy = await waitForHttpStatus(gatewayHealthUrl, 503, gatewayChild)
    invariant((await unhealthy.json()).ok === false, `${label} Gateway stayed healthy after Core stopped`)
    checkpoint(`${label}: runtime, Gateway, and persistence checks passed`)
  } catch (error) {
    primaryFailure = new Error(`${label}: ${errorMessage(error)}\n${diagnostics}`, { cause: error })
  }
  rpc?.destroy()
  gatewayRpc?.destroy()
  let cleanupFailure = null
  try {
    await cleanupFixtureProcesses(label, child, childIdentity, userData, coreLockAnchor, [
      { identity: childIdentity, label: `${label} wrapper`, gracefulTimeoutMs: 10_000 },
      { identity: coreIdentity, label: `${label} Core`, gracefulTimeoutMs: 10_000 },
      { identity: gatewayIdentity, label: `${label} Remote Gateway`, gracefulTimeoutMs: 10_000 },
      { identity: disarmedGatewayIdentity, label: `${label} disarmed Remote Gateway`, gracefulTimeoutMs: 3_000 },
    ])
  } catch (error) {
    cleanupFailure = error
  } finally {
    gatewayChild?.unref()
    disarmedGatewayChild?.unref()
  }
  throwVerificationFailures(label, primaryFailure, cleanupFailure)

  const preserved = JSON.parse(await fs.readFile(path.join(userData, 'mission-control-state.json'), 'utf8'))
  const legacyCheckpoint = JSON.parse(await fs.readFile(path.join(userData, 'mission-control-state.pre-core-v0.4.json'), 'utf8'))
  invariant(preserved.projects[0].name === 'Existing Project', `${label} Core changed legacy data during startup`)
  invariant(legacyCheckpoint.projects[0].name === 'Existing Project', `${label} Core checkpoint is not the legacy state`)
  invariant(((await fs.stat(path.join(userData, 'console-core.sqlite'))).mode & 0o0777) === 0o600, `${label} task ledger is not mode 0600`)
  invariant(((await fs.stat(path.join(userData, 'electron-core-profile'))).mode & 0o077) === 0, `${label} Core Electron profile is not private`)
  checkpoint(`${label}: headless Core verification complete`)
}

async function verifyDesktopAndPersistentCore() {
  checkpoint('AppImage desktop: preparing persistent Core fixture')
  const fixtureRoot = path.join(temporaryDirectory, 'desktop-appimage')
  const home = path.join(fixtureRoot, 'home')
  const configHome = path.join(fixtureRoot, 'config')
  const dataHome = path.join(fixtureRoot, 'data')
  const runtimeRoot = path.join(fixtureRoot, 'runtime')
  const userData = path.join(configHome, 'agent-console')
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(dataHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
  ])
  await seedLegacyState(userData)

  const desktop = spawn(appImage, ['--no-sandbox', '--disable-gpu'], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_RUNTIME_DIR: runtimeRoot,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(fixtureRoot, 'no-user-bus')}`,
      APPIMAGE_EXTRACT_AND_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  let desktopFailure = null
  desktop.on('error', (error) => { desktopFailure = error })
  desktop.stdout?.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })
  desktop.stderr?.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })

  let desktopIdentity = null
  let coreIdentity = null
  let coreLockAnchor = null
  let rpc = null
  let gatewayRpc = null
  let primaryFailure = null
  try {
    desktopIdentity = await captureProcessIdentity(desktop.pid)
    invariant(
      desktopIdentity,
      desktopFailure
        ? `AppImage desktop failed to launch: ${errorMessage(desktopFailure)}`
        : 'AppImage desktop process identity could not be captured after launch',
    )
    const desktopSocketPath = path.join(runtimeRoot, 'agent-console', 'desktop', 'core.sock')
    const gatewaySocketPath = path.join(runtimeRoot, 'agent-console', 'gateway', 'core.sock')
    checkpoint('AppImage desktop: waiting for persistent desktop and Gateway Core sockets')
    await waitForSocket(desktopSocketPath, desktop, 30_000, () => desktopFailure)
    await waitForSocket(gatewaySocketPath, desktop, 30_000, () => desktopFailure)
    rpc = createRpcClient(desktopSocketPath)
    await rpc.connected
    await rpc.request('initialize', {
      protocolVersion: CORE_PROTOCOL_VERSION,
      expectedChannel: 'desktop',
      client: { name: 'desktop-lifecycle-verifier', version: packageJson.version },
    })
    await rpc.request('events.subscribe', { afterSeq: 0 })
    const health = await rpc.request('core.health')
    const bootstrap = await rpc.request('core.bootstrap')
    await expectRpcError(rpc, 'remote.health', undefined, CORE_RPC_ERROR.METHOD_NOT_FOUND)
    gatewayRpc = createRpcClient(gatewaySocketPath)
    await gatewayRpc.connected
    const gatewayInitialize = await gatewayRpc.request('initialize', {
      protocolVersion: CORE_PROTOCOL_VERSION,
      expectedChannel: 'gateway',
      client: { name: 'gateway-lifecycle-verifier', version: packageJson.version },
    })
    invariant(gatewayInitialize.capabilities?.events === false, 'AppImage Gateway unexpectedly advertised raw Core events')
    await expectRpcError(gatewayRpc, 'events.subscribe', { afterSeq: 0 }, CORE_RPC_ERROR.METHOD_NOT_FOUND)
    const remoteHealth = await gatewayRpc.request('remote.health')
    invariant(remoteHealth.online === true, 'AppImage Gateway health is not online')
    await expectRpcError(gatewayRpc, 'config.get', undefined, CORE_RPC_ERROR.METHOD_NOT_FOUND)
    const verifiedCore = await verifiedCoreIdentityFromLock(userData, health.pid)
    invariant(verifiedCore, 'AppImage persistent Core lock did not identify its reported process')
    coreIdentity = verifiedCore.identity
    coreLockAnchor = verifiedCore.lock
    invariant(bootstrap.state.projects[0].name === 'Existing Project', 'AppImage desktop changed the existing state')
    invariant((await listeningTcpSocketsOwnedBy(coreIdentity.pid)).length === 0, 'Desktop-started Core opened a listening TCP socket')

    const stableAppImage = path.join(dataHome, 'agent-console', 'app', 'Agent-Console.AppImage')
    const versionMarker = path.join(dataHome, 'agent-console', 'app', 'version')
    const unitPath = path.join(configHome, 'systemd', 'user', 'agent-console-core.service')
    await Promise.all([fs.access(stableAppImage), fs.access(versionMarker), fs.access(unitPath)])
    invariant((await fs.readFile(versionMarker, 'utf8')).trim() === packageJson.version, 'Stable AppImage version marker is stale')
    invariant((await fs.readFile(unitPath, 'utf8')) === renderCoreServiceUnit(stableAppImage, userData), 'Generated systemd unit is not deterministic')
    await verifySystemdUnit(unitPath)

    await stopProcess(desktopIdentity, 'AppImage desktop', 40_000)
    invariant(coreIdentity.pid !== desktopIdentity.pid, 'Desktop and Core unexpectedly share one process')
    invariant(await matchesProcessIdentity(coreIdentity), 'Persistent Core exited when the AppImage desktop closed')
    const afterDesktopClose = await rpc.request('core.health')
    invariant(afterDesktopClose.pid === coreIdentity.pid, 'Core did not remain available after the desktop closed')
    invariant((await gatewayRpc.request('remote.health')).online === true, 'Gateway socket did not survive desktop shutdown')
    checkpoint('AppImage desktop: persistent Core survived desktop shutdown')
  } catch (error) {
    primaryFailure = new Error(`AppImage desktop/Core lifecycle: ${errorMessage(error)}\n${diagnostics}`, { cause: error })
  }
  rpc?.destroy()
  gatewayRpc?.destroy()
  let cleanupFailure = null
  try {
    await cleanupFixtureProcesses(
      'AppImage desktop/Core',
      desktop,
      desktopIdentity,
      userData,
      coreLockAnchor,
      [
        { identity: desktopIdentity, label: 'AppImage desktop', gracefulTimeoutMs: 40_000 },
        { identity: coreIdentity, label: 'AppImage persistent Core', gracefulTimeoutMs: 10_000 },
      ],
    )
  } catch (error) {
    cleanupFailure = error
  }
  throwVerificationFailures('AppImage desktop/Core lifecycle', primaryFailure, cleanupFailure)
  checkpoint('AppImage desktop: lifecycle verification complete')
}

async function verifyPackages() {
  checkpoint('checking release artifacts')
  await Promise.all([fs.access(appImage), fs.access(deb), fs.access(x8664Deb), fs.access(latestLinux)])
  await fs.chmod(appImage, 0o755)

  const [canonicalDebStat, x8664DebStat, canonicalArchitecture, x8664Architecture, canonicalHash, x8664Hash, updateMetadata] = await Promise.all([
    fs.lstat(deb),
    fs.lstat(x8664Deb),
    execFileAsync('dpkg-deb', ['--field', deb, 'Architecture'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 }),
    execFileAsync('dpkg-deb', ['--field', x8664Deb, 'Architecture'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 }),
    sha256File(deb),
    sha256File(x8664Deb),
    fs.readFile(latestLinux, 'utf8'),
  ])
  invariant(canonicalDebStat.isFile() && !canonicalDebStat.isSymbolicLink(), 'Canonical amd64 deb is not one regular file')
  invariant(x8664DebStat.isFile() && !x8664DebStat.isSymbolicLink(), 'x86_64 deb alias is not one regular file')
  invariant(canonicalArchitecture.stdout.trim() === 'amd64', 'Canonical deb does not use Debian Architecture amd64')
  invariant(x8664Architecture.stdout.trim() === 'amd64', 'x86_64 deb alias does not retain Debian Architecture amd64')
  invariant(canonicalDebStat.size === x8664DebStat.size && canonicalHash === x8664Hash,
    'x86_64 deb alias size or SHA-256 differs from the canonical amd64 deb')
  invariant(await filesAreByteIdentical(deb, x8664Deb), 'x86_64 deb alias is not byte-identical to the canonical amd64 deb')
  const updateArtifactUrls = [...updateMetadata.matchAll(/^\s*-\s+url:\s+([^\r\n]+?)\s*$/gmu)]
    .map((match) => match[1].replace(/^['"]|['"]$/g, ''))
  invariant(updateArtifactUrls.filter((url) => url === path.basename(deb)).length === 1,
    'latest-linux.yml must retain exactly one canonical amd64 deb URL')
  invariant(!updateArtifactUrls.includes(path.basename(x8664Deb)),
    'latest-linux.yml artifact URLs must not contain the manual-download x86_64 deb alias')

  const appImageExtraction = path.join(temporaryDirectory, 'appimage')
  const debExtraction = path.join(temporaryDirectory, 'deb')
  const debControl = path.join(temporaryDirectory, 'deb-control')
  await fs.mkdir(appImageExtraction)
  await fs.mkdir(debExtraction)
  await fs.mkdir(debControl)
  checkpoint('extracting AppImage')
  await execFileAsync(appImage, ['--appimage-extract'], {
    cwd: appImageExtraction,
    maxBuffer: 20_000_000,
    timeout: 120_000,
    killSignal: 'SIGKILL',
  })
  checkpoint('extracting deb')
  await execFileAsync('dpkg-deb', ['--extract', deb, debExtraction], {
    maxBuffer: 20_000_000,
    timeout: 60_000,
    killSignal: 'SIGKILL',
  })
  await execFileAsync('dpkg-deb', ['--control', deb, debControl], {
    maxBuffer: 4_000_000,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
  await assertDebMaintainerScripts(debControl)

  checkpoint('checking packaged archive contents')
  const appImageRoot = path.join(appImageExtraction, 'squashfs-root')
  const appImageAsar = await findFile(appImageRoot, 'app.asar')
  const debAsar = await findFile(debExtraction, 'app.asar')
  invariant(appImageAsar, 'AppImage does not contain app.asar')
  invariant(debAsar, 'deb does not contain app.asar')
  assertAsarContents(appImageAsar, 'AppImage')
  assertAsarContents(debAsar, 'deb')
  await assertRemoteResources(appImageAsar, 'AppImage')
  await assertRemoteResources(debAsar, 'deb')
  checkpoint('packaged archive contents passed verification')

  const appRun = path.join(appImageRoot, 'AppRun')
  await verifyCoreExecutable(appRun, 'AppImage', 'appimage-core')
  await verifyDesktopAndPersistentCore()
  if (installedExecutable) {
    await fs.access(installedExecutable)
    await verifyInstalledRemoteCommand()
    await verifyCoreExecutable(installedExecutable, 'installed deb', 'installed-deb-core')
  }

  console.log(
    `Verified Agent Console v${packageJson.version}: AppImage desktop/Core persistence, stable copy, systemd unit syntax, `
      + `${installedExecutable ? 'installed deb runtime, ' : 'deb contents, '}Remote deployment resources, legacy-state preservation, `
      + 'Unix IPC, a real loopback-only ARMED Gateway with fail-closed health and malformed-signature checks, and zero Core TCP listeners.',
  )
}

let verificationFailure = null
try {
  await verifyPackages()
} catch (error) {
  verificationFailure = error
}

let temporaryCleanupFailure = null
if (processCleanupSafe) {
  try {
    checkpoint('removing isolated package-verification files')
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  } catch (error) {
    temporaryCleanupFailure = error
  }
} else {
  checkpoint(`preserving ${temporaryDirectory} because process cleanup could not be verified`)
  if (!verificationFailure) {
    temporaryCleanupFailure = new Error('Process cleanup was not verified; refusing to remove isolated fixture files')
  }
}

if (verificationFailure && temporaryCleanupFailure) {
  throw new AggregateError(
    [verificationFailure, temporaryCleanupFailure],
    'Package verification failed and its temporary-file cleanup also failed',
    { cause: verificationFailure },
  )
}
if (verificationFailure) throw verificationFailure
if (temporaryCleanupFailure) throw temporaryCleanupFailure
