import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerAdapter,
  type AppServerChild,
  type CodexApprovalRequest,
  type SpawnAppServer,
} from '../core/adapters/codex-app-server'

class FakeChild extends EventEmitter implements AppServerChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: Array<Record<string, unknown>> = []
  killedWith: NodeJS.Signals | null = null
  private incoming = ''

  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.incoming += chunk
      while (this.incoming.includes('\n')) {
        const index = this.incoming.indexOf('\n')
        const line = this.incoming.slice(0, index)
        this.incoming = this.incoming.slice(index + 1)
        if (!line) continue
        const message = JSON.parse(line) as Record<string, unknown>
        this.messages.push(message)
        this.autoRespond(message)
      }
    })
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith = signal
    return true
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  private autoRespond(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return
    if (message.method === 'initialize') this.send({ id: message.id, result: { userAgent: 'test' } })
    if (message.method === 'thread/start') this.send({ id: message.id, result: { thread: { id: 'thr_1' } } })
    if (message.method === 'turn/start') this.send({ id: message.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } })
    if (message.method === 'turn/steer') this.send({ id: message.id, result: { turnId: 'turn_1' } })
    if (message.method === 'turn/interrupt') this.send({ id: message.id, result: {} })
  }
}

function setup(callback?: (approval: CodexApprovalRequest) => void) {
  const child = new FakeChild()
  const spawn: SpawnAppServer = vi.fn(() => child)
  const events: string[] = []
  const adapter = new CodexAppServerAdapter('0.5.0', {
    onEvent: (event) => events.push(event.type),
    onApproval: callback,
  }, spawn)
  return { child, spawn, events, adapter }
}

describe('CodexAppServerAdapter', () => {
  it('performs the documented initialize, thread, and turn handshake', async () => {
    const { adapter, child, spawn } = setup()
    const session = await adapter.startTask({ taskId: 'task-1', cwd: '/tmp/project', prompt: 'Run tests' })
    expect(session).toMatchObject({ taskId: 'task-1', threadId: 'thr_1', turnId: 'turn_1', status: 'running' })
    expect(spawn).toHaveBeenCalledWith('/tmp/project')
    expect(child.messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ])
  })

  it('steers and interrupts only the active turn', async () => {
    const { adapter, child } = setup()
    await adapter.startTask({ taskId: 'task-2', cwd: '/tmp/project', prompt: 'Start' })
    await expect(adapter.message('task-2', 'Focus on the failing test')).resolves.toMatchObject({ ok: true })
    await expect(adapter.interrupt('task-2')).resolves.toMatchObject({ ok: true })
    const steer = child.messages.find((message) => message.method === 'turn/steer')
    expect(steer?.params).toMatchObject({ threadId: 'thr_1', expectedTurnId: 'turn_1' })
  })

  it('maps a scoped command approval and never offers session approval remotely', async () => {
    let approval: CodexApprovalRequest | null = null
    const { adapter, child } = setup((next) => { approval = next })
    await adapter.startTask({ taskId: 'task-3', cwd: '/tmp/project', prompt: 'Start' })
    child.send({
      id: 90,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_9', reason: 'Run the focused test' },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(approval).toMatchObject({ kind: 'command', summary: 'Codex requests permission to run one command.' })
    expect(approval!.summary).not.toContain('focused test')
    expect(approval!.id).toMatch(/^approval-[a-f0-9]{40}$/)
    expect(adapter.decideApproval('task-3', approval!.id, 'approve')).toMatchObject({ ok: true, action: 'approved' })
    const response = child.messages.find((message) => message.id === 90 && 'result' in message)
    expect(response).toEqual({ id: 90, result: { decision: 'accept' } })
  })

  it('uses a fixed durable summary for network approvals', async () => {
    let approval: CodexApprovalRequest | null = null
    const { adapter, child } = setup((next) => { approval = next })
    await adapter.startTask({ taskId: 'task-network', cwd: '/tmp/project', prompt: 'Start' })
    child.send({
      id: 92,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_network',
        reason: 'token=secret',
        networkApprovalContext: { protocol: 'secret-protocol', host: 'private.example' },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(approval!.summary).toBe('Codex requests one network access approval.')
    expect(approval!.summary).not.toContain('secret')
    expect(approval!.summary).not.toContain('private.example')
  })

  it('rejects unknown server-initiated methods instead of proxying them', async () => {
    const { adapter, child } = setup()
    await adapter.startTask({ taskId: 'task-4', cwd: '/tmp/project', prompt: 'Start' })
    child.send({ id: 91, method: 'fs/writeFile', params: { path: '/tmp/nope' } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(child.messages.find((message) => message.id === 91 && 'error' in message)).toEqual({
      id: 91,
      error: { code: -32601, message: 'Agent Console does not expose this app-server request remotely.' },
    })
  })

  it('keeps workspace output out of persistable task event summaries', async () => {
    const child = new FakeChild()
    const output: string[] = []
    const summaries: string[] = []
    const adapter = new CodexAppServerAdapter('0.5.0', {
      onOutput: (_taskId, value) => output.push(value),
      onEvent: (event) => summaries.push(event.summary),
    }, () => child)
    await adapter.startTask({ taskId: 'task-output', cwd: '/tmp/project', prompt: 'Start' })
    child.send({ method: 'item/agentMessage/delta', params: { delta: 'secret workspace output' } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(output).toEqual(['secret workspace output'])
    expect(summaries).toContain('Codex produced new output.')
    expect(summaries).not.toContain('secret workspace output')
  })

  it('keeps app-server error details out of persistable task event summaries', async () => {
    const child = new FakeChild()
    const summaries: string[] = []
    const adapter = new CodexAppServerAdapter('0.5.0', {
      onEvent: (event) => summaries.push(event.summary),
    }, () => child)
    await adapter.startTask({ taskId: 'task-error', cwd: '/tmp/project', prompt: 'Start' })
    child.send({ method: 'error', params: { error: { message: 'token=secret at /private/workspace' } } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(summaries).toContain('Codex reported an error.')
    expect(summaries.join(' ')).not.toContain('secret')
    expect(summaries.join(' ')).not.toContain('/private/workspace')
  })

  it('terminates the adapter on malformed or oversized JSONL', async () => {
    const { adapter, child } = setup()
    await adapter.startTask({ taskId: 'task-5', cwd: '/tmp/project', prompt: 'Start' })
    child.stdout.write('{bad json}\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(child.killedWith).toBe('SIGKILL')
    expect(adapter.get('task-5')).toBeNull()
  })
})
