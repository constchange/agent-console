import { contextBridge, ipcRenderer } from 'electron'
import type { AgentConsoleApi, ConsoleState, RuntimeSnapshot, UpdateState } from '../shared/types'

const api: AgentConsoleApi = {
  getBootstrap: () => ipcRenderer.invoke('bootstrap:get'),
  saveState: (state: ConsoleState) => ipcRenderer.invoke('state:save', state),
  refresh: () => ipcRenderer.invoke('runtime:refresh'),
  setZoomFactor: (factor: number) => ipcRenderer.invoke('ui:set-zoom-factor', factor),
  openAgent: (agentId: string) => ipcRenderer.invoke('agent:open', agentId),
  closeAgentTerminal: (agentId: string) => ipcRenderer.invoke('agent:close-terminal', agentId),
  restoreProject: (projectId: string) => ipcRenderer.invoke('project:restore', projectId),
  onSnapshot: (callback: (snapshot: RuntimeSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot) => callback(snapshot)
    ipcRenderer.on('runtime:snapshot', listener)
    return () => ipcRenderer.removeListener('runtime:snapshot', listener)
  },
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleasesPage: () => ipcRenderer.invoke('update:open-releases'),
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },
}

contextBridge.exposeInMainWorld('agentConsole', api)
