import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import type {
  ActionResult,
  AgentConfig,
  ConsoleSettings,
  DiscoveredItem,
  SystemCapabilities,
  TerminalApp,
} from '../../shared/types'

const execFileAsync = promisify(execFile)
const SUPPORTED_TERMINALS: Exclude<TerminalApp, 'auto'>[] = [
  'ghostty',
  'gnome-terminal',
  'kitty',
  'konsole',
  'xfce4-terminal',
  'x-terminal-emulator',
]

interface ExecOptions {
  timeout: number
  maxBuffer?: number
}

interface ExecResult {
  stdout: string
  stderr: string
}

export interface TerminalManagerDependencies {
  execFile: (executable: string, args: string[], options: ExecOptions) => Promise<ExecResult>
  spawnDetached: (executable: string, args: string[]) => void
  readlink: (target: string) => Promise<string>
  writeFile: (target: string, data: string) => Promise<void>
  processAlive: (pid: number) => boolean
  delay: (milliseconds: number) => Promise<void>
}

export interface DesktopWindowRecord {
  id: string
  pid: number | null
  title: string
}

export interface ExternalWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export function centeredWindowBounds(workArea: ExternalWindowBounds): ExternalWindowBounds {
  const width = Math.floor(workArea.width * 3 / 5)
  const height = Math.floor(workArea.height * 3 / 5)
  return {
    width,
    height,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
  }
}

const defaultDependencies: TerminalManagerDependencies = {
  execFile: async (executable, args, options) => {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      ...options,
      encoding: 'utf8',
    })
    return { stdout: String(stdout), stderr: String(stderr) }
  },
  spawnDetached: (executable, args) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' })
    child.unref()
  },
  readlink: (target) => fs.readlink(target),
  writeFile: async (target, data) => {
    await fs.writeFile(target, data, { flag: 'a' })
  },
  processAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function safeTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function exactWindowNamePattern(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
}

export function terminalWindowIdentity(agentId: string): string {
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  return `[AC:${digest}]`
}

export function windowTitle(agent: AgentConfig): string {
  const label = safeTitle(agent.terminalTitle || `${agent.emoji} ${agent.name}`).slice(0, 88) || 'Agent'
  return `Agent Console · ${label} · ${terminalWindowIdentity(agent.id)}`
}

export function parseWmctrlWindows(output: string): DesktopWindowRecord[] {
  const windows: DesktopWindowRecord[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\S+)\s+\S+\s+(-?\d+)\s+\S+\s+(.*)$/)
    if (!match) continue
    windows.push({
      id: match[1],
      pid: Number(match[2]) > 0 ? Number(match[2]) : null,
      title: match[3],
    })
  }
  return windows
}

export class TerminalManager {
  private capabilities: SystemCapabilities | null = null
  private readonly knownOpenAgents = new Map<string, string>()
  private readonly windowIdByAgent = new Map<string, string>()
  private readonly dependencies: TerminalManagerDependencies
  private settings: ConsoleSettings

  constructor(settings: ConsoleSettings, dependencies: Partial<TerminalManagerDependencies> = {}) {
    this.settings = settings
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }

  updateSettings(settings: ConsoleSettings): void {
    this.settings = settings
  }

  async getCapabilities(force = false): Promise<SystemCapabilities> {
    if (this.capabilities && !force) return this.capabilities
    const checks = await Promise.all([
      ...SUPPORTED_TERMINALS.map(async (terminal) => [terminal, await this.exists(terminal)] as const),
      this.exists('tmux'),
      this.exists('wmctrl'),
      this.exists('xdotool'),
      this.exists('docker'),
    ])
    const terminalChecks = checks.slice(0, SUPPORTED_TERMINALS.length) as Array<readonly [TerminalApp, boolean]>
    const [tmux, wmctrl, xdotool, docker] = checks.slice(SUPPORTED_TERMINALS.length) as boolean[]
    this.capabilities = {
      platform: process.platform,
      terminals: terminalChecks.filter(([, available]) => available).map(([terminal]) => terminal),
      tmux,
      wmctrl,
      xdotool,
      docker,
      homeDirectory: os.homedir(),
    }
    return this.capabilities
  }

  async listOpenAgentIds(agents: AgentConfig[]): Promise<Set<string>> {
    const capabilities = await this.getCapabilities()
    if (capabilities.wmctrl) {
      const windows = await this.listWmctrlWindows()
      if (windows) {
        const open = new Set<string>()
        const windowIds = new Set(windows.map((item) => item.id))
        for (const agent of agents) {
          const exact = windows.find((item) => item.title === windowTitle(agent))
          if (exact) this.windowIdByAgent.set(agent.id, exact.id)
          const knownId = exact?.id ?? this.windowIdByAgent.get(agent.id)
          if (knownId && windowIds.has(knownId)) open.add(agent.id)
          else this.windowIdByAgent.delete(agent.id)
        }
        return open
      }
    }

    if (capabilities.xdotool) {
      const open = new Set<string>()
      await Promise.all(agents.map(async (agent) => {
        const id = await this.findOpenXdotoolWindow(agent, windowTitle(agent))
        if (id) open.add(agent.id)
      }))
      return open
    }

    return new Set(agents.filter((agent) => this.knownOpenAgents.has(agent.id)).map((agent) => agent.id))
  }

  async open(agent: AgentConfig, bounds?: ExternalWindowBounds): Promise<ActionResult> {
    const title = windowTitle(agent)
    await this.applyTitleToExistingTerminal(agent, title)
    if (await this.focus(agent, title, bounds)) {
      this.knownOpenAgents.set(agent.id, title)
      return { ok: true, action: 'focused', message: `${agent.name} terminal focused` }
    }
    const capabilities = await this.getCapabilities()
    if (this.knownOpenAgents.has(agent.id) && !capabilities.wmctrl && !capabilities.xdotool) {
      return {
        ok: true,
        action: 'already-open',
        message: `${agent.name} terminal is already open, but automatic focus is unavailable`,
      }
    }

    if (agent.pid && !agent.tmuxSession && this.isProcessAlive(agent.pid)) {
      return {
        ok: false,
        action: 'focus-unavailable',
        message: `The ${agent.name} process is running, but Agent Console could not identify its exact terminal window.`,
      }
    }

    const terminal = this.selectTerminal(agent, capabilities.terminals)
    if (!terminal) {
      return {
        ok: false,
        action: 'unavailable',
        message: 'No supported terminal was found. Install GNOME Terminal, Kitty, or Ghostty.',
      }
    }

    let terminalCommand: string
    if (agent.tmuxSession) {
      terminalCommand = `exec tmux attach-session -t ${shellQuote(agent.tmuxSession)}`
    } else {
      const cwd = agent.cwd || os.homedir()
      const command = agent.command.trim()
      terminalCommand = `cd -- ${shellQuote(cwd)}; ${command ? `${command}; ` : ''}exec ${shellQuote(process.env.SHELL || '/bin/bash')}`
    }

    try {
      const { executable, args } = this.terminalInvocation(terminal, title, terminalCommand)
      this.dependencies.spawnDetached(executable, args)
      this.knownOpenAgents.set(agent.id, title)
      if (bounds) {
        await this.dependencies.delay(120)
        await this.focus(agent, title, bounds, 20)
      }
      return { ok: true, action: 'opened', message: `${agent.name} opened in ${terminal}` }
    } catch (error) {
      return { ok: false, action: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async close(agent: AgentConfig): Promise<ActionResult> {
    const title = windowTitle(agent)
    const capabilities = await this.getCapabilities()
    await this.applyTitleToExistingTerminal(agent, title)
    try {
      if (capabilities.wmctrl) {
        const target = await this.findWmctrlWindow(agent, title, 5)
        if (!target) throw new Error('Terminal window not found')
        await this.dependencies.execFile('wmctrl', ['-i', '-c', target.id], { timeout: 2_000 })
      } else if (capabilities.xdotool) {
        const id = await this.findXdotoolWindow(agent, title)
        if (!id) throw new Error('Terminal window not found')
        await this.dependencies.execFile('xdotool', ['windowclose', id], { timeout: 1_500 })
      } else {
        return {
          ok: false,
          action: 'unavailable',
          message: 'Install wmctrl to let Agent Console close external terminal windows.',
        }
      }
      this.forgetWindow(agent.id)
      return {
        ok: true,
        action: 'closed',
        message: `${agent.name} terminal closed; its tmux session keeps running`,
      }
    } catch {
      this.forgetWindow(agent.id)
      return { ok: false, action: 'not-found', message: `${agent.name} terminal window was not found` }
    }
  }

  async focusDiscovered(item: DiscoveredItem, bounds: ExternalWindowBounds): Promise<ActionResult> {
    if (!item.pid || !this.isProcessAlive(item.pid)) {
      return { ok: false, action: 'not-found', message: 'This discovered process is no longer running.' }
    }
    const transientAgent: AgentConfig = {
      id: `discovery-${item.id}-${item.pid}`,
      projectId: '',
      name: item.name,
      emoji: '',
      color: item.color,
      kind: item.kind,
      terminalTitle: item.terminalTitle,
      terminalApp: 'auto',
      tmuxSession: item.tmuxSession,
      command: '',
      cwd: item.cwd,
      note: '',
      goal: '',
      matchPattern: '',
      logPath: '',
      autoStart: false,
      order: 0,
      pid: item.pid,
      statusOverride: null,
    }
    const title = `Agent Console · Discover · ${terminalWindowIdentity(transientAgent.id)}`
    await this.applyTitleToExistingTerminal(transientAgent, title)
    if (await this.focus(transientAgent, title, bounds, 12)) {
      return { ok: true, action: 'focused', message: 'Discovered process window focused.' }
    }
    return {
      ok: false,
      action: 'focus-unavailable',
      message: 'The process is running, but its exact desktop window could not be focused.',
    }
  }

  private async exists(command: string): Promise<boolean> {
    try {
      await this.dependencies.execFile('which', [command], { timeout: 1_500 })
      return true
    } catch {
      return false
    }
  }

  private forgetWindow(agentId: string): void {
    this.knownOpenAgents.delete(agentId)
    this.windowIdByAgent.delete(agentId)
  }

  private selectTerminal(agent: AgentConfig, available: TerminalApp[]): TerminalApp | null {
    const preferred = agent.terminalApp === 'auto' ? this.settings.defaultTerminal : agent.terminalApp
    if (preferred !== 'auto' && available.includes(preferred)) return preferred
    return available[0] ?? null
  }

  private terminalInvocation(terminal: TerminalApp, title: string, command: string): { executable: string; args: string[] } {
    switch (terminal) {
      case 'gnome-terminal':
        return { executable: terminal, args: ['--title', title, '--', 'bash', '-lc', command] }
      case 'kitty':
        return { executable: terminal, args: ['--title', title, 'bash', '-lc', command] }
      case 'ghostty':
        return { executable: terminal, args: [`--title=${title}`, '-e', 'bash', '-lc', command] }
      case 'konsole':
        return { executable: terminal, args: ['--new-tab', '-p', `tabtitle=${title}`, '-e', 'bash', '-lc', command] }
      case 'xfce4-terminal':
        return { executable: terminal, args: ['--title', title, '--command', `bash -lc ${shellQuote(command)}`] }
      case 'x-terminal-emulator':
        return { executable: terminal, args: ['-T', title, '-e', 'bash', '-lc', command] }
      default:
        throw new Error(`Unsupported terminal: ${terminal}`)
    }
  }

  private async focus(
    agent: AgentConfig,
    title: string,
    bounds?: ExternalWindowBounds,
    attempts = 5,
  ): Promise<boolean> {
    const capabilities = await this.getCapabilities()
    if (capabilities.wmctrl) {
      try {
        const target = await this.findWmctrlWindow(agent, title, attempts)
        if (target) {
          if (bounds) {
            await this.dependencies.execFile('wmctrl', ['-i', '-r', target.id, '-b', 'remove,maximized_vert,maximized_horz'], { timeout: 1_500 })
            await this.dependencies.execFile('wmctrl', ['-i', '-r', target.id, '-b', 'remove,fullscreen'], { timeout: 1_500 })
            await this.dependencies.execFile(
              'wmctrl',
              ['-i', '-r', target.id, '-e', `0,${bounds.x},${bounds.y},${bounds.width},${bounds.height}`],
              { timeout: 1_500 },
            )
          }
          await this.dependencies.execFile('wmctrl', ['-i', '-a', target.id], { timeout: 1_500 })
          this.windowIdByAgent.set(agent.id, target.id)
          return true
        }
      } catch {
        // Fall through to xdotool when both helpers are available.
      }
    }
    if (capabilities.xdotool) {
      try {
        const id = await this.findXdotoolWindow(agent, title)
        if (!id) return false
        if (bounds) {
          await this.dependencies.execFile('xdotool', ['windowsize', id, String(bounds.width), String(bounds.height)], { timeout: 1_500 })
          await this.dependencies.execFile('xdotool', ['windowmove', id, String(bounds.x), String(bounds.y)], { timeout: 1_500 })
        }
        await this.dependencies.execFile('xdotool', ['windowactivate', '--sync', id], { timeout: 1_500 })
        this.windowIdByAgent.set(agent.id, id)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  private async listWmctrlWindows(): Promise<DesktopWindowRecord[] | null> {
    try {
      const { stdout } = await this.dependencies.execFile('wmctrl', ['-lp'], {
        timeout: 1_500,
        maxBuffer: 512_000,
      })
      return parseWmctrlWindows(stdout)
    } catch {
      return null
    }
  }

  private async findWmctrlWindow(
    agent: AgentConfig,
    title: string,
    attempts: number,
  ): Promise<DesktopWindowRecord | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const windows = await this.listWmctrlWindows()
      if (!windows) return null
      const exact = windows.find((item) => item.title === title)
      if (exact) {
        this.windowIdByAgent.set(agent.id, exact.id)
        return exact
      }
      if (attempt + 1 < attempts) await this.dependencies.delay(45)
    }
    return null
  }

  private async findXdotoolWindow(agent: AgentConfig, title: string): Promise<string | null> {
    const knownId = this.windowIdByAgent.get(agent.id)
    if (knownId) {
      try {
        const { stdout } = await this.dependencies.execFile('xdotool', ['getwindowname', knownId], { timeout: 1_000 })
        if (stdout.trim() === title) return knownId
      } catch {
        this.windowIdByAgent.delete(agent.id)
      }
    }
    try {
      const { stdout } = await this.dependencies.execFile(
        'xdotool',
        ['search', '--onlyvisible', '--name', exactWindowNamePattern(title)],
        { timeout: 1_500, maxBuffer: 256_000 },
      )
      const id = stdout.trim().split('\n').find(Boolean) ?? null
      if (id) this.windowIdByAgent.set(agent.id, id)
      return id
    } catch {
      return null
    }
  }

  private async findOpenXdotoolWindow(agent: AgentConfig, title: string): Promise<string | null> {
    const knownId = this.windowIdByAgent.get(agent.id)
    if (knownId) {
      try {
        await this.dependencies.execFile('xdotool', ['getwindowname', knownId], { timeout: 1_000 })
        return knownId
      } catch {
        this.windowIdByAgent.delete(agent.id)
      }
    }
    return this.findXdotoolWindow(agent, title)
  }

  private isProcessAlive(pid: number): boolean {
    return this.dependencies.processAlive(pid)
  }

  private async applyTitleToExistingTerminal(agent: AgentConfig, title: string): Promise<void> {
    if (!agent.pid || !this.isProcessAlive(agent.pid)) return
    try {
      const stdoutTarget = await this.dependencies.readlink(`/proc/${agent.pid}/fd/1`)
      if (!stdoutTarget.startsWith('/dev/pts/')) return
      await this.dependencies.writeFile(stdoutTarget, `\u001b]0;${safeTitle(title)}\u0007`)
    } catch {
      // Some processes do not own an interactive TTY. They remain manageable by PID.
    }
  }
}
