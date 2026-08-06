import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { SystemCapabilities, TerminalApp } from '../../shared/types'

const execFileAsync = promisify(execFile)
const SUPPORTED_TERMINALS: Exclude<TerminalApp, 'auto'>[] = [
  'ghostty',
  'gnome-terminal',
  'kitty',
  'konsole',
  'xfce4-terminal',
  'x-terminal-emulator',
]

export async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: 1_500 })
    return true
  } catch {
    return false
  }
}

/**
 * System inspection that is safe to run without an Electron window.
 * GUI operations remain in electron/services/terminal-manager.ts.
 */
export class SystemManager {
  private capabilities: SystemCapabilities | null = null

  async getCapabilities(force = false): Promise<SystemCapabilities> {
    if (this.capabilities && !force) return structuredClone(this.capabilities)
    const checks = await Promise.all([
      ...SUPPORTED_TERMINALS.map(async (terminal) => [terminal, await commandExists(terminal)] as const),
      commandExists('tmux'),
      commandExists('wmctrl'),
      commandExists('xdotool'),
      commandExists('docker'),
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
    return structuredClone(this.capabilities)
  }

}
