export type AgentStatus =
  | 'thinking'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'finished'
  | 'error'
  | 'stopped'
  | 'offline'

export type AgentKind =
  | 'codex'
  | 'terminal'
  | 'backend'
  | 'worker'
  | 'python'
  | 'node'
  | 'docker'
  | 'tmux'
  | 'process'

export type TerminalApp =
  | 'auto'
  | 'ghostty'
  | 'gnome-terminal'
  | 'kitty'
  | 'konsole'
  | 'xfce4-terminal'
  | 'x-terminal-emulator'

export const THEME_IDS = [
  'navy-gold',
  'song-porcelain',
  'kyoto-washi',
  'bauhaus',
  'swiss-modern',
  'art-deco',
  'nordic-fjord',
  'mediterranean',
  'sahara',
  'sakura',
  'persian-night',
  'solarpunk',
  'cyber-tokyo',
  'arctic',
  'carnival',
  'forest-studio',
] as const

export type ThemeId = typeof THEME_IDS[number]

export interface Project {
  id: string
  name: string
  emoji: string
  color: string
  collapsed: boolean
  order: number
}

export interface AgentConfig {
  id: string
  projectId: string
  name: string
  emoji: string
  color: string
  kind: AgentKind
  terminalTitle: string
  terminalApp: TerminalApp
  tmuxSession: string
  command: string
  cwd: string
  matchPattern: string
  logPath: string
  autoStart: boolean
  order: number
  pid?: number | null
  statusOverride?: AgentStatus | null
}

export interface ConsoleSettings {
  defaultTerminal: TerminalApp
  scanIntervalMs: number
  compactMode: boolean
  fontSizePx: number
  theme: ThemeId
}

export interface ConsoleState {
  version: 1
  projects: Project[]
  agents: AgentConfig[]
  settings: ConsoleSettings
}

export interface ProcessInfo {
  pid: number
  ppid: number
  cpu: number
  memory: number
  runtimeSeconds: number
  processState: string
  tty: string
  command: string
  args: string
  cwd: string
  kind: AgentKind | null
}

export interface TmuxPaneInfo {
  session: string
  window: string
  paneId: string
  panePid: number
  currentCommand: string
  cwd: string
  active: boolean
  dead: boolean
  activityAt: number
  lastOutput: string
}

export interface RuntimeAgent extends AgentConfig {
  pid: number | null
  cpu: number
  memory: number
  runtimeSeconds: number
  status: AgentStatus
  lastUpdated: string
  lastOutput: string
  processName: string
  processState: string
  terminalOpen: boolean
}

export interface DiscoveredItem {
  id: string
  name: string
  suggestedName: string
  emoji: string
  color: string
  kind: AgentKind
  pid: number | null
  ppid: number | null
  cpu: number
  memory: number
  runtimeSeconds: number
  command: string
  args: string
  cwd: string
  tmuxSession: string
  terminalTitle: string
  lastOutput: string
  status: AgentStatus
}

export interface SystemCapabilities {
  platform: string
  terminals: TerminalApp[]
  tmux: boolean
  wmctrl: boolean
  xdotool: boolean
  docker: boolean
  homeDirectory: string
}

export interface RuntimeSnapshot {
  capturedAt: string
  agents: RuntimeAgent[]
  discovered: DiscoveredItem[]
  capabilities: SystemCapabilities
  scanError: string | null
}

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export type InstallationKind =
  | 'appimage'
  | 'deb'
  | 'rpm'
  | 'pacman'
  | 'development'
  | 'unknown'

export interface UpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseDate: string | null
  progress: UpdateProgress | null
  lastCheckedAt: string | null
  message: string
  installationKind: InstallationKind
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
}

export interface BootstrapData {
  state: ConsoleState
  snapshot: RuntimeSnapshot
  appVersion: string
  updateState: UpdateState
  stateNotice: string | null
}

export interface ActionResult {
  ok: boolean
  action: string
  message: string
}

export interface AgentConsoleApi {
  getBootstrap: () => Promise<BootstrapData>
  saveState: (state: ConsoleState) => Promise<ConsoleState>
  refresh: () => Promise<RuntimeSnapshot>
  setZoomFactor: (factor: number) => Promise<void>
  openAgent: (agentId: string) => Promise<ActionResult>
  closeAgentTerminal: (agentId: string) => Promise<ActionResult>
  restoreProject: (projectId: string) => Promise<ActionResult[]>
  onSnapshot: (callback: (snapshot: RuntimeSnapshot) => void) => () => void
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  installUpdate: () => Promise<ActionResult>
  openReleasesPage: () => Promise<void>
  onUpdateState: (callback: (state: UpdateState) => void) => () => void
}
