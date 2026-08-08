import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentWindowPresentation,
  AgentConsoleApi,
  ConsoleState,
  CoreConnectionState,
  RuntimeSnapshot,
  UpdateState,
} from '../shared/types'
import type {
  RemoteAgentPermissionInput,
  RemoteCompletePasswordRecoveryInput,
  RemotePairingDecisionInput,
  RemoteRemoveWorkstationInput,
  RemoteSettingsState,
  RemoteSignInInput,
  RemoteSignUpInput,
} from '../shared/remote-settings'

const api: AgentConsoleApi = {
  getBootstrap: () => ipcRenderer.invoke('bootstrap:get'),
  saveState: (state: ConsoleState) => ipcRenderer.invoke('state:save', state),
  stateBarrier: () => ipcRenderer.invoke('state:barrier'),
  refresh: () => ipcRenderer.invoke('runtime:refresh'),
  focusDiscoveredProcess: (discoveredId: string) => ipcRenderer.invoke('discovery:focus', discoveredId),
  setZoomFactor: (factor: number) => ipcRenderer.invoke('ui:set-zoom-factor', factor),
  openAgent: (agentId: string, presentation: AgentWindowPresentation = 'default') => ipcRenderer.invoke('agent:open', agentId, presentation),
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
  getCoreHealth: () => ipcRenderer.invoke('core:get-health'),
  acknowledgeCoreState: (stateRevision: string) => ipcRenderer.invoke('core:ack-bootstrap', stateRevision),
  onCoreConnection: (callback: (state: CoreConnectionState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CoreConnectionState) => callback(state)
    ipcRenderer.on('core:connection', listener)
    return () => ipcRenderer.removeListener('core:connection', listener)
  },
  getRemoteSettings: () => ipcRenderer.invoke('remote-settings:get'),
  remoteSignUp: (input: RemoteSignUpInput) => ipcRenderer.invoke('remote-settings:sign-up', input),
  remoteSignIn: (input: RemoteSignInInput) => ipcRenderer.invoke('remote-settings:sign-in', input),
  remoteSignOut: () => ipcRenderer.invoke('remote-settings:sign-out'),
  remoteResendVerification: () => ipcRenderer.invoke('remote-settings:resend-verification'),
  remoteRequestPasswordReset: (email: string) => ipcRenderer.invoke('remote-settings:request-password-reset', email),
  remoteCompletePasswordRecovery: (input: RemoteCompletePasswordRecoveryInput) => ipcRenderer.invoke('remote-settings:complete-password-recovery', input),
  remoteEnable: () => ipcRenderer.invoke('remote-settings:enable'),
  remoteDisable: () => ipcRenderer.invoke('remote-settings:disable'),
  remoteBeginPairing: () => ipcRenderer.invoke('remote-settings:pairing-begin'),
  remoteCancelPairing: (pairingId: string) => ipcRenderer.invoke('remote-settings:pairing-cancel', pairingId),
  remoteDecidePairing: (input: RemotePairingDecisionInput) => ipcRenderer.invoke('remote-settings:pairing-decide', input),
  remoteRevokeDevice: (deviceId: string) => ipcRenderer.invoke('remote-settings:device-revoke', deviceId),
  remoteRetryDeviceSync: (deviceId: string) => ipcRenderer.invoke('remote-settings:device-retry-sync', deviceId),
  remoteUpdateAgentPermission: (input: RemoteAgentPermissionInput) => ipcRenderer.invoke('remote-settings:agent-permission', input),
  remoteRenameWorkstation: (displayName: string) => ipcRenderer.invoke('remote-settings:workstation-rename', displayName),
  remoteRunDoctor: () => ipcRenderer.invoke('remote-settings:doctor'),
  remoteRemoveWorkstation: (input: RemoteRemoveWorkstationInput) => ipcRenderer.invoke('remote-settings:workstation-remove', input),
  onRemoteSettings: (callback: (state: RemoteSettingsState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: RemoteSettingsState) => callback(state)
    ipcRenderer.on('remote-settings:state', listener)
    return () => ipcRenderer.removeListener('remote-settings:state', listener)
  },
}

contextBridge.exposeInMainWorld('agentConsole', api)
