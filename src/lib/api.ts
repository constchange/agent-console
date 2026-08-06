import type {
  AgentConfig,
  AgentConsoleApi,
  AgentStatus,
  ConsoleState,
  CoreHealth,
  RuntimeAgent,
  RuntimeSnapshot,
  UpdateState,
} from '../../shared/types'

let previewState: ConsoleState = {
  version: 1,
  projects: [
    { id: 'product', name: 'Product', emoji: '◫', color: '#55a6ff', collapsed: false, order: 0 },
    { id: 'sales', name: 'Sales', emoji: '↗', color: '#54c79b', collapsed: false, order: 1 },
    { id: 'management', name: 'Management', emoji: '◆', color: '#a478ff', collapsed: false, order: 2 },
  ],
  agents: [],
  settings: {
    defaultTerminal: 'auto',
    scanIntervalMs: 2_500,
    compactMode: true,
    fontSizePx: 25,
    theme: 'navy-gold',
  },
}

const previewStateRevision = '0'.repeat(64)

const seed = (
  id: string,
  projectId: string,
  name: string,
  emoji: string,
  color: string,
  kind: AgentConfig['kind'],
  order: number,
): AgentConfig => ({
  id,
  projectId,
  name,
  emoji,
  color,
  kind,
  terminalTitle: `${emoji} ${name}`,
  terminalApp: 'auto',
  tmuxSession: id,
  command: '',
  cwd: `/home/user/Projects/${projectId}`,
  matchPattern: '',
  logPath: '',
  autoStart: true,
  order,
  pid: 2_000 + order,
  statusOverride: null,
})

previewState.agents = [
  seed('product-planner', 'product', 'Product Planner', '◇', '#55a6ff', 'codex', 0),
  seed('prototype-backend', 'product', 'Prototype Backend', '⬡', '#a478ff', 'backend', 1),
  seed('sales-assistant', 'sales', 'Sales Assistant', '↗', '#54c79b', 'codex', 0),
  seed('crm-sync', 'sales', 'CRM Sync', '◉', '#f6b94b', 'worker', 1),
  seed('operations-agent', 'management', 'Operations Agent', '◆', '#a478ff', 'codex', 0),
  seed('reporting-dashboard', 'management', 'Reporting Dashboard', '▰', '#f6b94b', 'backend', 1),
]

const previewStatuses: AgentStatus[] = ['thinking', 'waiting', 'running', 'running', 'idle', 'finished', 'error']

function createPreviewUpdateState(): UpdateState {
  const previewPhase = typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('updatePreview')

  if (previewPhase === 'available') {
    return {
      phase: 'available',
      currentVersion: '0.4.0',
      availableVersion: '0.4.1',
      releaseName: 'Agent Console v0.4.1',
      releaseNotes: '• Improves Agent discovery on Linux Mint.\n• Adds clearer update diagnostics.\n• Keeps all existing Project and Agent data.',
      releaseDate: '2026-08-05T00:00:00.000Z',
      progress: null,
      lastCheckedAt: '2026-08-05T00:00:00.000Z',
      message: 'Agent Console v0.4.1 is available.',
      installationKind: 'appimage',
      canCheck: true,
      canDownload: true,
      canInstall: false,
    }
  }

  return {
    phase: 'disabled',
    currentVersion: '0.4.0-preview',
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    lastCheckedAt: null,
    message: 'Update checks are available in packaged AppImage and deb builds.',
    installationKind: 'development',
    canCheck: false,
    canDownload: false,
    canInstall: false,
  }
}

const previewUpdateState = createPreviewUpdateState()

const previewCoreHealth: CoreHealth = {
  appVersion: '0.4.0-preview',
  protocolVersion: 1,
  startedAt: new Date().toISOString(),
  pid: 0,
  transport: 'unix',
  stateRevision: 'preview',
  structuredCodex: 'deferred',
  tcpListening: false,
}

function runtimeAgent(agent: AgentConfig, index: number): RuntimeAgent {
  const status = previewStatuses[index % previewStatuses.length]
  const output: Record<AgentStatus, string> = {
    thinking: 'Comparing priorities across the current product roadmap…',
    running: 'Listening on http://127.0.0.1:4173',
    waiting: 'Waiting for approval before applying 3 planned changes',
    idle: 'Ready for the next instruction',
    finished: 'Sales briefing exported successfully',
    error: 'Database connection refused — retrying in 10s',
    stopped: 'Process stopped',
    offline: 'No live process matched',
  }
  return {
    ...agent,
    pid: agent.pid ?? null,
    cpu: status === 'thinking' ? 18.4 : status === 'running' ? 4.8 : 0.2,
    memory: 1.2 + index * 0.3,
    runtimeSeconds: 1_285 + index * 8_421,
    status,
    lastUpdated: new Date().toISOString(),
    lastOutput: output[status],
    processName: agent.kind === 'codex' ? 'codex' : agent.kind === 'backend' ? 'node' : 'python3',
    processState: status === 'thinking' || status === 'running' ? 'R+' : 'S+',
    terminalOpen: index < 4,
  }
}

function previewSnapshot(): RuntimeSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agents: previewState.agents.map(runtimeAgent),
    discovered: [
      {
        id: 'process-4821',
        name: 'Codex · product-roadmap',
        suggestedName: 'Product Roadmap Codex',
        emoji: '◆',
        color: '#55a6ff',
        kind: 'codex',
        pid: 4_821,
        ppid: 4_799,
        cpu: 7.4,
        memory: 2.1,
        runtimeSeconds: 3_842,
        command: 'codex',
        args: 'codex --full-auto',
        cwd: '/home/user/Projects/product-roadmap',
        tmuxSession: 'product-roadmap',
        terminalTitle: '◆ Product Roadmap Codex',
        lastOutput: 'Reordering roadmap items by impact and effort…',
        status: 'thinking',
      },
      {
        id: 'process-5120',
        name: 'Backend · sales-dashboard',
        suggestedName: 'Sales Dashboard Backend',
        emoji: '⬡',
        color: '#a478ff',
        kind: 'backend',
        pid: 5_120,
        ppid: 1,
        cpu: 1.2,
        memory: 1.6,
        runtimeSeconds: 18_420,
        command: 'node',
        args: 'npm run dev',
        cwd: '/home/user/Projects/sales-dashboard',
        tmuxSession: '',
        terminalTitle: '⬡ Sales Dashboard Backend',
        lastOutput: 'Ready in 812ms',
        status: 'running',
      },
    ],
    capabilities: {
      platform: 'linux',
      terminals: ['gnome-terminal', 'kitty'],
      tmux: true,
      wmctrl: true,
      xdotool: true,
      docker: true,
      homeDirectory: '/home/user',
    },
    scanError: null,
  }
}

const previewApi: AgentConsoleApi = {
  getBootstrap: async () => ({
    state: previewState,
    stateRevision: previewStateRevision,
    snapshot: previewSnapshot(),
    appVersion: '0.4.0-preview',
    updateState: previewUpdateState,
    stateNotice: null,
    core: previewCoreHealth,
  }),
  saveState: async (state) => {
    previewState = structuredClone(state)
    return previewState
  },
  refresh: async () => previewSnapshot(),
  setZoomFactor: async () => undefined,
  openAgent: async () => ({ ok: true, action: 'focused', message: 'Terminal focused (preview)' }),
  closeAgentTerminal: async () => ({ ok: true, action: 'closed', message: 'Terminal closed (preview)' }),
  restoreProject: async () => [{ ok: true, action: 'restored', message: 'Workspace restored (preview)' }],
  onSnapshot: () => () => undefined,
  getUpdateState: async () => previewUpdateState,
  checkForUpdates: async () => previewUpdateState,
  downloadUpdate: async () => previewUpdateState,
  installUpdate: async () => ({ ok: false, action: 'preview', message: 'Updates are disabled in preview mode.' }),
  openReleasesPage: async () => undefined,
  onUpdateState: () => () => undefined,
  getCoreHealth: async () => previewCoreHealth,
  acknowledgeCoreState: async () => undefined,
  onCoreConnection: () => () => undefined,
}

export function getApi(): AgentConsoleApi {
  return window.agentConsole ?? previewApi
}
