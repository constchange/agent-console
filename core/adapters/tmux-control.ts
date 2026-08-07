import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ActionResult } from '../../shared/types'

const execFileAsync = promisify(execFile)
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
const MAX_REMOTE_MESSAGE_BYTES = 8 * 1024
const MAX_CAPTURE_BYTES = 16 * 1024

export interface TmuxProcessIdentity {
  session: string
  paneId: string
  panePid: number
  foregroundPid: number
  foregroundStartTime: string
  command: string
}

export interface TmuxCommandRunner {
  exec(file: string, args: string[], options?: { timeout?: number; maxBuffer?: number }): Promise<{ stdout: string }>
  writeStdin(file: string, args: string[], input: string, options?: { timeout?: number }): Promise<void>
  readFile(filePath: string): Promise<string>
}

function defaultRunner(): TmuxCommandRunner {
  return {
    exec: async (file, args, options) => {
      const result = await execFileAsync(file, args, {
        timeout: options?.timeout ?? 2_500,
        maxBuffer: options?.maxBuffer ?? 1_000_000,
      })
      return { stdout: result.stdout }
    },
    writeStdin: (file, args, input, options) => new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${file} did not finish within the allowed time.`))
      }, options?.timeout ?? 2_500)
      timer.unref()
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-2_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`${file} exited with ${String(code ?? signal)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
      })
      child.stdin.end(input)
    }),
    readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  }
}

function validateSession(session: string): string {
  const value = session.trim()
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(value)) {
    throw new Error('The tmux session name is invalid.')
  }
  return value
}

function isCodexCommand(value: string): boolean {
  const command = path.basename(value.trim()).toLowerCase()
  return command === 'codex' || command === 'codex.exe' || /^codex[-_][a-z0-9._-]+$/.test(command)
}

function parseStartTime(stat: string): string {
  const endOfCommand = stat.lastIndexOf(')')
  if (endOfCommand < 0) throw new Error('The foreground process identity could not be read.')
  const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/)
  const startTime = fields[19]
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error('The foreground process start time could not be read.')
  }
  return startTime
}

function sameIdentity(actual: TmuxProcessIdentity, expected: TmuxProcessIdentity): boolean {
  return actual.session === expected.session
    && actual.paneId === expected.paneId
    && actual.panePid === expected.panePid
    && actual.foregroundPid === expected.foregroundPid
    && actual.foregroundStartTime === expected.foregroundStartTime
    && actual.command === expected.command
}

function safeMessage(value: string): string {
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text) throw new Error('A non-empty message is required.')
  if (Buffer.byteLength(text, 'utf8') > MAX_REMOTE_MESSAGE_BYTES) {
    throw new Error('The message exceeds the 8 KiB remote limit.')
  }
  if (/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error('The message contains unsupported control characters.')
  }
  return text
}

function bufferName(requestId: string): string {
  const normalized = requestId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80)
  if (!normalized) throw new Error('The request ID is invalid.')
  return `agent-console-${normalized}`
}

export class TmuxControlAdapter {
  constructor(private readonly runner: TmuxCommandRunner = defaultRunner()) {}

  async inspect(sessionValue: string): Promise<TmuxProcessIdentity> {
    const session = validateSession(sessionValue)
    const format = ['#{pane_id}', '#{pane_pid}', '#{pane_current_command}', '#{pane_dead}'].join('\t')
    const { stdout } = await this.runner.exec('tmux', ['list-panes', '-t', session, '-F', format], {
      timeout: 2_500,
      maxBuffer: 100_000,
    })
    const rows = stdout.split('\n').map((row) => row.trim()).filter(Boolean)
    if (rows.length !== 1) {
      throw new Error('Remote control requires exactly one pane in the configured tmux session.')
    }
    const [paneId, panePidText, currentCommand, dead] = rows[0].split('\t')
    const panePid = Number(panePidText)
    if (!/^%\d+$/.test(paneId ?? '') || !Number.isInteger(panePid) || panePid <= 1 || dead === '1') {
      throw new Error('The configured tmux pane is not safely actionable.')
    }
    if (!isCodexCommand(currentCommand ?? '')) {
      throw new Error('The tmux pane is no longer running Codex; remote input was refused.')
    }

    const foreground = await this.runner.exec('ps', ['-o', 'tpgid=', '-p', String(panePid)], {
      timeout: 1_500,
      maxBuffer: 20_000,
    })
    const foregroundPid = Number(foreground.stdout.trim())
    if (!Number.isInteger(foregroundPid) || foregroundPid <= 1) {
      throw new Error('The foreground Codex process could not be identified.')
    }
    const processName = await this.runner.exec('ps', ['-o', 'comm=', '-p', String(foregroundPid)], {
      timeout: 1_500,
      maxBuffer: 20_000,
    })
    const command = path.basename(processName.stdout.trim())
    if (!isCodexCommand(command)) {
      throw new Error('The tmux foreground process is not Codex; remote input was refused.')
    }
    const stat = await this.runner.readFile(`/proc/${foregroundPid}/stat`)
    return {
      session,
      paneId,
      panePid,
      foregroundPid,
      foregroundStartTime: parseStartTime(stat),
      command,
    }
  }

  async sendMessage(
    session: string,
    expectedIdentity: TmuxProcessIdentity,
    value: string,
    requestId: string,
  ): Promise<ActionResult> {
    const text = safeMessage(value)
    const actual = await this.inspect(session)
    if (!sameIdentity(actual, expectedIdentity)) {
      throw new Error('The Codex process changed after this task was observed; remote input was refused.')
    }
    const name = bufferName(requestId)
    await this.runner.writeStdin('tmux', ['load-buffer', '-b', name, '-'], text, { timeout: 2_500 })
    try {
      const rechecked = await this.inspect(session)
      if (!sameIdentity(rechecked, expectedIdentity)) {
        throw new Error('The Codex process changed before the message could be delivered.')
      }
      // Keep paste + submit in one tmux invocation. A second invocation would
      // create a larger race window in which the pane could return to a shell
      // after receiving attacker-controlled text but before receiving Enter.
      // Every interpolated token below is validated before it reaches tmux's
      // command parser; no shell is involved.
      await this.runner.exec('tmux', [
        'paste-buffer', '-b', name, '-t', actual.paneId, '-d',
        ';',
        'send-keys', '-t', actual.paneId, 'Enter',
      ], { timeout: 2_500 })
      return { ok: true, action: 'message-delivered', message: 'The message was delivered to the verified Codex pane.' }
    } finally {
      await this.runner.exec('tmux', ['delete-buffer', '-b', name], { timeout: 1_500 }).catch(() => undefined)
    }
  }

  async interrupt(session: string, expectedIdentity: TmuxProcessIdentity): Promise<ActionResult> {
    const actual = await this.inspect(session)
    if (!sameIdentity(actual, expectedIdentity)) {
      throw new Error('The Codex process changed after this task was observed; interrupt was refused.')
    }
    await this.runner.exec('tmux', ['send-keys', '-t', actual.paneId, 'C-c'], { timeout: 1_500 })
    return { ok: true, action: 'interrupted', message: 'Interrupt was sent to the verified Codex pane.' }
  }

  async captureSafeOutput(session: string, expectedIdentity: TmuxProcessIdentity): Promise<string> {
    const actual = await this.inspect(session)
    if (!sameIdentity(actual, expectedIdentity)) {
      throw new Error('The Codex process changed after this task was observed; output was refused.')
    }
    const { stdout } = await this.runner.exec('tmux', ['capture-pane', '-p', '-t', actual.paneId, '-S', '-80'], {
      timeout: 2_000,
      maxBuffer: 200_000,
    })
    return stdout
      .replace(ANSI_PATTERN, '')
      .replace(/\r/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(-MAX_CAPTURE_BYTES)
  }
}
