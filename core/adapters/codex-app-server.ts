import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { ActionResult } from '../../shared/types'

const MAX_JSONL_LINE_BYTES = 1024 * 1024
const MAX_PENDING_BUFFER_BYTES = 2 * MAX_JSONL_LINE_BYTES
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_REMOTE_TEXT_BYTES = 8 * 1024

type RpcId = string | number
type JsonRecord = Record<string, unknown>

export interface AppServerChild {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export type SpawnAppServer = (cwd: string) => AppServerChild

export type CodexAdapterStatus =
  | 'starting'
  | 'running'
  | 'needs_input'
  | 'needs_approval'
  | 'completed'
  | 'failed'
  | 'interrupted'

export interface CodexAdapterEvent {
  taskId: string
  type: string
  status: CodexAdapterStatus
  summary: string
  createdAt: string
}

export interface CodexApprovalRequest {
  id: string
  taskId: string
  kind: 'command' | 'file'
  summary: string
  threadId: string
  turnId: string
  createdAt: string
}

export interface CodexAppServerCallbacks {
  onEvent?: (event: CodexAdapterEvent) => void
  onApproval?: (request: CodexApprovalRequest) => void
  /**
   * Ephemeral output only. Callers must never persist this text in the task
   * ledger; it may contain source, paths, or credentials from the workspace.
   */
  onOutput?: (taskId: string, text: string) => void
}

export interface StartCodexTaskOptions {
  taskId?: string
  cwd: string
  prompt: string
}

export interface CodexTaskSession {
  taskId: string
  threadId: string
  turnId: string
  status: CodexAdapterStatus
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface PendingApproval {
  approvalId: string
  rpcId: RpcId
  method: string
  threadId: string
  turnId: string
}

interface InternalSession extends CodexTaskSession {
  connection: JsonlRpcConnection
  approvals: Map<string, PendingApproval>
  stopped: boolean
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function boundedText(value: unknown, fallback: string, maxBytes = MAX_REMOTE_TEXT_BYTES): string {
  const cleaned = text(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
    .trim()
  const source = cleaned || fallback
  let result = source
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, Math.max(0, result.length - 128))
  return result
}

function publicText(value: unknown, fallback: string, maxBytes = 2_000): string {
  return boundedText(value, fallback, maxBytes)
    .replace(/(^|\s)(?:~\/|\/)[^\s,;]+/g, '$1[private path]')
    .replace(/\b[a-zA-Z]:\\[^\s,;]+/g, '[private path]')
}

function taskText(value: unknown): string {
  const result = boundedText(value, '', MAX_REMOTE_TEXT_BYTES)
  if (!result) throw new Error('A non-empty message is required.')
  return result
}

function id(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : ''
}

function defaultSpawn(cwd: string): AppServerChild {
  return spawn('codex', ['app-server', '--listen', 'stdio://'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  }) as unknown as AppServerChild
}

class JsonlRpcConnection {
  private nextId = 1
  private pending = new Map<RpcId, PendingRequest>()
  private buffer = Buffer.alloc(0)
  private closed = false

  constructor(
    private readonly child: AppServerChild,
    private readonly onNotification: (message: JsonRecord) => void,
    private readonly onServerRequest: (message: JsonRecord) => void,
    private readonly onClosed: (error: Error) => void,
  ) {
    child.stdout.on('data', (chunk: Buffer | string) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.stdout.once('error', (error) => this.fail(error))
    child.stdin.once('error', (error) => this.fail(error))
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, signal) => {
      this.fail(new Error(`Codex app-server exited with ${String(code ?? signal ?? 'unknown status')}.`))
    })
  }

  async request<T>(method: string, params: JsonRecord = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) throw new Error('Codex app-server is not connected.')
    const requestId = this.nextId++
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Codex app-server ${method} timed out.`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(requestId, { resolve, reject, timer })
    })
    this.write({ method, id: requestId, params })
    return await response as T
  }

  notify(method: string, params: JsonRecord = {}): void {
    this.write({ method, params })
  }

  respond(requestId: RpcId, result: JsonRecord): void {
    this.write({ id: requestId, result })
  }

  reject(requestId: RpcId, code: number, message: string): void {
    this.write({ id: requestId, error: { code, message } })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server connection closed.'))
    }
    this.pending.clear()
    this.child.stdin.end()
    this.child.kill('SIGTERM')
  }

  private write(message: JsonRecord): void {
    if (this.closed) throw new Error('Codex app-server is not connected.')
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
      throw new Error('Codex app-server request exceeds the 1 MiB protocol limit.')
    }
    this.child.stdin.write(line)
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_PENDING_BUFFER_BYTES) {
      this.fail(new Error('Codex app-server sent an oversized unterminated JSONL message.'))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) return
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > MAX_JSONL_LINE_BYTES) {
        this.fail(new Error('Codex app-server sent a JSONL message larger than 1 MiB.'))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(line.toString('utf8'))
      } catch {
        this.fail(new Error('Codex app-server sent malformed JSONL.'))
        return
      }
      if (!isRecord(message)) {
        this.fail(new Error('Codex app-server sent a non-object message.'))
        return
      }
      this.dispatch(message)
      if (this.closed) return
    }
  }

  private dispatch(message: JsonRecord): void {
    const responseId = message.id
    if ((typeof responseId === 'string' || typeof responseId === 'number') && !message.method) {
      const pending = this.pending.get(responseId)
      if (!pending) return
      this.pending.delete(responseId)
      clearTimeout(pending.timer)
      if (isRecord(message.error)) {
        pending.reject(new Error(publicText(message.error.message, 'Codex app-server request failed.')))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method !== 'string') {
      this.fail(new Error('Codex app-server sent a message without a method.'))
      return
    }
    if (typeof responseId === 'string' || typeof responseId === 'number') this.onServerRequest(message)
    else this.onNotification(message)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.child.kill('SIGKILL')
    this.onClosed(error)
  }
}

function approvalKind(method: string): CodexApprovalRequest['kind'] | null {
  if (method === 'item/commandExecution/requestApproval') return 'command'
  if (method === 'item/fileChange/requestApproval') return 'file'
  return null
}

function approvalSummary(kind: CodexApprovalRequest['kind'], params: JsonRecord): string {
  if (kind === 'command') {
    const network = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : null
    // App-server approval reasons, commands, hosts and paths are deliberately
    // not copied into the durable ledger. They may contain source text,
    // credentials or private infrastructure names. Keep only a bounded action
    // category for the remote projection.
    if (network) return 'Codex requests one network access approval.'
    return 'Codex requests permission to run one command.'
  }
  return 'Codex requests permission to apply one file change.'
}

export class CodexAppServerAdapter {
  private readonly sessions = new Map<string, InternalSession>()

  constructor(
    private readonly version: string,
    private readonly callbacks: CodexAppServerCallbacks = {},
    private readonly spawnAppServer: SpawnAppServer = defaultSpawn,
  ) {}

  async startTask(options: StartCodexTaskOptions): Promise<CodexTaskSession> {
    const taskId = options.taskId && /^[a-zA-Z0-9_.:-]{1,160}$/.test(options.taskId)
      ? options.taskId
      : randomUUID()
    if (this.sessions.has(taskId)) throw new Error('This structured task is already active.')
    const cwd = path.resolve(options.cwd)
    const prompt = taskText(options.prompt)
    let session: InternalSession | null = null
    const child = this.spawnAppServer(cwd)
    const connection = new JsonlRpcConnection(
      child,
      (message) => session && this.handleNotification(session, message),
      (message) => session && this.handleServerRequest(session, message),
      (error) => session && this.handleClosed(session, error),
    )
    session = {
      taskId,
      threadId: '',
      turnId: '',
      status: 'starting',
      connection,
      approvals: new Map(),
      stopped: false,
    }
    this.sessions.set(taskId, session)

    try {
      await connection.request('initialize', {
        clientInfo: { name: 'agent_console', title: 'Agent Console', version: this.version },
      })
      connection.notify('initialized')
      const threadResult = await connection.request<JsonRecord>('thread/start', { cwd })
      const thread = isRecord(threadResult.thread) ? threadResult.thread : null
      session.threadId = id(thread?.id)
      if (!session.threadId) throw new Error('Codex app-server did not return a valid thread ID.')
      const turnResult = await connection.request<JsonRecord>('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: prompt }],
        cwd,
      })
      const turn = isRecord(turnResult.turn) ? turnResult.turn : null
      session.turnId = id(turn?.id)
      if (!session.turnId) throw new Error('Codex app-server did not return a valid turn ID.')
      session.status = 'running'
      this.emit(session, 'task.started', 'Structured Codex task started.')
      return this.snapshot(session)
    } catch (error) {
      this.sessions.delete(taskId)
      connection.close()
      throw error
    }
  }

  get(taskId: string): CodexTaskSession | null {
    const session = this.sessions.get(taskId)
    return session ? this.snapshot(session) : null
  }

  async message(taskId: string, value: string): Promise<ActionResult> {
    const session = this.requireActive(taskId)
    if (session.status !== 'running' && session.status !== 'needs_input') {
      throw new Error('This Codex turn is not waiting for additional input.')
    }
    await session.connection.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: session.turnId,
      input: [{ type: 'text', text: taskText(value) }],
    })
    session.status = 'running'
    this.emit(session, 'task.message_delivered', 'Additional input was delivered to Codex.')
    return { ok: true, action: 'message-delivered', message: 'The message was delivered to the active Codex turn.' }
  }

  async interrupt(taskId: string): Promise<ActionResult> {
    const session = this.requireActive(taskId)
    await session.connection.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.turnId,
    })
    return { ok: true, action: 'interrupt-requested', message: 'Codex accepted the interrupt request.' }
  }

  decideApproval(taskId: string, approvalId: string, decision: 'approve' | 'reject'): ActionResult {
    const session = this.requireActive(taskId)
    const pending = session.approvals.get(approvalId)
    if (!pending) throw new Error('The approval request is no longer pending.')
    if (pending.threadId !== session.threadId || pending.turnId !== session.turnId) {
      throw new Error('The approval belongs to an older Codex turn.')
    }
    session.approvals.delete(approvalId)
    session.connection.respond(pending.rpcId, { decision: decision === 'approve' ? 'accept' : 'decline' })
    session.status = 'running'
    this.emit(session, 'approval.resolved', decision === 'approve' ? 'Approval accepted.' : 'Approval declined.')
    return { ok: true, action: decision === 'approve' ? 'approved' : 'rejected', message: 'The approval decision was delivered to Codex.' }
  }

  stop(taskId: string): void {
    const session = this.sessions.get(taskId)
    if (!session) return
    session.stopped = true
    session.connection.close()
    this.sessions.delete(taskId)
  }

  stopAll(): void {
    for (const taskId of [...this.sessions.keys()]) this.stop(taskId)
  }

  private handleNotification(session: InternalSession, message: JsonRecord): void {
    const method = text(message.method)
    const params = isRecord(message.params) ? message.params : {}
    if (method === 'turn/started') {
      const turn = isRecord(params.turn) ? params.turn : null
      const turnId = id(turn?.id)
      if (turnId) session.turnId = turnId
      session.status = 'running'
      this.emit(session, 'turn.started', 'Codex is working.')
      return
    }
    if (method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : null
      const status = text(turn?.status)
      session.status = status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed'
      session.approvals.clear()
      this.emit(session, 'turn.completed', session.status === 'completed' ? 'Codex finished the turn.' : `Codex turn ${session.status}.`)
      return
    }
    if (method === 'item/agentMessage/delta') {
      const delta = publicText(params.delta, '', 2_000)
      if (delta) {
        this.callbacks.onOutput?.(session.taskId, delta)
        this.emit(session, 'agent.message', 'Codex produced new output.')
      }
      return
    }
    if (method === 'error') {
      session.status = 'failed'
      this.emit(session, 'task.error', 'Codex reported an error.')
      return
    }
    if (method === 'serverRequest/resolved') {
      const requestId = id(params.requestId)
      if (requestId) session.approvals.delete(requestId)
    }
  }

  private handleServerRequest(session: InternalSession, message: JsonRecord): void {
    const method = text(message.method)
    const kind = approvalKind(method)
    const rpcId = message.id
    if ((typeof rpcId !== 'string' && typeof rpcId !== 'number') || !kind) {
      if (typeof rpcId === 'string' || typeof rpcId === 'number') {
        session.connection.reject(rpcId, -32601, 'Agent Console does not expose this app-server request remotely.')
      }
      return
    }
    const params = isRecord(message.params) ? message.params : {}
    const threadId = id(params.threadId)
    const turnId = id(params.turnId)
    const itemId = id(params.itemId)
    if (!threadId || !turnId || !itemId || threadId !== session.threadId || turnId !== session.turnId) {
      session.connection.reject(rpcId, -32602, 'Approval request does not match the active Codex turn.')
      return
    }
    // Keep app-server item/thread identifiers out of the durable ledger while
    // retaining a deterministic, bounded correlation key for this exact turn.
    const approvalId = `approval-${createHash('sha256')
      .update(`${session.taskId}\0${threadId}\0${turnId}\0${itemId}`)
      .digest('hex')
      .slice(0, 40)}`
    session.approvals.set(approvalId, { approvalId, rpcId, method, threadId, turnId })
    session.status = 'needs_approval'
    const request: CodexApprovalRequest = {
      id: approvalId,
      taskId: session.taskId,
      kind,
      summary: approvalSummary(kind, params),
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    }
    this.callbacks.onApproval?.(request)
    this.emit(session, 'approval.requested', request.summary)
  }

  private handleClosed(session: InternalSession, _error: Error): void {
    if (session.stopped) return
    session.status = 'failed'
    session.approvals.clear()
    this.sessions.delete(session.taskId)
    this.emit(session, 'task.disconnected', 'Codex app-server disconnected unexpectedly.')
  }

  private requireActive(taskId: string): InternalSession {
    const session = this.sessions.get(taskId)
    if (!session || session.stopped || ['completed', 'failed', 'interrupted'].includes(session.status)) {
      throw new Error('The structured Codex task is not active.')
    }
    return session
  }

  private emit(session: InternalSession, type: string, summary: string): void {
    this.callbacks.onEvent?.({
      taskId: session.taskId,
      type,
      status: session.status,
      summary: publicText(summary, 'Codex task updated.'),
      createdAt: new Date().toISOString(),
    })
  }

  private snapshot(session: InternalSession): CodexTaskSession {
    return {
      taskId: session.taskId,
      threadId: session.threadId,
      turnId: session.turnId,
      status: session.status,
    }
  }
}
