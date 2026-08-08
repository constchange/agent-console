import path from 'node:path'
import os from 'node:os'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { ConsoleCore, type ConsoleCoreOptions } from '../core/console-core'
import { createDefaultCoreTaskRuntimeDependencies } from '../core/adapters/core-task-runtime'
import { resolveCorePaths } from '../core/paths'
import { CoreInstanceLock } from '../core/services/instance-lock'
import { privateRemoteEnvironmentFile } from '../core/services/remote-environment-file'
import { LocalCoreServer } from '../core/transport/local-server'
import {
  CORE_PROTOCOL_VERSION,
  DESKTOP_CORE_METHODS,
  GATEWAY_CORE_METHODS,
  type CoreBootstrapResult,
  type CoreConfigResult,
  type CorePreparedAgent,
  type CorePreparedProject,
  type CoreHandlerMethod,
} from '../shared/core-protocol'
import type { RemoteSettingsState } from '../shared/remote-settings'
import type {
  ActionResult,
  AgentWindowPresentation,
  ConsoleState,
  CoreConnectionState,
  CoreHealth,
  RuntimeSnapshot,
} from '../shared/types'
import { CoreClient, readCoreProtocolMismatch } from './services/core-client'
import { CoreServiceManager, type CoreServiceState } from './services/core-service-manager'
import { drainForShutdown } from './services/shutdown-drain'
import { authCallbackFromArguments, validateAuthCallbackUrl } from './services/auth-callback'
import { RemoteDesktopController } from './services/remote-desktop-controller'
import { startRemoteGatewayRuntime, type RemoteGatewayRuntime } from './services/remote-gateway-runtime'
import { assertRemoteIpcInvocation } from './services/remote-ipc-policy'
import { readRemoteServicePrivatePaths } from './services/remote-service-config'
import { RemoteServiceManager } from './services/remote-service-manager'
import { centeredWindowBounds, TerminalManager } from './services/terminal-manager'
import { UpdateManager } from './services/update-manager'

const CORE_MODE_ARGUMENT = '--console-core'
const CORE_USER_DATA_ARGUMENT = '--console-core-user-data='
const REMOTE_GATEWAY_MODE_ARGUMENT = '--remote-gateway'
const DESKTOP_SHUTDOWN_DEADLINE_MS = 30_000
const coreMode = process.argv.includes(CORE_MODE_ARGUMENT)
const remoteGatewayMode = process.argv.includes(REMOTE_GATEWAY_MODE_ARGUMENT)
if (coreMode && remoteGatewayMode) throw new Error('Console Core and Remote Gateway roles are mutually exclusive.')
const headlessMode = coreMode || remoteGatewayMode
const configuredCoreUserData = process.argv
  .find((value) => value.startsWith(CORE_USER_DATA_ARGUMENT))
  ?.slice(CORE_USER_DATA_ARGUMENT.length)
  .trim()
const coreStateDataPath = configuredCoreUserData
  ? path.resolve(configuredCoreUserData)
  : app.getPath('userData')

if (headlessMode) {
  process.umask(0o077)
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('ozone-platform', 'headless')
  const profileParent = coreMode ? coreStateDataPath : app.getPath('userData')
  const roleProfilePath = path.join(profileParent, coreMode ? 'electron-core-profile' : 'electron-gateway-profile')
  mkdirSync(roleProfilePath, { recursive: true, mode: 0o700 })
  const profileStat = lstatSync(roleProfilePath)
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    throw new Error(`Headless Electron profile must be a real directory: ${roleProfilePath}`)
  }
  if (typeof process.getuid === 'function' && profileStat.uid !== process.getuid()) {
    throw new Error(`Headless Electron profile is not owned by the current user: ${roleProfilePath}`)
  }
  chmodSync(roleProfilePath, 0o700)
  app.setPath('userData', roleProfilePath)
}

let mainWindow: BrowserWindow | null = null
let terminals: TerminalManager
let updates: UpdateManager
let coreClient: CoreClient
let coreService: CoreServiceManager
let coreServiceState: CoreServiceState | null = null
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
let remoteDesktop: RemoteDesktopController | null = null
let remoteGatewayRuntime: RemoteGatewayRuntime | null = null
let authCallbackDrain: Promise<void> | null = null
const pendingAuthCallbacks: string[] = []

let coreRuntime: {
  core: ConsoleCore
  desktopServer: LocalCoreServer
  gatewayServer: LocalCoreServer
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
    try {
      const target = new URL(url)
      if (target.protocol === 'https:' && !target.username && !target.password) void shell.openExternal(target.toString())
    } catch {
      // Invalid or non-HTTPS targets stay denied.
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL
    try {
      if (!developmentUrl || new URL(url).origin !== new URL(developmentUrl).origin) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })

  const developmentUrl = process.env.VITE_DEV_SERVER_URL
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(path.join(__dirname, '../../renderer/index.html'))
  return window
}

function publishRemoteSettings(state: RemoteSettingsState): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-settings:state', state)
}

function queueAuthCallback(input: unknown): void {
  if (remoteGatewayMode || coreMode) return
  let callback: string
  try {
    callback = validateAuthCallbackUrl(input)
  } catch {
    console.error('Agent Console rejected an invalid authentication callback.')
    return
  }
  if (!pendingAuthCallbacks.includes(callback)) pendingAuthCallbacks.push(callback)
  if (pendingAuthCallbacks.length > 8) pendingAuthCallbacks.shift()
  drainAuthCallbacks()
}

function drainAuthCallbacks(): void {
  if (!remoteDesktop || authCallbackDrain || pendingAuthCallbacks.length === 0) return
  authCallbackDrain = (async () => {
    while (remoteDesktop && pendingAuthCallbacks.length > 0) {
      const callback = pendingAuthCallbacks.shift()!
      try {
        publishRemoteSettings(await remoteDesktop.handleAuthCallback(callback))
      } catch {
        // Never echo a callback code or provider response into logs.
        console.error('Agent Console could not complete the authentication callback.')
      }
    }
  })().finally(() => {
    authCallbackDrain = null
    if (pendingAuthCallbacks.length > 0) drainAuthCallbacks()
  })
}

function environmentDirectory(variable: string, fallback: string): string {
  const value = process.env[variable]
  if (!value) return fallback
  if (!path.isAbsolute(value)
    || path.normalize(value) !== value
    || Buffer.byteLength(value, 'utf8') > 4_096
    || /[\0\r\n]/.test(value)) {
    throw new Error(`${variable} must be one normalized absolute directory.`)
  }
  return value
}

async function createRemoteServiceManager(
  coreState: CoreServiceState,
  paths: ReturnType<typeof resolveCorePaths>,
): Promise<RemoteServiceManager | null> {
  if (!app.isPackaged || coreState.mode !== 'systemd-user') return null
  const configHome = environmentDirectory('XDG_CONFIG_HOME', path.join(os.homedir(), '.config'))
  const dataHome = environmentDirectory('XDG_DATA_HOME', path.join(os.homedir(), '.local', 'share'))
  const remoteEnvironmentFile = await privateRemoteEnvironmentFile(configHome)
  if (!remoteEnvironmentFile) return null
  const privatePaths = await readRemoteServicePrivatePaths(remoteEnvironmentFile)
  const remoteDataDirectory = path.join(dataHome, 'agent-console', 'remote')
  return new RemoteServiceManager({
    appExecutable: coreState.launchExecutable,
    launcher: path.join(remoteDataDirectory, 'bin', 'agent-console-remote-service'),
    packagedRemoteDirectory: path.join(process.resourcesPath, 'remote'),
    remoteEnvironmentFile,
    gatewaySocketPath: paths.gatewaySocketPath,
    desktopCoreSocketPath: paths.desktopSocketPath,
    sshKeyPath: privatePaths.sshKeyPath,
    sshPublicKeyPath: privatePaths.sshPublicKeyPath,
    knownHostsPath: privatePaths.knownHostsPath,
    applicationReadOnlyPath: path.dirname(coreState.launchExecutable),
  })
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
  const openAgentIds = await terminals.listOpenAgentIds(snapshot.agents)
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      terminalOpen: openAgentIds.has(agent.id),
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
      const protocolMismatch = readCoreProtocolMismatch(error)
      if (protocolMismatch && !restartedForVersion && coreServiceState?.mode === 'systemd-user') {
        restartedForVersion = true
        publishCoreConnection({
          phase: 'incompatible',
          message: `Desktop v${app.getVersion()} and the running Core use different protocols. Restarting Core safely…`,
          coreVersion: null,
          protocolVersion: protocolMismatch.supportedVersion,
        })
        try {
          await coreService.restart()
          await new Promise((resolve) => setTimeout(resolve, 500))
          continue
        } catch (restartError) {
          lastError = restartError
        }
      }
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

  ipcMain.handle('discovery:focus', async (_event, discoveredId: unknown) => {
    if (typeof discoveredId !== 'string' || discoveredId.length < 1 || discoveredId.length > 200) {
      throw new Error('A valid discovered process identifier is required.')
    }
    const snapshot = await coreClient.request<RuntimeSnapshot>('runtime.refresh', undefined, 15_000)
    const item = snapshot.discovered.find((candidate) => candidate.id === discoveredId)
    if (!item) {
      return {
        ok: false,
        action: 'not-found',
        message: 'This discovered process is no longer running.',
      }
    }
    const display = screen.getDisplayMatching(
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : screen.getPrimaryDisplay().bounds,
    )
    return terminals.focusDiscovered(item, centeredWindowBounds(display.workArea))
  })

  ipcMain.handle('ui:set-zoom-factor', (event, value: unknown) => {
    const requested = typeof value === 'number' && Number.isFinite(value) ? value : 1
    const factor = Math.min(50 / 13, Math.max(5 / 13, requested))
    event.sender.setZoomFactor(factor)
  })

  ipcMain.handle('agent:open', async (_event, agentId: unknown, requestedPresentation: unknown) => {
    if (typeof agentId !== 'string') return { ok: false, action: 'invalid', message: 'Invalid Agent ID' }
    const presentation: AgentWindowPresentation = requestedPresentation === 'centered' ? 'centered' : 'default'
    const prepared = await coreClient.request<CorePreparedAgent>('terminal.open', { agentId }, 15_000)
    if (!prepared.preparation.ok) return prepared.preparation
    const display = presentation === 'centered'
      ? screen.getDisplayMatching(mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : screen.getPrimaryDisplay().bounds)
      : null
    const bounds = display ? centeredWindowBounds(display.workArea) : undefined
    const result = await terminals.open({ ...prepared.agent, pid: prepared.runtimePid }, bounds)
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

  const remote = () => {
    if (!remoteDesktop) throw new Error('Mobile Remote is not ready.')
    return remoteDesktop
  }
  const remoteIpc = (expectedArguments: number, handler: (args: readonly unknown[]) => unknown) => (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ) => {
    assertRemoteIpcInvocation(event, mainWindow, args, expectedArguments)
    return handler(args)
  }
  ipcMain.handle('remote-settings:get', remoteIpc(0, () => remote().settings()))
  ipcMain.handle('remote-settings:sign-up', remoteIpc(1, ([input]) => remote().signUp(input)))
  ipcMain.handle('remote-settings:sign-in', remoteIpc(1, ([input]) => remote().signIn(input)))
  ipcMain.handle('remote-settings:sign-out', remoteIpc(0, () => remote().signOut()))
  ipcMain.handle('remote-settings:resend-verification', remoteIpc(0, () => remote().resendVerification()))
  ipcMain.handle('remote-settings:request-password-reset', remoteIpc(1, ([email]) => remote().requestPasswordReset(email)))
  ipcMain.handle('remote-settings:complete-password-recovery', remoteIpc(1, ([input]) => remote().completePasswordRecovery(input)))
  ipcMain.handle('remote-settings:enable', remoteIpc(0, () => remote().enable()))
  ipcMain.handle('remote-settings:disable', remoteIpc(0, () => remote().disable()))
  ipcMain.handle('remote-settings:pairing-begin', remoteIpc(0, () => remote().beginPairing()))
  ipcMain.handle('remote-settings:pairing-cancel', remoteIpc(1, ([pairingId]) => remote().cancelPairing(pairingId)))
  ipcMain.handle('remote-settings:pairing-decide', remoteIpc(1, ([input]) => remote().decidePairing(input)))
  ipcMain.handle('remote-settings:device-revoke', remoteIpc(1, ([deviceId]) => remote().revokeDevice(deviceId)))
  ipcMain.handle('remote-settings:device-retry-sync', remoteIpc(1, ([deviceId]) => remote().retryDeviceSync(deviceId)))
  ipcMain.handle('remote-settings:agent-permission', remoteIpc(1, ([input]) => remote().setAgentPermission(input)))
  ipcMain.handle('remote-settings:workstation-rename', remoteIpc(1, ([displayName]) => remote().renameWorkstation(displayName)))
  ipcMain.handle('remote-settings:doctor', remoteIpc(0, () => remote().doctor()))
  // remote-settings:workstation-remove is intentionally not registered. The
  // public state projection also forces canRemoveWorkstation=false.
}

async function startDesktop(): Promise<void> {
  Menu.setApplicationMenu(null)
  const userDataPath = app.getPath('userData')
  const paths = resolveCorePaths(userDataPath)
  coreService = new CoreServiceManager(userDataPath)
  coreServiceState = await coreService.installAndStart()
  coreClient = new CoreClient({
    socketPath: paths.desktopSocketPath,
    channel: 'desktop',
    clientVersion: app.getVersion(),
  })
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
    if (event.type === 'remote.settings' && remoteDesktop) {
      void remoteDesktop.projectEvent(event.payload).then((state) => {
        publishRemoteSettings(state)
      }).catch(() => {
        console.error('Agent Console rejected an invalid Mobile Remote state event.')
      })
    }
  })
  const bootstrap = await connectToCore(true)
  terminals = new TerminalManager(bootstrap.state.settings)
  updates = new UpdateManager()
  const remoteServices = await createRemoteServiceManager(coreServiceState, paths).catch(() => null)
  remoteDesktop = new RemoteDesktopController({
    request<T>(method: string, params?: unknown, timeoutMs?: number) {
      return coreClient.request<T>(method as CoreHandlerMethod, params, timeoutMs)
    },
  }, remoteServices, async () => {
    const reconnectWasEnabled = desktopStarted
    desktopStarted = false
    coreClient.disconnect()
    try {
      await coreService.refreshRemoteEnvironment()
      await connectToCore(false)
    } finally {
      desktopStarted = reconnectWasEnabled
      if (reconnectWasEnabled && !coreClient.connected) scheduleReconnect()
    }
  })
  registerIpc()
  mainWindow = createWindow()
  drainAuthCallbacks()
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
  const coreOptions: ConsoleCoreOptions = {
    runtime: createDefaultCoreTaskRuntimeDependencies(app.getVersion()),
    remote: {
      environment: process.env,
      safeStorage,
    },
  }
  const core = new ConsoleCore(userDataPath, app.getVersion(), coreOptions)
  let desktopServer: LocalCoreServer | null = null
  let gatewayServer: LocalCoreServer | null = null
  await lock.acquire()
  try {
    await core.start()
    desktopServer = new LocalCoreServer({
      socketPath: paths.desktopSocketPath,
      channel: 'desktop',
      serverVersion: app.getVersion(),
      handler: (method, params, context) => core.handle(method, params, context),
      allowedMethods: DESKTOP_CORE_METHODS,
      eventsEnabled: true,
      onConnectionCount: (count) => core.setClientCount('desktop', count),
      onConnectionClosed: (connectionId, channel) => core.onConnectionClosed(connectionId, channel),
    })
    gatewayServer = new LocalCoreServer({
      socketPath: paths.gatewaySocketPath,
      channel: 'gateway',
      serverVersion: app.getVersion(),
      handler: (method, params, context) => core.handle(method, params, context),
      allowedMethods: GATEWAY_CORE_METHODS,
      // Gateway clients must read events only through the authorized
      // remote.stream.open/poll bridge. Built-in subscriptions would bypass
      // JWT, device grants, and revocation checks.
      eventsEnabled: false,
      onConnectionCount: (count) => core.setClientCount('gateway', count),
      onConnectionClosed: (connectionId, channel) => core.onConnectionClosed(connectionId, channel),
    })
    // Desktop events may contain private runtime/config snapshots and are
    // never replayed. The Gateway socket has no notification channel.
    core.setDesktopEventPublisher((type, payload) => desktopServer!.publish(type, payload, { replayable: false }))
    await desktopServer.start()
    await gatewayServer.start()
    coreRuntime = { core, desktopServer, gatewayServer, lock }
  } catch (error) {
    await gatewayServer?.close().catch(() => undefined)
    await desktopServer?.close().catch(() => undefined)
    await core.stop().catch(() => undefined)
    await lock.release().catch(() => undefined)
    throw error
  }
}

async function stopConsoleCore(): Promise<void> {
  const runtime = coreRuntime
  coreRuntime = null
  if (!runtime) return
  await runtime.gatewayServer.close().catch(() => undefined)
  await runtime.desktopServer.close().catch(() => undefined)
  await runtime.core.stop().catch(() => undefined)
  await runtime.lock.release().catch(() => undefined)
}

async function startRemoteGateway(): Promise<void> {
  remoteGatewayRuntime = await startRemoteGatewayRuntime({
    argv: process.argv,
    environment: process.env,
    clientVersion: app.getVersion(),
  })
}

async function stopRemoteGateway(): Promise<void> {
  const runtime = remoteGatewayRuntime
  remoteGatewayRuntime = null
  await runtime?.close()
}

function startForRole(): Promise<void> {
  if (coreMode) return startConsoleCore()
  if (remoteGatewayMode) return startRemoteGateway()
  return startDesktop()
}

const hasApplicationInstanceLock = app.requestSingleInstanceLock()

if (!hasApplicationInstanceLock) app.quit()

if (!headlessMode) {
  app.on('second-instance', (_event, argv) => {
    try {
      const callback = authCallbackFromArguments(argv)
      if (callback) queueAuthCallback(callback)
    } catch {
      console.error('Agent Console rejected invalid authentication callback arguments.')
    }
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  queueAuthCallback(url)
})

try {
  const initialCallback = authCallbackFromArguments(process.argv)
  if (initialCallback) queueAuthCallback(initialCallback)
} catch {
  console.error('Agent Console rejected invalid authentication callback arguments.')
}

if (hasApplicationInstanceLock) app.whenReady().then(async () => {
  if (!headlessMode && app.isPackaged && !app.setAsDefaultProtocolClient('agent-console')) {
    console.error('Agent Console could not register its authentication callback protocol.')
  }
  await startForRole()
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (headlessMode) {
    console.error(remoteGatewayMode ? 'Agent Console Remote Gateway could not start:' : 'Agent Console Core could not start:', message)
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
  if (headlessMode) return
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
  if (remoteGatewayMode) {
    event.preventDefault()
    if (quitPreparation) return
    quitPreparation = stopRemoteGateway().finally(() => {
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

if (headlessMode) {
  process.once('SIGTERM', () => app.quit())
  process.once('SIGINT', () => app.quit())
}
