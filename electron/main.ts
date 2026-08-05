import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import type { ConsoleState } from '../shared/types'
import { ProcessMonitor } from './services/process-monitor'
import { StateStore } from './services/state-store'
import { TerminalManager } from './services/terminal-manager'
import { UpdateManager } from './services/update-manager'

let mainWindow: BrowserWindow | null = null
let store: StateStore
let terminals: TerminalManager
let monitor: ProcessMonitor
let updates: UpdateManager
let quitPrepared = false
let quitPreparation: Promise<void> | null = null
let installingUpdate = false

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
  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }
  return window
}

function findAgent(agentId: string) {
  return store.current.agents.find((agent) => agent.id === agentId) ?? null
}

function registerIpc(): void {
  ipcMain.handle('bootstrap:get', async () => ({
    state: store.current,
    snapshot: monitor.current ?? (await monitor.scan()),
    appVersion: app.getVersion(),
    updateState: updates.current,
    stateNotice: store.loadNotice,
  }))

  ipcMain.handle('state:save', async (_event, value: ConsoleState) => {
    if (installingUpdate) throw new Error('Agent Console is restarting to install the update; no new changes were accepted.')
    const state = await store.save(value)
    terminals.updateSettings(state.settings)
    monitor.restart()
    void monitor.scan()
    return state
  })

  ipcMain.handle('runtime:refresh', () => monitor.scan())

  ipcMain.handle('ui:set-zoom-factor', (event, value: unknown) => {
    const requested = typeof value === 'number' && Number.isFinite(value) ? value : 1
    const factor = Math.min(50 / 13, Math.max(5 / 13, requested))
    event.sender.setZoomFactor(factor)
  })

  ipcMain.handle('agent:open', async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') return { ok: false, action: 'invalid', message: 'Invalid Agent ID' }
    const agent = findAgent(agentId)
    if (!agent) return { ok: false, action: 'not-found', message: 'Agent not found' }
    const runtimeAgent = monitor.current?.agents.find((item) => item.id === agent.id)
    const result = await terminals.open({ ...agent, pid: runtimeAgent?.pid ?? agent.pid })
    setTimeout(() => void monitor.scan(), 700).unref()
    return result
  })

  ipcMain.handle('agent:close-terminal', async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') return { ok: false, action: 'invalid', message: 'Invalid Agent ID' }
    const agent = findAgent(agentId)
    if (!agent) return { ok: false, action: 'not-found', message: 'Agent not found' }
    const result = await terminals.close(agent)
    setTimeout(() => void monitor.scan(), 500).unref()
    return result
  })

  ipcMain.handle('project:restore', async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return []
    const agents = store.current.agents
      .filter((agent) => agent.projectId === projectId)
      .filter((agent) => agent.autoStart || agent.tmuxSession || agent.command)
      .sort((a, b) => a.order - b.order)
    if (agents.length === 0) {
      return [{ ok: false, action: 'empty', message: 'No launch command or tmux session is configured in this project.' }]
    }
    const results = []
    for (const agent of agents) results.push(await terminals.open(agent))
    setTimeout(() => void monitor.scan(), 900).unref()
    return results
  })

  ipcMain.handle('update:get-state', () => updates.current)
  ipcMain.handle('update:check', () => updates.check(true))
  ipcMain.handle('update:download', () => updates.download())
  ipcMain.handle('update:install', async () => {
    if (installingUpdate) {
      return { ok: true, action: 'installing', message: 'Agent Console is already restarting to install the update.' }
    }
    await store.flush()
    if (installingUpdate) {
      return { ok: true, action: 'installing', message: 'Agent Console is already restarting to install the update.' }
    }
    const result = updates.install()
    if (result.ok) {
      installingUpdate = true
      quitPrepared = true
    }
    return result
  })
  ipcMain.handle('update:open-releases', () => shell.openExternal('https://github.com/constchange/agent-console/releases'))
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  store = new StateStore(app.getPath('userData'))
  const state = await store.load()
  terminals = new TerminalManager(state.settings)
  monitor = new ProcessMonitor(() => store.current, terminals)
  updates = new UpdateManager()
  registerIpc()
  mainWindow = createWindow()
  monitor.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:snapshot', snapshot)
  })
  updates.subscribe((updateState) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', updateState)
  })
  monitor.start()
  void monitor.scan()
  updates.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox(
    'Agent Console could not open its saved data',
    `The existing state file was not replaced. Check its permissions, then reopen Agent Console.\n\n${message}`,
  )
  app.quit()
})

app.on('window-all-closed', () => {
  monitor?.stop()
  updates?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitPrepared || !store) return
  event.preventDefault()
  if (quitPreparation) return

  quitPreparation = store.flush().finally(() => {
    quitPrepared = true
    app.quit()
  })
})
