import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const root = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const releaseDirectory = path.resolve(root, process.argv[2] || 'release')
const installedExecutable = process.argv[3] ? path.resolve(process.argv[3]) : null
const appImage = path.join(releaseDirectory, `Agent-Console-${packageJson.version}-x86_64.AppImage`)
const deb = path.join(releaseDirectory, `Agent-Console-${packageJson.version}-amd64.deb`)
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-package-verification-'))
const { renderCoreServiceUnit } = require(path.join(root, 'dist/electron/core/services/core-service-unit.js'))

const legacyState = {
  version: 1,
  projects: [{ id: 'existing', name: 'Existing Project', emoji: '◇', color: '#55a6ff', collapsed: false, order: 0 }],
  agents: [],
  settings: { defaultTerminal: 'auto', scanIntervalMs: 2500, compactMode: true, fontSizePx: 32, theme: 'forest-studio' },
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

async function verifySystemdUnit(unitPath) {
  const { stdout, stderr } = await execFileAsync('systemd-analyze', ['verify', unitPath], { maxBuffer: 4_000_000 })
  invariant(!stdout.trim() && !stderr.trim(), `systemd-analyze reported a unit problem:\n${stdout}${stderr}`)
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
    'dist/electron/electron/main.js',
    'dist/electron/core/console-core.js',
    'dist/electron/core/services/core-service-unit.js',
    'dist/electron/core/services/instance-lock.js',
    'dist/electron/core/services/task-ledger.js',
    'dist/electron/core/transport/local-server.js',
    'dist/electron/electron/services/core-client.js',
    'dist/renderer/index.html',
  ]) {
    invariant(entries.has(required), `${packageKind} is missing ${required}`)
  }
  const indexHtml = asar.extractFile(archivePath, 'dist/renderer/index.html').toString('utf8')
  invariant(!indexHtml.includes('127.0.0.1:5173'), `${packageKind} kept the development server in its CSP`)
  invariant(indexHtml.includes("connect-src 'self'"), `${packageKind} has an unexpected renderer connect policy`)
}

async function waitForSocket(socketPath, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged Core exited early with code ${child.exitCode}`)
    const isSocket = await fs.stat(socketPath).then((stat) => stat.isSocket(), () => false)
    if (isSocket) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Packaged Core did not create ${socketPath}`)
}

function createRpcClient(socketPath) {
  const socket = net.createConnection({ path: socketPath })
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
      if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else request.resolve(message.result)
    }
  })
  socket.on('close', () => {
    for (const request of pending.values()) request.reject(new Error('Packaged Core socket closed'))
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
        pending.set(id, { resolve, reject })
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
      })
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

async function waitForExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Packaged Core process ${pid} did not stop after SIGTERM`)
}

async function seedLegacyState(userData) {
  await fs.mkdir(userData, { recursive: true, mode: 0o700 })
  await fs.writeFile(
    path.join(userData, 'mission-control-state.json'),
    `${JSON.stringify(legacyState, null, 2)}\n`,
    { mode: 0o600 },
  )
}

async function stopProcess(pid) {
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  await waitForExit(pid).catch(async () => {
    try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
    await waitForExit(pid, 2_000).catch(() => undefined)
  })
}

async function verifyCoreExecutable(executable, label, fixtureName, extraEnvironment = {}) {
  const fixtureRoot = path.join(temporaryDirectory, fixtureName)
  const userData = path.join(fixtureRoot, 'user-data')
  const runtimeRoot = path.join(fixtureRoot, 'runtime')
  await seedLegacyState(userData)
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 })

  const coreEnvironment = { ...process.env, ...extraEnvironment, XDG_RUNTIME_DIR: runtimeRoot }
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
  child.stdout.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })
  child.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })

  let corePid = child.pid
  try {
    const socketPath = path.join(runtimeRoot, 'agent-console', 'core.sock')
    await waitForSocket(socketPath, child)
    const rpc = createRpcClient(socketPath)
    await rpc.connected
    await rpc.request('initialize', {
      protocolVersion: 1,
      client: { name: `package-verifier-${fixtureName}`, version: packageJson.version },
    })
    await rpc.request('events.subscribe', { afterSeq: 0 })
    const health = await rpc.request('core.health')
    const bootstrap = await rpc.request('core.bootstrap')
    corePid = health.pid
    invariant(health.appVersion === packageJson.version, `${label} Core reports unexpected version ${health.appVersion}`)
    invariant(health.transport === 'unix' && health.tcpListening === false, `${label} Core reports an unsafe transport`)
    invariant(bootstrap.state.projects[0].name === 'Existing Project', `${label} Core did not preserve the existing state`)
    invariant(bootstrap.state.settings.theme === 'forest-studio', `${label} Core did not preserve the existing theme`)
    invariant((await listeningTcpSocketsOwnedBy(corePid)).length === 0, `${label} Core opened a listening TCP socket`)
    await rpc.request('core.flush')
    rpc.socket.destroy()
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}\n${diagnostics}`)
  } finally {
    await stopProcess(corePid)
  }

  const preserved = JSON.parse(await fs.readFile(path.join(userData, 'mission-control-state.json'), 'utf8'))
  const checkpoint = JSON.parse(await fs.readFile(path.join(userData, 'mission-control-state.pre-core-v0.4.json'), 'utf8'))
  invariant(preserved.projects[0].name === 'Existing Project', `${label} Core changed legacy data during startup`)
  invariant(checkpoint.projects[0].name === 'Existing Project', `${label} Core checkpoint is not the legacy state`)
  invariant(((await fs.stat(path.join(userData, 'console-core.sqlite'))).mode & 0o0777) === 0o600, `${label} task ledger is not mode 0600`)
  invariant(((await fs.stat(path.join(userData, 'electron-core-profile'))).mode & 0o077) === 0, `${label} Core Electron profile is not private`)
}

async function verifyDesktopAndPersistentCore() {
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
  desktop.stdout.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })
  desktop.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000) })

  let corePid = null
  try {
    const socketPath = path.join(runtimeRoot, 'agent-console', 'core.sock')
    await waitForSocket(socketPath, desktop, 30_000)
    const rpc = createRpcClient(socketPath)
    await rpc.connected
    await rpc.request('initialize', {
      protocolVersion: 1,
      client: { name: 'desktop-lifecycle-verifier', version: packageJson.version },
    })
    await rpc.request('events.subscribe', { afterSeq: 0 })
    const health = await rpc.request('core.health')
    const bootstrap = await rpc.request('core.bootstrap')
    corePid = health.pid
    invariant(bootstrap.state.projects[0].name === 'Existing Project', 'AppImage desktop changed the existing state')
    invariant((await listeningTcpSocketsOwnedBy(corePid)).length === 0, 'Desktop-started Core opened a listening TCP socket')

    const stableAppImage = path.join(dataHome, 'agent-console', 'app', 'Agent-Console.AppImage')
    const versionMarker = path.join(dataHome, 'agent-console', 'app', 'version')
    const unitPath = path.join(configHome, 'systemd', 'user', 'agent-console-core.service')
    await Promise.all([fs.access(stableAppImage), fs.access(versionMarker), fs.access(unitPath)])
    invariant((await fs.readFile(versionMarker, 'utf8')).trim() === packageJson.version, 'Stable AppImage version marker is stale')
    invariant((await fs.readFile(unitPath, 'utf8')) === renderCoreServiceUnit(stableAppImage, userData), 'Generated systemd unit is not deterministic')
    await verifySystemdUnit(unitPath)

    await stopProcess(desktop.pid)
    invariant(corePid !== desktop.pid, 'Desktop and Core unexpectedly share one process')
    process.kill(corePid, 0)
    const afterDesktopClose = await rpc.request('core.health')
    invariant(afterDesktopClose.pid === corePid, 'Core did not remain available after the desktop closed')
    rpc.socket.destroy()
  } catch (error) {
    throw new Error(`AppImage desktop/Core lifecycle: ${error instanceof Error ? error.message : String(error)}\n${diagnostics}`)
  } finally {
    await stopProcess(desktop.pid)
    await stopProcess(corePid)
  }
}

try {
  await Promise.all([fs.access(appImage), fs.access(deb)])
  await fs.chmod(appImage, 0o755)

  const appImageExtraction = path.join(temporaryDirectory, 'appimage')
  const debExtraction = path.join(temporaryDirectory, 'deb')
  await fs.mkdir(appImageExtraction)
  await fs.mkdir(debExtraction)
  await execFileAsync(appImage, ['--appimage-extract'], { cwd: appImageExtraction, maxBuffer: 20_000_000 })
  await execFileAsync('dpkg-deb', ['--extract', deb, debExtraction], { maxBuffer: 20_000_000 })

  const appImageRoot = path.join(appImageExtraction, 'squashfs-root')
  const appImageAsar = await findFile(appImageRoot, 'app.asar')
  const debAsar = await findFile(debExtraction, 'app.asar')
  invariant(appImageAsar, 'AppImage does not contain app.asar')
  invariant(debAsar, 'deb does not contain app.asar')
  assertAsarContents(appImageAsar, 'AppImage')
  assertAsarContents(debAsar, 'deb')

  const appRun = path.join(appImageRoot, 'AppRun')
  await verifyCoreExecutable(appRun, 'AppImage', 'appimage-core')
  await verifyDesktopAndPersistentCore()
  if (installedExecutable) {
    await fs.access(installedExecutable)
    await verifyCoreExecutable(installedExecutable, 'installed deb', 'installed-deb-core')
  }

  console.log(
    `Verified Agent Console v${packageJson.version}: AppImage desktop/Core persistence, stable copy, systemd unit syntax, `
      + `${installedExecutable ? 'installed deb runtime, ' : 'deb contents, '}legacy-state preservation, Unix IPC, and zero TCP listeners.`,
  )
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}
