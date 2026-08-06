import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  AgentConfig,
  AgentKind,
  ConsoleState,
  DiscoveredItem,
  ProcessInfo,
  RuntimeAgent,
  RuntimeSnapshot,
  TmuxPaneInfo,
} from '../../shared/types'
import { classifyProcess, inferStatus, suggestedPresentation } from './classification'
import { SystemManager } from './system-manager'

const execFileAsync = promisify(execFile)
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

function cleanOutput(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(/\r/g, '').trim()
}

function lastMeaningfulLine(value: string): string {
  const lines = cleanOutput(value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^[─━═\s]+$/.test(line))
  return (lines.at(-1) ?? '').slice(-500)
}

export function parsePsOutput(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/)
    if (!match) continue
    const [, pid, ppid, cpu, memory, runtime, state, tty, command, args] = match
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpu: Number(cpu) || 0,
      memory: Number(memory) || 0,
      runtimeSeconds: Number(runtime) || 0,
      processState: state,
      tty,
      command,
      args: args || command,
      cwd: '',
      kind: classifyProcess(command, args || command),
    })
  }
  return processes
}

export function parseTmuxOutput(output: string): TmuxPaneInfo[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [session, window, paneId, panePid, currentCommand, cwd, active, dead, activityAt] = line.split('\t')
      return {
        session: session ?? '',
        window: window ?? '',
        paneId: paneId ?? '',
        panePid: Number(panePid) || 0,
        currentCommand: currentCommand ?? '',
        cwd: cwd ?? '',
        active: active === '1',
        dead: dead === '1',
        activityAt: Number(activityAt) || 0,
        lastOutput: '',
      }
    })
    .filter((pane) => pane.session && pane.paneId)
}

async function readCwd(pid: number): Promise<string> {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`)
  } catch {
    return ''
  }
}

async function readFileTail(filePath: string, bytes = 16_384): Promise<string> {
  if (!filePath) return ''
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const stats = await handle.stat()
    const length = Math.min(bytes, stats.size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length))
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function safeRegex(pattern: string): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

function commandToken(command: string): string {
  const raw = command.trim().split(/\s+/)[0] ?? ''
  return path.basename(raw).replace(/^['"]|['"]$/g, '')
}

function processDescendants(rootPid: number, processes: ProcessInfo[]): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>()
  for (const processInfo of processes) {
    const siblings = children.get(processInfo.ppid) ?? []
    siblings.push(processInfo)
    children.set(processInfo.ppid, siblings)
  }
  const result: ProcessInfo[] = []
  const queue = [...(children.get(rootPid) ?? [])]
  const seen = new Set<number>()
  while (queue.length) {
    const next = queue.shift()!
    if (seen.has(next.pid)) continue
    seen.add(next.pid)
    result.push(next)
    queue.push(...(children.get(next.pid) ?? []))
  }
  return result
}

function bestPaneProcess(pane: TmuxPaneInfo, processes: ProcessInfo[]): ProcessInfo | null {
  const root = processes.find((item) => item.pid === pane.panePid) ?? null
  const descendants = processDescendants(pane.panePid, processes)
  const preferred = descendants
    .filter((item) => item.kind && item.kind !== 'terminal' && item.kind !== 'tmux')
    .sort((a, b) => b.cpu - a.cpu || b.pid - a.pid)
  return preferred[0] ?? descendants.at(-1) ?? root
}

function matchesWorkingDirectory(processInfo: ProcessInfo, agent: AgentConfig): boolean {
  if (!agent.cwd || !processInfo.cwd) return true
  return path.resolve(processInfo.cwd) === path.resolve(agent.cwd)
}

function findAgentProcess(
  agent: AgentConfig,
  processes: ProcessInfo[],
  panes: TmuxPaneInfo[],
): { processInfo: ProcessInfo | null; pane: TmuxPaneInfo | null } {
  if (agent.tmuxSession) {
    const pane = panes.find((item) => item.session === agent.tmuxSession) ?? null
    return { processInfo: pane ? bestPaneProcess(pane, processes) : null, pane }
  }
  if (agent.pid) {
    const processInfo = processes.find((item) => item.pid === agent.pid) ?? null
    if (processInfo) {
      const matcher = safeRegex(agent.matchPattern)
      const token = commandToken(agent.command)
      const kindMatches = agent.kind === 'process' || !processInfo.kind || processInfo.kind === agent.kind
      const commandMatches = matcher
        ? matcher.test(`${processInfo.command} ${processInfo.args}`)
        : token
          ? path.basename(processInfo.command) === token
          : kindMatches
      if (kindMatches && commandMatches && matchesWorkingDirectory(processInfo, agent)) {
        return { processInfo, pane: null }
      }
    }
  }
  const matcher = safeRegex(agent.matchPattern)
  if (matcher) {
    const candidates = processes.filter(
      (item) => matcher.test(`${item.command} ${item.args}`) && matchesWorkingDirectory(item, agent),
    )
    if (candidates.length) return { processInfo: candidates.sort((a, b) => b.pid - a.pid)[0], pane: null }
  }
  const token = commandToken(agent.command)
  if (token) {
    const candidate = processes.find(
      (item) => path.basename(item.command) === token && matchesWorkingDirectory(item, agent),
    )
    if (candidate) return { processInfo: candidate, pane: null }
  }
  return { processInfo: null, pane: null }
}

function isPotentialMatch(processInfo: ProcessInfo, state: ConsoleState): boolean {
  if (processInfo.kind) return true
  return state.agents.some((agent) => {
    if (agent.pid === processInfo.pid) return true
    const matcher = safeRegex(agent.matchPattern)
    return matcher?.test(`${processInfo.command} ${processInfo.args}`) ?? false
  })
}

async function listProcesses(state: ConsoleState): Promise<ProcessInfo[]> {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : process.env.USER ?? ''
  const { stdout } = await execFileAsync(
    'ps',
    ['-u', uid, '-o', 'pid=,ppid=,pcpu=,pmem=,etimes=,stat=,tty=,comm=,args=', '--no-headers'],
    { timeout: 3_000, maxBuffer: 4_000_000 },
  )
  const processes = parsePsOutput(stdout)
  await Promise.all(
    processes.filter((item) => isPotentialMatch(item, state)).map(async (item) => {
      item.cwd = await readCwd(item.pid)
    }),
  )
  return processes
}

async function listTmuxPanes(enabled: boolean, captureSessions: Set<string> | null): Promise<TmuxPaneInfo[]> {
  if (!enabled) return []
  try {
    const format = [
      '#{session_name}',
      '#{window_name}',
      '#{pane_id}',
      '#{pane_pid}',
      '#{pane_current_command}',
      '#{pane_current_path}',
      '#{pane_active}',
      '#{pane_dead}',
      '#{pane_activity}',
    ].join('\t')
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', format], {
      timeout: 2_500,
      maxBuffer: 1_000_000,
    })
    const panes = parseTmuxOutput(stdout)
    await Promise.all(
      panes.map(async (pane) => {
        if (captureSessions && !captureSessions.has(pane.session)) return
        try {
          const { stdout: paneOutput } = await execFileAsync(
            'tmux',
            ['capture-pane', '-p', '-t', pane.paneId, '-S', '-30'],
            { timeout: 1_500, maxBuffer: 300_000 },
          )
          pane.lastOutput = paneOutput
        } catch {
          pane.lastOutput = ''
        }
      }),
    )
    return panes
  } catch {
    return []
  }
}

function displayName(processInfo: ProcessInfo): string {
  const location = processInfo.cwd ? path.basename(processInfo.cwd) : ''
  switch (processInfo.kind) {
    case 'codex':
      return location ? `Codex · ${location}` : 'Codex'
    case 'backend':
      return location ? `Backend · ${location}` : 'Backend'
    case 'worker':
      return location ? `Worker · ${location}` : 'Worker'
    case 'python':
      return location ? `Python · ${location}` : 'Python'
    case 'node':
      return location ? `Node · ${location}` : 'Node'
    case 'terminal':
      return processInfo.command
    default:
      return processInfo.command || `Process ${processInfo.pid}`
  }
}

async function listDockerContainers(enabled: boolean): Promise<DiscoveredItem[]> {
  if (!enabled) return []
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}'],
      { timeout: 2_500, maxBuffer: 1_000_000 },
    )
    const presentation = suggestedPresentation('docker')
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [containerId, name, status, image] = line.split('\t')
        return {
          id: `docker-${containerId}`,
          name,
          suggestedName: name,
          ...presentation,
          kind: 'docker' as const,
          pid: null,
          ppid: null,
          cpu: 0,
          memory: 0,
          runtimeSeconds: 0,
          command: image,
          args: image,
          cwd: '',
          tmuxSession: '',
          terminalTitle: `▣ ${name}`,
          lastOutput: status,
          status: 'running' as const,
        }
      })
  } catch {
    return []
  }
}

function buildDiscovered(
  processes: ProcessInfo[],
  panes: TmuxPaneInfo[],
  configuredAgents: RuntimeAgent[],
): DiscoveredItem[] {
  const configuredPids = new Set(configuredAgents.map((agent) => agent.pid).filter((pid): pid is number => Boolean(pid)))
  const configuredSessions = new Set(configuredAgents.map((agent) => agent.tmuxSession).filter(Boolean))
  const paneProcessPids = new Set<number>()
  const discovered: DiscoveredItem[] = []

  for (const pane of panes) {
    const processInfo = bestPaneProcess(pane, processes)
    if (processInfo) {
      paneProcessPids.add(processInfo.pid)
      for (const descendant of processDescendants(pane.panePid, processes)) paneProcessPids.add(descendant.pid)
    }
    if (configuredSessions.has(pane.session)) continue
    const kind: AgentKind = processInfo?.kind ?? (pane.currentCommand === 'codex' ? 'codex' : 'tmux')
    const presentation = suggestedPresentation(kind)
    const name = kind === 'codex' ? `Codex · ${pane.session}` : `${pane.session} · ${pane.window}`
    discovered.push({
      id: `tmux-${pane.session}-${pane.paneId.replace('%', '')}`,
      name,
      suggestedName: name,
      ...presentation,
      kind,
      pid: processInfo?.pid ?? pane.panePid,
      ppid: processInfo?.ppid ?? null,
      cpu: processInfo?.cpu ?? 0,
      memory: processInfo?.memory ?? 0,
      runtimeSeconds: processInfo?.runtimeSeconds ?? 0,
      command: processInfo?.command ?? pane.currentCommand,
      args: processInfo?.args ?? pane.currentCommand,
      cwd: pane.cwd || processInfo?.cwd || '',
      tmuxSession: pane.session,
      terminalTitle: `${presentation.emoji} ${name}`,
      lastOutput: lastMeaningfulLine(pane.lastOutput),
      status: inferStatus(processInfo, pane.lastOutput, kind, null, pane.activityAt),
    })
  }

  for (const processInfo of processes) {
    if (!processInfo.kind || configuredPids.has(processInfo.pid) || paneProcessPids.has(processInfo.pid)) continue
    const presentation = suggestedPresentation(processInfo.kind)
    const name = displayName(processInfo)
    discovered.push({
      id: `process-${processInfo.pid}`,
      name,
      suggestedName: name,
      ...presentation,
      kind: processInfo.kind,
      pid: processInfo.pid,
      ppid: processInfo.ppid,
      cpu: processInfo.cpu,
      memory: processInfo.memory,
      runtimeSeconds: processInfo.runtimeSeconds,
      command: processInfo.command,
      args: processInfo.args,
      cwd: processInfo.cwd,
      tmuxSession: '',
      terminalTitle: `${presentation.emoji} ${name}`,
      lastOutput: processInfo.args.slice(-500),
      status: inferStatus(processInfo, '', processInfo.kind),
    })
  }
  return discovered.sort((a, b) => {
    const rank: Record<AgentKind, number> = {
      codex: 0,
      backend: 1,
      worker: 2,
      tmux: 3,
      python: 4,
      node: 5,
      docker: 6,
      terminal: 7,
      process: 8,
    }
    return rank[a.kind] - rank[b.kind] || b.cpu - a.cpu
  })
}

async function buildRuntimeAgents(
  state: ConsoleState,
  processes: ProcessInfo[],
  panes: TmuxPaneInfo[],
): Promise<RuntimeAgent[]> {
  const capturedAt = new Date().toISOString()
  return Promise.all(
    state.agents.map(async (agent) => {
      const { processInfo, pane } = findAgentProcess(agent, processes, panes)
      const logOutput = await readFileTail(agent.logPath)
      const rawOutput = logOutput || pane?.lastOutput || ''
      return {
        ...agent,
        pid: processInfo?.pid ?? agent.pid ?? null,
        cpu: processInfo?.cpu ?? 0,
        memory: processInfo?.memory ?? 0,
        runtimeSeconds: processInfo?.runtimeSeconds ?? 0,
        status: inferStatus(processInfo, rawOutput, agent.kind, agent.statusOverride, pane?.activityAt),
        lastUpdated: capturedAt,
        lastOutput: lastMeaningfulLine(rawOutput) || (processInfo ? processInfo.args.slice(-500) : 'No live process matched'),
        processName: processInfo?.command ?? '',
        processState: processInfo?.processState ?? '',
        terminalOpen: false,
      }
    }),
  )
}

export class ProcessMonitor {
  private timer: NodeJS.Timeout | null = null
  private scanPromise: Promise<RuntimeSnapshot> | null = null
  private rescanRequested = false
  private rescanWithDiscovery = false
  private activeClients = 0
  private snapshot: RuntimeSnapshot | null = null
  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>()

  constructor(
    private readonly stateProvider: () => ConsoleState,
    private readonly system: SystemManager,
  ) {}

  start(): void {
    this.stop()
    const configured = this.stateProvider().settings.scanIntervalMs
    const interval = this.activeClients > 0 ? configured : Math.max(configured, 30_000)
    this.timer = setInterval(() => void this.scan(false), interval)
    this.timer.unref()
  }

  restart(): void {
    this.start()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setActiveClients(count: number): void {
    const next = Math.max(0, Math.floor(count))
    if ((this.activeClients > 0) === (next > 0)) {
      this.activeClients = next
      return
    }
    this.activeClients = next
    this.restart()
  }

  get current(): RuntimeSnapshot | null {
    return this.snapshot ? structuredClone(this.snapshot) : null
  }

  async scan(includeDiscovery = this.activeClients > 0): Promise<RuntimeSnapshot> {
    if (this.scanPromise) {
      this.rescanRequested = true
      this.rescanWithDiscovery = this.rescanWithDiscovery || includeDiscovery
      return this.scanPromise
    }
    this.rescanRequested = true
    this.rescanWithDiscovery = includeDiscovery
    this.scanPromise = this.drainScans().finally(() => {
      this.scanPromise = null
    })
    return this.scanPromise
  }

  private async drainScans(): Promise<RuntimeSnapshot> {
    let latest: RuntimeSnapshot | null = null
    while (this.rescanRequested) {
      const includeDiscovery = this.rescanWithDiscovery
      this.rescanRequested = false
      this.rescanWithDiscovery = false
      const snapshot = await this.performScan(includeDiscovery)
      this.snapshot = snapshot
      for (const listener of this.listeners) listener(structuredClone(snapshot))
      latest = snapshot
    }
    if (!latest) throw new Error('Process scan queue finished without a snapshot.')
    return structuredClone(latest)
  }

  private async performScan(includeDiscovery: boolean): Promise<RuntimeSnapshot> {
    const state = this.stateProvider()
    const capabilities = await this.system.getCapabilities()
    let scanError: string | null = null
    let processes: ProcessInfo[] = []
    try {
      processes = await listProcesses(state)
    } catch (error) {
      scanError = error instanceof Error ? error.message : String(error)
    }
    const configuredSessions = new Set(state.agents.map((agent) => agent.tmuxSession).filter(Boolean))
    const [panes, dockerItems] = await Promise.all([
      listTmuxPanes(capabilities.tmux, includeDiscovery ? null : configuredSessions),
      includeDiscovery ? listDockerContainers(capabilities.docker) : Promise.resolve([]),
    ])
    const agents = await buildRuntimeAgents(state, processes, panes)
    const discovered = includeDiscovery ? [...buildDiscovered(processes, panes, agents), ...dockerItems] : []
    return {
      capturedAt: new Date().toISOString(),
      agents,
      discovered,
      capabilities,
      scanError,
    }
  }
}
