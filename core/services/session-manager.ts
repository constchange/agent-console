import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { ActionResult, AgentConfig } from '../../shared/types'
import { commandExists } from './system-manager'

const execFileAsync = promisify(execFile)

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function safeTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
}

export class SessionManager {
  async ensureTmuxSession(agent: AgentConfig): Promise<ActionResult> {
    if (!agent.tmuxSession) {
      return { ok: true, action: 'not-required', message: `${agent.name} does not use tmux` }
    }
    if (!await commandExists('tmux')) {
      return { ok: false, action: 'unavailable', message: 'This Agent uses tmux, but tmux is not installed.' }
    }
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(agent.tmuxSession)) {
      return { ok: false, action: 'invalid', message: 'tmux session names may only use letters, numbers, dot, dash, and underscore.' }
    }
    try {
      await execFileAsync('tmux', ['has-session', '-t', agent.tmuxSession], { timeout: 1_500 })
      return { ok: true, action: 'exists', message: `${agent.tmuxSession} is already running` }
    } catch {
      // The configured session is not running yet.
    }

    try {
      const args = ['new-session', '-d', '-s', agent.tmuxSession, '-c', agent.cwd || os.homedir()]
      if (agent.command.trim()) {
        const shell = process.env.SHELL || '/bin/bash'
        const keepOpenCommand = `${agent.command}; exec ${shellQuote(shell)}`
        args.push(`${shellQuote(shell)} -lc ${shellQuote(keepOpenCommand)}`)
      }
      await execFileAsync('tmux', args, { timeout: 4_000 })
      await execFileAsync('tmux', ['rename-window', '-t', agent.tmuxSession, safeTitle(agent.name)], { timeout: 1_500 }).catch(() => undefined)
      return { ok: true, action: 'created', message: `${agent.tmuxSession} started` }
    } catch (error) {
      return { ok: false, action: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }
}
