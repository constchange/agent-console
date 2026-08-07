import { describe, expect, it, vi } from 'vitest'
import {
  CoreTaskRuntime,
  type CoreTaskRuntimeDependencies,
  type StructuredCodexControl,
} from '../core/adapters/core-task-runtime'
import type {
  CodexAdapterEvent,
  CodexAppServerCallbacks,
  CodexApprovalRequest,
  StartCodexTaskOptions,
} from '../core/adapters/codex-app-server'
import type { TmuxProcessIdentity } from '../core/adapters/tmux-control'
import { TaskLedger } from '../core/services/task-ledger'
import type { ActionResult, RuntimeAgent, RuntimeSnapshot } from '../shared/types'

function agent(overrides: Partial<RuntimeAgent> = {}): RuntimeAgent {
  return {
    id: 'agent-1',
    projectId: 'project-1',
    name: 'Codex',
    emoji: 'C',
    color: '#112233',
    kind: 'codex',
    terminalTitle: 'Codex',
    terminalApp: 'auto',
    tmuxSession: 'codex-main',
    command: 'codex',
    cwd: '/tmp/project',
    matchPattern: '',
    logPath: '',
    autoStart: false,
    order: 0,
    pid: 900,
    cpu: 1,
    memory: 1,
    runtimeSeconds: 10,
    status: 'running',
    lastUpdated: '2026-08-07T00:00:00.000Z',
    lastOutput: '',
    processName: 'codex',
    processState: 'S',
    terminalOpen: true,
    ...overrides,
  }
}

function snapshot(runtimeAgent = agent()): RuntimeSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agents: [runtimeAgent],
    discovered: [],
    capabilities: {
      platform: 'linux', terminals: [], tmux: true, wmctrl: false,
      xdotool: false, docker: false, homeDirectory: '/tmp',
    },
    scanError: null,
  }
}

class FakeStructured implements StructuredCodexControl {
  stoppedAll = false
  active = new Set<string>()

  constructor(private readonly callbacks: CodexAppServerCallbacks) {}

  async startTask(options: StartCodexTaskOptions): Promise<unknown> {
    this.active.add(options.taskId!)
    this.event(options.taskId!, 'task.started', 'running', 'Structured task started.')
    return {}
  }

  async message(): Promise<ActionResult> {
    return { ok: true, action: 'message', message: 'ok' }
  }

  async interrupt(): Promise<ActionResult> {
    return { ok: true, action: 'interrupt', message: 'ok' }
  }

  decideApproval(): ActionResult {
    return { ok: true, action: 'approval', message: 'ok' }
  }

  stop(taskId: string): void {
    this.active.delete(taskId)
  }

  stopAll(): void {
    this.stoppedAll = true
    this.active.clear()
  }

  output(taskId: string, text: string): void {
    this.callbacks.onOutput?.(taskId, text)
  }

  approval(request: CodexApprovalRequest): void {
    this.callbacks.onApproval?.(request)
    this.event(request.taskId, 'approval.requested', 'needs_approval', request.summary)
  }

  event(taskId: string, type: string, status: CodexAdapterEvent['status'], summary: string): void {
    this.callbacks.onEvent?.({ taskId, type, status, summary, createdAt: new Date().toISOString() })
  }
}

function fixture() {
  const ledger = new TaskLedger(':memory:')
  let identity: TmuxProcessIdentity = {
    session: 'codex-main', paneId: '%1', panePid: 700,
    foregroundPid: 900, foregroundStartTime: '100', command: 'codex',
  }
  let structured!: FakeStructured
  const sendMessage = vi.fn(async () => ({ ok: true, action: 'message', message: 'ok' }))
  const interrupt = vi.fn(async () => ({ ok: true, action: 'interrupt', message: 'ok' }))
  const dependencies: CoreTaskRuntimeDependencies = {
    tmuxControl: {
      inspect: vi.fn(async () => ({ ...identity })),
      sendMessage,
      interrupt,
    },
    createStructuredCodex: (callbacks) => {
      structured = new FakeStructured(callbacks)
      return structured
    },
  }
  const remote: string[] = []
  const desktop: Array<{ type: string; payload: unknown }> = []
  const runtime = new CoreTaskRuntime(ledger, dependencies, {
    publishRemote: (event) => remote.push(event.summary),
    publishDesktop: (type, payload) => desktop.push({ type, payload }),
  })
  return {
    ledger,
    runtime,
    structured,
    remote,
    desktop,
    sendMessage,
    interrupt,
    replaceProcess: () => { identity = { ...identity, foregroundPid: 901, foregroundStartTime: '101' } },
  }
}

describe('CoreTaskRuntime', () => {
  it('selects only a verified single-pane Codex tmux target and rotates the task when its process changes', async () => {
    const context = fixture()
    await context.runtime.reconcileSnapshot(snapshot())
    const first = context.ledger.getActiveTaskForAgent('agent-1')!
    expect(first.adapter).toBe('tmux-compatibility')
    expect(context.runtime.canAct(first)).toBe(false)
    expect(first).not.toHaveProperty('pid')
    expect(first).not.toHaveProperty('session')

    context.replaceProcess()
    await context.runtime.reconcileSnapshot(snapshot())
    const second = context.ledger.getActiveTaskForAgent('agent-1')!
    expect(second.id).not.toBe(first.id)
    expect(second.adapter).toBe('tmux-compatibility')
    expect(context.ledger.getTask(first.id)).toMatchObject({ active: false, status: 'interrupted' })
    expect(second.version).toBeGreaterThanOrEqual(1)
    context.ledger.close()
  })

  it('keeps observed tmux tasks read-only over the remote action adapter', async () => {
    const context = fixture()
    const task = context.ledger.createTask({
      agentId: 'agent-1', adapter: 'tmux-compatibility', status: 'running', summary: 'running',
    }).task
    const adapters = context.runtime.actionAdapters()
    expect(adapters['tmux-compatibility']).toBeUndefined()
    expect(context.runtime.canAct(task)).toBe(false)
    expect(context.sendMessage).not.toHaveBeenCalled()
    expect(context.interrupt).not.toHaveBeenCalled()
    context.ledger.close()
  })

  it('persists structured task, approval, and coarse events while keeping raw output ephemeral', async () => {
    const context = fixture()
    const task = await context.runtime.startStructured(agent({ tmuxSession: '' }), 'Run the focused tests')
    expect(task).toMatchObject({ adapter: 'codex-structured', status: 'running', active: true })

    context.structured.output(task.id, '/tmp/private secret workspace output')
    context.structured.approval({
      id: `${task.id}:item-1`, taskId: task.id, kind: 'command',
      summary: 'Run one focused command.', threadId: 'thread-1', turnId: 'turn-1',
      createdAt: new Date().toISOString(),
    })
    expect(context.ledger.getApproval(`${task.id}:item-1`)).toMatchObject({ status: 'pending' })
    expect(context.ledger.getTask(task.id)).toMatchObject({ status: 'needs_approval', active: true })
    expect(context.desktop).toContainEqual({
      type: 'task.output', payload: { taskId: task.id, text: '/tmp/private secret workspace output' },
    })
    expect(JSON.stringify(context.ledger.events(0, 100).events)).not.toContain('secret workspace output')

    expect(context.runtime.decideStructuredApproval(task.id, `${task.id}:item-1`, 'approve')).toMatchObject({ ok: true })
    expect(context.ledger.getApproval(`${task.id}:item-1`)).toMatchObject({ status: 'approved' })
    context.structured.event(task.id, 'task.disconnected', 'failed', 'Codex app-server disconnected.')
    const disconnected = context.ledger.getTask(task.id)!
    expect(disconnected).toMatchObject({ status: 'failed', active: false })
    expect(context.runtime.canAct(disconnected)).toBe(false)
    context.runtime.stop()
    expect(context.structured.stoppedAll).toBe(true)
    context.ledger.close()
  })
})
