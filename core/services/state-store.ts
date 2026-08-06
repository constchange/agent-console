import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { THEME_IDS, type AgentConfig, type ConsoleState, type Project, type TerminalApp, type ThemeId } from '../../shared/types'

const COLORS = ['#55a6ff', '#a478ff', '#54c79b', '#f6b94b', '#ef6f7a', '#8b98a9']
const TERMINALS: TerminalApp[] = [
  'auto',
  'ghostty',
  'gnome-terminal',
  'kitty',
  'konsole',
  'xfce4-terminal',
  'x-terminal-emulator',
]

function text(value: unknown, fallback: string, max = 300): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

function id(value: unknown, fallback: string): string {
  const candidate = text(value, fallback, 80).replace(/[^a-zA-Z0-9_-]/g, '-')
  return candidate || fallback
}

function number(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function sanitizeProject(value: Partial<Project>, index: number): Project {
  return {
    id: id(value.id, `project-${index + 1}`),
    name: text(value.name, `Project ${index + 1}`, 80),
    emoji: text(value.emoji, '◇', 8),
    color: /^#[0-9a-fA-F]{6}$/.test(value.color ?? '') ? value.color! : COLORS[index % COLORS.length],
    collapsed: Boolean(value.collapsed),
    order: number(value.order, index, 0, 10_000),
  }
}

function sanitizeAgent(value: Partial<AgentConfig>, index: number, validProjects: Set<string>): AgentConfig {
  const projectId = validProjects.has(value.projectId ?? '')
    ? value.projectId!
    : [...validProjects][0] ?? 'inbox'
  const terminal = TERMINALS.includes(value.terminalApp as TerminalApp) ? value.terminalApp! : 'auto'
  const knownKinds = ['codex', 'terminal', 'backend', 'worker', 'python', 'node', 'docker', 'tmux', 'process']
  const knownStatuses = ['thinking', 'running', 'waiting', 'idle', 'finished', 'error', 'stopped', 'offline']
  const name = text(value.name, `Agent ${index + 1}`, 100)

  return {
    id: id(value.id, `agent-${index + 1}`),
    projectId,
    name,
    emoji: text(value.emoji, '●', 8),
    color: /^#[0-9a-fA-F]{6}$/.test(value.color ?? '') ? value.color! : COLORS[index % COLORS.length],
    kind: knownKinds.includes(value.kind ?? '') ? value.kind! : 'process',
    terminalTitle: text(value.terminalTitle, name, 120),
    terminalApp: terminal,
    tmuxSession: text(value.tmuxSession, '', 80).replace(/[^a-zA-Z0-9_.-]/g, '-'),
    command: text(value.command, '', 2_000),
    cwd: text(value.cwd, os.homedir(), 1_000),
    matchPattern: text(value.matchPattern, '', 500),
    logPath: text(value.logPath, '', 1_000),
    autoStart: Boolean(value.autoStart),
    order: number(value.order, index, 0, 100_000),
    pid: value.pid == null ? null : number(value.pid, 0, 1, 4_194_304),
    statusOverride:
      value.statusOverride && knownStatuses.includes(value.statusOverride) ? value.statusOverride : null,
  }
}

export function createDefaultState(): ConsoleState {
  const home = os.homedir()
  const projects: Project[] = [
    { id: 'product', name: 'Product', emoji: '◫', color: '#55a6ff', collapsed: false, order: 0 },
    { id: 'sales', name: 'Sales', emoji: '↗', color: '#54c79b', collapsed: false, order: 1 },
    { id: 'management', name: 'Management', emoji: '◆', color: '#a478ff', collapsed: false, order: 2 },
  ]

  const seed = (
    idValue: string,
    projectId: string,
    name: string,
    emoji: string,
    color: string,
    kind: AgentConfig['kind'],
    order: number,
  ): AgentConfig => ({
    id: idValue,
    projectId,
    name,
    emoji,
    color,
    kind,
    terminalTitle: `${emoji} ${name}`,
    terminalApp: 'auto',
    tmuxSession: '',
    command: '',
    cwd: home,
    matchPattern: '',
    logPath: '',
    autoStart: false,
    order,
    pid: null,
    statusOverride: null,
  })

  return {
    version: 1,
    projects,
    agents: [
      seed('product-planner', 'product', 'Product Planner', '◇', '#55a6ff', 'codex', 0),
      seed('prototype-backend', 'product', 'Prototype Backend', '⬡', '#a478ff', 'backend', 1),
      seed('sales-assistant', 'sales', 'Sales Assistant', '↗', '#54c79b', 'codex', 0),
      seed('crm-sync', 'sales', 'CRM Sync', '◉', '#f6b94b', 'worker', 1),
      seed('operations-agent', 'management', 'Operations Agent', '◆', '#a478ff', 'codex', 0),
      seed('reporting-dashboard', 'management', 'Reporting Dashboard', '▰', '#f6b94b', 'backend', 1),
    ],
    settings: {
      defaultTerminal: 'auto',
      scanIntervalMs: 2_500,
      compactMode: true,
      fontSizePx: 25,
      theme: 'navy-gold',
    },
  }
}

export function sanitizeState(value: unknown): ConsoleState {
  if (!value || typeof value !== 'object') return createDefaultState()
  const source = value as Partial<ConsoleState>
  const rawProjects = Array.isArray(source.projects)
    ? source.projects.slice(0, 200).filter((project) => project && typeof project === 'object')
    : []
  const projects = rawProjects.map((project, index) => sanitizeProject(project, index))
  if (projects.length === 0) projects.push({ ...createDefaultState().projects[0], id: 'inbox', name: 'Inbox' })
  const validProjects = new Set(projects.map((project) => project.id))
  const rawAgents = Array.isArray(source.agents)
    ? source.agents.slice(0, 1_000).filter((agent) => agent && typeof agent === 'object')
    : []
  const agents = rawAgents.map((agent, index) => sanitizeAgent(agent, index, validProjects))
  const settings = source.settings ?? createDefaultState().settings

  return {
    version: 1,
    projects,
    agents,
    settings: {
      defaultTerminal: TERMINALS.includes(settings.defaultTerminal as TerminalApp)
        ? settings.defaultTerminal
        : 'auto',
      scanIntervalMs: number(settings.scanIntervalMs, 2_500, 1_000, 30_000),
      compactMode: settings.compactMode !== false,
      fontSizePx: number(settings.fontSizePx, 25, 5, 50),
      theme: THEME_IDS.includes(settings.theme as ThemeId) ? settings.theme as ThemeId : 'navy-gold',
    },
  }
}

type PersistedStateRead =
  | { kind: 'valid'; state: ConsoleState; raw: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; error: Error }

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

function parsePersistedState(raw: string): ConsoleState {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error('Saved state must be an object.')
  const candidate = parsed as Partial<ConsoleState>
  if (candidate.version !== 1) throw new Error('Saved state has an unsupported version.')
  if (!Array.isArray(candidate.projects) || !Array.isArray(candidate.agents)) {
    throw new Error('Saved state is missing its Project or Agent list.')
  }
  if (!candidate.settings || typeof candidate.settings !== 'object') {
    throw new Error('Saved state is missing application settings.')
  }
  const records = [...candidate.projects, ...candidate.agents]
  if (records.some((record) => !record || typeof record !== 'object')) {
    throw new Error('Saved state contains an invalid Project or Agent record.')
  }
  const state = sanitizeState(candidate)
  const projectIds = state.projects.map((project) => project.id)
  const agentIds = state.agents.map((agent) => agent.id)
  if (new Set(projectIds).size !== projectIds.length || new Set(agentIds).size !== agentIds.length) {
    throw new Error('Saved state contains duplicate identifiers.')
  }
  return state
}

export function stateRevision(state: ConsoleState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

export class StateStore {
  private readonly filePath: string
  private readonly backupPath: string
  private state: ConsoleState | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0
  private recoveryNotice: string | null = null

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'mission-control-state.json')
    this.backupPath = `${this.filePath}.bak`
  }

  async load(): Promise<ConsoleState> {
    if (this.state) return structuredClone(this.state)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    await fs.chmod(path.dirname(this.filePath), 0o700)

    const primary = await this.readPersistedState(this.filePath)
    if (primary.kind === 'valid') {
      await fs.chmod(this.filePath, 0o600)
      this.state = primary.state
      return structuredClone(primary.state)
    }

    const backup = await this.readPersistedState(this.backupPath)
    if (backup.kind === 'valid') {
      await fs.chmod(this.backupPath, 0o600)
      if (primary.kind === 'invalid') await this.archiveCorruptFile(this.filePath)
      await this.write(backup.state, false)
      this.state = backup.state
      this.recoveryNotice = 'The main state file was unreadable, so Agent Console restored the last valid backup.'
      return structuredClone(backup.state)
    }

    const preserved: string[] = []
    if (primary.kind === 'invalid') preserved.push(await this.archiveCorruptFile(this.filePath))
    if (backup.kind === 'invalid') preserved.push(await this.archiveCorruptFile(this.backupPath))
    this.state = createDefaultState()
    await this.write(this.state, false)
    if (preserved.length > 0) {
      this.recoveryNotice = `Saved data could not be read. It was preserved as ${preserved.join(' and ')}.`
    }
    return structuredClone(this.state)
  }

  async save(value: unknown): Promise<ConsoleState> {
    const operation = this.writeQueue.then(async () => {
      const serialized = JSON.stringify(value)
      if (typeof serialized !== 'string') throw new Error('Saved state could not be serialized.')
      const next = parsePersistedState(serialized)
      await this.write(next, true)
      this.state = next
      return structuredClone(next)
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async flush(): Promise<void> {
    let pending: Promise<void>
    do {
      pending = this.writeQueue
      await pending
    } while (pending !== this.writeQueue)
  }

  get current(): ConsoleState {
    return structuredClone(this.state ?? createDefaultState())
  }

  get loadNotice(): string | null {
    return this.recoveryNotice
  }

  async createPreCoreSnapshot(label = 'v1'): Promise<string | null> {
    await this.flush()
    const snapshotPath = path.join(path.dirname(this.filePath), `mission-control-state.pre-core-${label}.json`)
    try {
      await fs.access(snapshotPath)
      await fs.chmod(snapshotPath, 0o600)
      return snapshotPath
    } catch {
      // Create the migration checkpoint exactly once.
    }
    const primary = await this.readPersistedState(this.filePath)
    if (primary.kind !== 'valid') return null
    const temporary = this.temporaryPath(snapshotPath)
    try {
      await this.durableWrite(temporary, primary.raw)
      await fs.rename(temporary, snapshotPath)
      await this.syncDirectory()
      return snapshotPath
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }

  private async readPersistedState(filePath: string): Promise<PersistedStateRead> {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      return { kind: 'valid', state: parsePersistedState(raw), raw }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
      if (error instanceof SyntaxError || error instanceof Error && !errorCode(error)) {
        return { kind: 'invalid', error }
      }
      throw error
    }
  }

  private temporaryPath(target: string): string {
    this.writeSequence += 1
    return `${target}.${process.pid}-${Date.now()}-${this.writeSequence}.tmp`
  }

  private async durableWrite(filePath: string, contents: string): Promise<void> {
    await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await fs.open(filePath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async archiveCorruptFile(filePath: string): Promise<string> {
    const archivePath = `${filePath}.corrupt-${Date.now()}-${this.writeSequence + 1}`
    await fs.rename(filePath, archivePath)
    await fs.chmod(archivePath, 0o600)
    return path.basename(archivePath)
  }

  private async syncDirectory(): Promise<void> {
    const handle = await fs.open(path.dirname(this.filePath), 'r')
    try {
      await handle.sync()
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(errorCode(error))) throw error
    } finally {
      await handle.close()
    }
  }

  private async write(state: ConsoleState, rotateBackup: boolean): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    await fs.chmod(path.dirname(this.filePath), 0o700).catch(() => undefined)
    const primaryTemporaryPath = this.temporaryPath(this.filePath)
    const backupTemporaryPath = this.temporaryPath(this.backupPath)
    try {
      await this.durableWrite(primaryTemporaryPath, `${JSON.stringify(state, null, 2)}\n`)

      if (rotateBackup) {
        const current = await this.readPersistedState(this.filePath)
        if (current.kind === 'valid') {
          await this.durableWrite(backupTemporaryPath, current.raw)
          await fs.rename(backupTemporaryPath, this.backupPath)
        } else if (current.kind === 'invalid') {
          await this.archiveCorruptFile(this.filePath)
        }
      }

      await fs.rename(primaryTemporaryPath, this.filePath)
      await this.syncDirectory()
    } finally {
      await Promise.allSettled([
        fs.rm(primaryTemporaryPath, { force: true }),
        fs.rm(backupTemporaryPath, { force: true }),
      ])
    }
  }
}
