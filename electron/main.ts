import path from 'node:path'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { ConsoleCore } from '../core/console-core'
import { resolveCorePaths } from '../core/paths'
import { CoreInstanceLock } from '../core/services/instance-lock'
import { LocalCoreServer } from '../core/transport/local-server'
import {
  CORE_PROTOCOL_VERSION,
  type CoreBootstrapResult,
  type CoreConfigResult,
  type CorePreparedAgent,
  type CorePreparedProject,
} from '../shared/core-protocol'
import type {
  ActionResult,
  ConsoleState,
  CoreConnectionState,
  CoreHealth,
  RuntimeSnapshot,
} from '../shared/types'
import { CoreClient } from './services/core-client'
import { CoreServiceManager } from './services/core-service-manager'
import { drainForShutdown } from './services/shutdown-drain'
import { TerminalManager, windowTitle } from './services/terminal-manager'
import { UpdateManager } from './services/update-manager'

const CORE_MODE_ARGUMENT = '--console-core'
const CORE_USER_DATA_ARGUMENT = '--console-core-user-data='
const DESKTOP_SHUTDOWN_DEADLINE_MS = 30_000
const coreMode = process.argv.includes(CORE_MODE_ARGUMENT)
const configuredCoreUserData = process.argv
  .find((value) => value.startsWith(CORE_USER_DATA_ARGUMENT))
  ?.slice(CORE_USER_DATA_ARGUMENT.length)
  .trim()
const coreStateDataPath = configuredCoreUserData
  ? path.resolve(configuredCoreUserData)
  : app.getPath('userData')

if (coreMode) {
  process.umask(0o077)
  const coreElectronProfilePath = path.join(coreStateDataPath, 'electron-core-profile')
  mkdirSync(coreElectronProfilePath, { recursive: true, mode: 0o700 })
  const profileStat = lstatSync(coreElectronProfilePath)
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    throw new Error(`Console Core profile must be a real directory: ${coreElectronProfilePath}`)
  }
  if (typeof process.getuid === 'function' && profileStat.uid !== process.getuid()) {
    throw new Error(`Console Core profile is not owned by the current user: ${coreElectronProfilePath}`)
  }
  chmodSync(coreElectronProfilePath, 0o700)
  app.setPath('userData', coreElectronProfilePath)
}

let mainWindow: BrowserWindow | null = null
let terminals: TerminalManager
let updates: UpdateManager
let coreClient: CoreClient
let coreService: CoreServiceManager
let coreHealth: CoreHealth | null = null
let coreStateRevision = ''
let coreStateGeneration = 0
let coreStateSynchronized = false
let coreConnection: CoreConnectionState = {
  phase: 'starting',
  message: 'Starting the private local Core…',
  coreVersion: null,
  protocolVersion: null,
}
let saveQueue: Promise<void> = Promise.resolve()
let acceptedStateSaveSequence = 0
let quitPrepared = false
let quitPreparation: Promise<void> | null = null
let installingUpdate = false
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectAttempt: Promise<CoreBootstrapResult> | null = null
let desktopStarted = false

let coreRuntime: {
  core: ConsoleCore
  server: LocalCoreServer
  lock: CoreInstanceLock
} | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1_080,
    minHeight: 680,
    show: false,
    backgroundColor: '#f7f4ec',
    title: 'Agent Console',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL
    if (!developmentUrl || !url.startsWith(developmentUrl)) event.preventDefault()
  })

  const developmentUrl = process.env.VITE_DEV_SERVER_URL
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(path.join(__dirname, '../../renderer/index.html'))
  return window
}

function publishCoreConnection(next: CoreConnectionState): void {
  coreConnection = next
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('core:connection', next)
}

function requestRuntimeRefresh(delayMs: number): void {
  const timer = setTimeout(() => {
    if (coreClient?.connected) void coreClient.request('runtime.refresh').catch(() => undefined)
  }, delayMs)
  timer.unref()
}

async function withDesktopWindowState(snapshot: RuntimeSnapshot): Promise<RuntimeSnapshot> {
  if (!terminals) return snapshot
  const titles = await terminals.listWindowTitles()
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      terminalOpen: titles.some((title) => title.includes(windowTitle(agent)) || title.includes(agent.terminalTitle)),
    })),
  }
}

async function connectToCore(initial: boolean): Promise<CoreBootstrapResult> {
  publishCoreConnection({
    phase: initial ? 'starting' : 'reconnecting',
    message: initial ? 'Starting the private local Core…' : 'Reconnecting to the private local Core…',
    coreVersion: coreHealth?.appVersion ?? null,
    protocolVersion: coreHealth?.protocolVersion ?? null,
  })

  const deadline = Date.now() + (initial ? 15_000 : 30_000)
  let lastError: unknown = null
  let restartedForVersion = false
  let recoveryStarted = false
  while (Date.now() < deadline) {
    try {
      if (!coreClient.connected) await coreClient.connect()
      const health = await coreClient.request<CoreHealth>('core.health')
      if (health.protocolVersion !== CORE_PROTOCOL_VERSION || health.appVersion !== app.getVersion()) {
        publishCoreConnection({
          phase: 'incompatible',
          message: `Desktop v${app.getVersion()} and Core v${health.appVersion} do not match. Restarting Core safely…`,
          coreVersion: health.appVersion,
          protocolVersion: health.protocolVersion,
        })
        if (restartedForVersion) throw new Error('The local Core version is incompatible with this desktop version.')
        restartedForVersion = true
        coreClient.disconnect()
        await coreService.restart(health.pid)
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      const bootstrap = await coreClient.request<CoreBootstrapResult>('core.bootstrap')
      coreHealth = health
      publishCoreConnection({
        phase: 'connected',
        message: 'Private local Core connected through a Unix socket. No TCP port is open.',
        coreVersion: health.appVersion,
        protocolVersion: health.protocolVersion,
      })
      return bootstrap
    } catch (error) {
      lastError = error
      coreClient.disconnect()
      if (!initial && !recoveryStarted) {
        recoveryStarted = true
        await coreService.ensureRunning(coreHealth?.pid).catch((serviceError) => {
          lastError = serviceError
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  publishCoreConnection({
    phase: 'offline',
    message: 'The private local Core is offline. Agent Console will keep retrying without writing the state file directly.',
    coreVersion: coreHealth?.appVersion ?? null,
    protocolVersion: coreHealth?.protocolVersion ?? null,
  })
  throw lastError instanceof Error ? lastError : new Error('Timed out while starting the private local Core.')
}

function scheduleReconnect(): void {
  if (!desktopStarted || installingUpdate || reconnectTimer || reconnectAttempt) return
  publishCoreConnection({
    phase: 'offline',
    message: 'The private local Core disconnected. Reconnecting…',
    coreVersion: coreHealth?.appVersion ?? null,
    protocolVersion: coreHealth?.protocolVersion ?? null,
  })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    const attempt = connectToCore(false)
    reconnectAttempt = attempt
    void attempt.then((bootstrap) => {
      terminals.updateSettings(bootstrap.state.settings)
    }).catch(() => undefined).finally(() => {
      reconnectAttempt = null
      if (!coreClient.connected) scheduleReconnect()
    })
  }, 750)
  reconnectTimer.unref()
}

function registerIpc(): void {
  ipcMain.handle('bootstrap:get', async () => {
    const bootstrap = await coreClient.request<CoreBootstrapResult>('core.bootstrap', undefined, 10_000)
    coreHealth = bootstrap.health
    return {
      state: bootstrap.state,
      stateRevision: bootstrap.stateRevision,
      snapshot: await withDesktopWindowState(bootstrap.snapshot),
      appVersion: app.getVersion(),
      updateState: updates.current,
      stateNotice: bootstrap.stateNotice,
      core: bootstrap.health,
    }
  })

  ipcMain.handle('state:save', async (_event, value: ConsoleState) => {
    if (quitPreparation) throw new Error('Agent Console is closing; no new changes were accepted.')
    if (installingUpdate) throw new Error('Agent Console is restarting to install the update; no new changes were accepted.')
    acceptedStateSaveSequence += 1
    const requestedGeneration = coreStateGeneration
    const acceptedWhileSynchronized = coreStateSynchronized
    const operation = saveQueue.then(async () => {
      if (!acceptedWhileSynchronized || requestedGeneration !== coreStateGeneration || !coreStateRevision) {
        throw new Error('Console Core reconnected before this change could be saved. The desktop must resynchronize first.')
      }
      const result = await coreClient.request<CoreConfigResult>('config.commit', {
        expectedRevision: coreStateRevision,
        state: value,
      }, 15_000)
      coreStateRevision = result.stateRevision
      coreHealth = coreHealth ? { ...coreHealth, stateRevision: result.stateRevision } : coreHealth
      terminals.updateSettings(result.state.settings)
      return result.state
    })
    saveQueue = operation.then(() => undefined, () => undefined)
    return operation
  })
  ipcMain.handle('state:barrier', () => acceptedStateSaveSequence)

  ipcMain.handle('runtime:refresh', async () => withDesktopWindowState(
    await coreClient.request<RuntimeSnapshot>('runtime.refresh', undefined, 15_000),
  ))

  ipcMain.handle('ui:set-zoom-factor', (event, value: unknown) => {
    const requested = typeof value === 'number' && Number.isFinite(value) ? value : 1
    const factor = Math.min(50 / 13, Math.max(5 / 13, requested))
    event.sender.setZoomFactor(factor)
  })

  ipcMain.handle('agent:open', async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') return { ok: false, action: 'invalid', message: 'Invalid Agent ID' }
    const prepared = await coreClient.request<CorePreparedAgent>('terminal.open', { agentId }, 15_000)
    if (!prepared.preparation.ok) return prepared.preparation
    const result = await terminals.open({ ...prepared.agent, pid: prepared.runtimePid })
    requestRuntimeRefresh(700)
    return result
  })

  ipcMain.handle('agent:close-terminal', async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') return { ok: false, action: 'invalid', message: 'Invalid Agent ID' }
    const prepared = await coreClient.request<CorePreparedAgent>('terminal.close', { agentId })
    const result = await terminals.close({ ...prepared.agent, pid: prepared.runtimePid })
    requestRuntimeRefresh(500)
    return result
  })

  ipcMain.handle('project:restore', async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return []
    const prepared = await coreClient.request<CorePreparedProject>('project.restore', { projectId }, 90_000)
    if (prepared.agents.length === 0) return prepared.preparationResults
    const results: ActionResult[] = [...prepared.preparationResults.filter((result) => !result.ok)]
    for (const item of prepared.agents) {
      if (item.preparation.ok) results.push(await terminals.open({ ...item.agent, pid: item.runtimePid }))
    }
    requestRuntimeRefresh(900)
    return results
  })

  ipcMain.handle('core:get-health', () => coreClient.request<CoreHealth>('core.health'))
  ipcMain.handle('core:ack-bootstrap', async (_event, stateRevision: unknown) => {
    if (typeof stateRevision !== 'string' || !/^[a-f0-9]{64}$/.test(stateRevision)) {
      throw new Error('Invalid Console Core state revision.')
    }
    const requestedGeneration = coreStateGeneration
    const current = await coreClient.request<CoreConfigResult>('config.get')
    if (requestedGeneration !== coreStateGeneration || !coreClient.connected) {
      throw new Error('Console Core reconnected before the desktop finished resynchronizing.')
    }
    if (current.stateRevision !== stateRevision) {
      throw new Error('Console Core changed again before the desktop finished resynchronizing.')
    }
    coreStateRevision = stateRevision
    coreStateSynchronized = true
  })
  ipcMain.handle('update:get-state', () => updates.current)
  ipcMain.handle('update:check', () => updates.check(true))
  ipcMain.handle('update:download', () => updates.download())
  ipcMain.handle('update:install', async () => {
    if (installingUpdate) {
      return { ok: true, action: 'installing', message: 'Agent Console is already restarting to install the update.' }
    }
    if (!updates.current.canInstall) return updates.install()
    installingUpdate = true
    try {
      await saveQueue
      await coreClient.request('core.flush', undefined, 20_000)
      const result = updates.install()
      if (!result.ok) installingUpdate = false
      if (result.ok) {
        quitPrepared = true
      }
      return result
    } catch (error) {
      installingUpdate = false
      throw error
    }
  })
  ipcMain.handle('update:open-releases', () => shell.openExternal('https://github.com/constchange/agent-console/releases'))
}

async function startDesktop(): Promise<void> {
  Menu.setApplicationMenu(null)
  const userDataPath = app.getPath('userData')
  const paths = resolveCorePaths(userDataPath)
  coreService = new CoreServiceManager(userDataPath)
  await coreService.installAndStart()
  coreClient = new CoreClient({ socketPath: paths.socketPath, clientVersion: app.getVersion() })
  coreClient.onConnectionChange((connected) => {
    if (!connected) {
      coreStateGeneration += 1
      coreStateRevision = ''
      coreStateSynchronized = false
      scheduleReconnect()
    }
  })
  coreClient.onEvent((event) => {
    if (event.type === 'runtime.snapshot' && mainWindow && !mainWindow.isDestroyed()) {
      void withDesktopWindowState(event.payload as RuntimeSnapshot).then((snapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:snapshot', snapshot)
      })
    }
  })
  const bootstrap = await connectToCore(true)
  terminals = new TerminalManager(bootstrap.state.settings)
  updates = new UpdateManager()
  registerIpc()
  mainWindow = createWindow()
  updates.subscribe((updateState) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', updateState)
  })
  updates.start()
  desktopStarted = true

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}

function configuredCoreUserDataPath(): string {
  return coreStateDataPath
}

async function startConsoleCore(): Promise<void> {
  const userDataPath = configuredCoreUserDataPath()
  const paths = resolveCorePaths(userDataPath)
  const lock = new CoreInstanceLock(paths.lockPath)
  const core = new ConsoleCore(userDataPath, app.getVersion())
  const server = new LocalCoreServer({
    socketPath: paths.socketPath,
    serverVersion: app.getVersion(),
    handler: (method, params, context) => core.handle(method, params, context),
    onConnectionCount: (count) => core.setClientCount(count),
  })
  // Current events contain full local runtime/config snapshots. They are sent
  // live but never retained for replay; a reconnect always obtains one fresh
  // bootstrap instead of buffering old private output.
  core.setEventPublisher((type, payload) => server.publish(type, payload, { replayable: false }))
  await lock.acquire()
  try {
    await core.start()
    await server.start()
    coreRuntime = { core, server, lock }
  } catch (error) {
    await server.close().catch(() => undefined)
    await core.stop().catch(() => undefined)
    await lock.release().catch(() => undefined)
    throw error
  }
}

async function stopConsoleCore(): Promise<void> {
  const runtime = coreRuntime
  coreRuntime = null
  if (!runtime) return
  await runtime.server.close().catch(() => undefined)
  await runtime.core.stop().catch(() => undefined)
  await runtime.lock.release().catch(() => undefined)
}

const hasApplicationInstanceLock = app.requestSingleInstanceLock()

if (!hasApplicationInstanceLock) app.quit()

if (!coreMode) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

if (hasApplicationInstanceLock) app.whenReady().then(coreMode ? startConsoleCore : startDesktop).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (coreMode) {
    console.error('Agent Console Core could not start:', message)
    app.exit(1)
    return
  }
  console.error('Agent Console desktop could not start:', message)
  if (process.env.AGENT_CONSOLE_FORCE_DETACHED_CORE === '1') {
    // Hermetic visual checks have no person available to dismiss a native
    // error box. Exit with diagnostics instead of blocking the CI runner.
    app.exit(1)
    return
  }
  dialog.showErrorBox(
    'Agent Console could not start its private local Core',
    `Your existing state file was not replaced. Agent Console did not fall back to a second writer.\n\n${message}`,
  )
  app.quit()
})

app.on('window-all-closed', () => {
  if (coreMode) return
  updates?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitPrepared) return
  if (coreMode) {
    event.preventDefault()
    if (quitPreparation) return
    quitPreparation = stopConsoleCore().finally(() => {
      quitPrepared = true
      app.quit()
    })
    return
  }
  if (!coreClient) return
  event.preventDefault()
  if (quitPreparation) return
  desktopStarted = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  quitPreparation = drainForShutdown({
    timeoutMs: DESKTOP_SHUTDOWN_DEADLINE_MS,
    drain: async () => {
      await saveQueue
      if (coreClient.connected) await coreClient.request('core.flush', undefined, 20_000)
    },
    abort: () => coreClient.disconnect(),
  })
    .then((result) => {
      if (result.status === 'timed-out') {
        console.error(`Agent Console stopped waiting for desktop saves after ${DESKTOP_SHUTDOWN_DEADLINE_MS} ms.`)
      } else if (result.status === 'failed') {
        console.error('Agent Console could not finish its desktop shutdown flush.', result.error)
      }
    })
    .finally(() => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      coreClient.disconnect()
      quitPrepared = true
      app.quit()
    })
})

if (coreMode) {
  process.once('SIGTERM', () => app.quit())
  process.once('SIGINT', () => app.quit())
}
