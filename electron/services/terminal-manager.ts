import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import type {
  ActionResult,
  AgentConfig,
  ConsoleSettings,
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

async function exists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: 1_500 })
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function safeTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
}

export function windowTitle(agent: AgentConfig): string {
  return `Agent Console · ${safeTitle(agent.terminalTitle || `${agent.emoji} ${agent.name}`)}`
}

export class TerminalManager {
  private capabilities: SystemCapabilities | null = null
  private readonly knownOpenTitles = new Set<string>()
  private settings: ConsoleSettings

  constructor(settings: ConsoleSettings) {
    this.settings = settings
  }

  updateSettings(settings: ConsoleSettings): void {
    this.settings = settings
  }

  async getCapabilities(force = false): Promise<SystemCapabilities> {
    if (this.capabilities && !force) return this.capabilities
    const checks = await Promise.all([
      ...SUPPORTED_TERMINALS.map(async (terminal) => [terminal, await exists(terminal)] as const),
      exists('tmux'),
      exists('wmctrl'),
      exists('xdotool'),
      exists('docker'),
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

  async listWindowTitles(): Promise<string[]> {
    const capabilities = await this.getCapabilities()
    if (!capabilities.wmctrl) return [...this.knownOpenTitles]
    try {
      const { stdout } = await execFileAsync('wmctrl', ['-l'], { timeout: 1_500, maxBuffer: 512_000 })
      return stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/, 4).length >= 4 ? line.trim().replace(/^\S+\s+\S+\s+\S+\s+/, '') : '')
        .filter(Boolean)
    } catch {
      return [...this.knownOpenTitles]
    }
  }

  async open(agent: AgentConfig): Promise<ActionResult> {
    const title = windowTitle(agent)
    await this.applyTitleToExistingTerminal(agent, title)
    if (await this.focus(title)) {
      this.knownOpenTitles.add(title)
      return { ok: true, action: 'focused', message: `${agent.name} terminal focused` }
    }
    if (this.knownOpenTitles.has(title)) {
      return {
        ok: true,
        action: 'already-open',
        message: `${agent.name} terminal is already open; install wmctrl for automatic focus`,
      }
    }

    if (agent.pid && !agent.tmuxSession && this.isProcessAlive(agent.pid)) {
      return {
        ok: false,
        action: 'focus-unavailable',
        message: `The ${agent.name} process is running, but its terminal window could not be focused. Install wmctrl and try again.`,
      }
    }

    const capabilities = await this.getCapabilities()
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
      const child = spawn(executable, args, { detached: true, stdio: 'ignore' })
      child.unref()
      this.knownOpenTitles.add(title)
      return { ok: true, action: 'opened', message: `${agent.name} opened in ${terminal}` }
    } catch (error) {
      return { ok: false, action: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async close(agent: AgentConfig): Promise<ActionResult> {
    const title = windowTitle(agent)
    const capabilities = await this.getCapabilities()
    try {
      if (capabilities.wmctrl) {
        await execFileAsync('wmctrl', ['-c', title], { timeout: 2_000 })
      } else if (capabilities.xdotool) {
        const { stdout } = await execFileAsync('xdotool', ['search', '--name', title], { timeout: 1_500 })
        const id = stdout.trim().split('\n')[0]
        if (!id) throw new Error('Terminal window not found')
        await execFileAsync('xdotool', ['windowclose', id], { timeout: 1_500 })
      } else {
        return {
          ok: false,
          action: 'unavailable',
          message: 'Install wmctrl to let Agent Console close external terminal windows.',
        }
      }
      this.knownOpenTitles.delete(title)
      return {
        ok: true,
        action: 'closed',
        message: `${agent.name} terminal closed; its tmux session keeps running`,
      }
    } catch {
      this.knownOpenTitles.delete(title)
      return { ok: false, action: 'not-found', message: `${agent.name} terminal window was not found` }
    }
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

  private async focus(title: string): Promise<boolean> {
    const capabilities = await this.getCapabilities()
    try {
      if (capabilities.wmctrl) {
        await execFileAsync('wmctrl', ['-a', title], { timeout: 1_500 })
        return true
      }
      if (capabilities.xdotool) {
        const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--name', title], {
          timeout: 1_500,
        })
        const id = stdout.trim().split('\n')[0]
        if (!id) return false
        await execFileAsync('xdotool', ['windowactivate', '--sync', id], { timeout: 1_500 })
        return true
      }
    } catch {
      return false
    }
    return false
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async applyTitleToExistingTerminal(agent: AgentConfig, title: string): Promise<void> {
    if (!agent.pid || !this.isProcessAlive(agent.pid)) return
    try {
      const stdoutTarget = await fs.readlink(`/proc/${agent.pid}/fd/1`)
      if (!stdoutTarget.startsWith('/dev/pts/')) return
      await fs.writeFile(stdoutTarget, `\u001b]0;${safeTitle(title)}\u0007`, { flag: 'a' })
    } catch {
      // Some processes do not own an interactive TTY. They remain manageable by PID.
    }
  }
}
