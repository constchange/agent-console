import type { ActionResult, AgentConfig, CoreTaskRecord, RuntimeAgent, RuntimeSnapshot } from '../../shared/types'
import type { CodexAdapterEvent, CodexAppServerCallbacks, CodexApprovalRequest, StartCodexTaskOptions } from './codex-app-server'
import { CodexAppServerAdapter } from './codex-app-server'
import { TmuxControlAdapter, type TmuxProcessIdentity } from './tmux-control'
import type { RemoteEvent, RemoteTaskAdapter } from '../../shared/remote-protocol'
import type { TaskActionAdapters } from '../services/task-command-service'
import { TaskLedger, type PersistedTask, type SnapshotTaskAdapterSelector } from '../services/task-ledger'

const APPROVAL_LIFETIME_MS = 5 * 60_000

export interface StructuredCodexControl {
  startTask(options: StartCodexTaskOptions): Promise<unknown>
  message(taskId: string, value: string): Promise<ActionResult>
  interrupt(taskId: string): Promise<ActionResult>
  decideApproval(taskId: string, approvalId: string, decision: 'approve' | 'reject'): ActionResult
  stop(taskId: string): void
  stopAll(): void
}

export interface CoreTaskRuntimeDependencies {
  tmuxControl: Pick<TmuxControlAdapter, 'inspect' | 'sendMessage' | 'interrupt'>
  createStructuredCodex(callbacks: CodexAppServerCallbacks): StructuredCodexControl
}

export interface CoreTaskRuntimeCallbacks {
  publishRemote(event: RemoteEvent): void
  publishDesktop(type: string, payload: unknown): void
}

interface TmuxBinding {
  agentId: string
  session: string
  identity: TmuxProcessIdentity
}

function sameIdentity(left: TmuxProcessIdentity, right: TmuxProcessIdentity): boolean {
  return left.session === right.session
    && left.paneId === right.paneId
    && left.panePid === right.panePid
    && left.foregroundPid === right.foregroundPid
    && left.foregroundStartTime === right.foregroundStartTime
    && left.command === right.command
}

function structuredStatus(status: CodexAdapterEvent['status']): CoreTaskRecord['status'] {
  switch (status) {
    case 'starting': return 'starting'
    case 'running': return 'running'
    case 'needs_input': return 'needs_input'
    case 'needs_approval': return 'needs_approval'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'interrupted': return 'interrupted'
  }
}

function structuredActive(status: CodexAdapterEvent['status']): boolean {
  return !['completed', 'failed', 'interrupted'].includes(status)
}

function validPrompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A task prompt is required.')
  const prompt = value.replace(/\r\n?/g, '\n').trim()
  if (!prompt) throw new Error('A task prompt is required.')
  if (Buffer.byteLength(prompt, 'utf8') > 8 * 1024) throw new Error('The task prompt exceeds 8 KiB.')
  if (/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    throw new Error('The task prompt contains unsupported control characters.')
  }
  return prompt
}

/**
 * Owns all live process identities and app-server handles. None of this state
 * is serialized; after a Core restart a tmux task must be observed and bound
 * again as a new task before it becomes actionable.
 */
export class CoreTaskRuntime {
  private readonly tmuxBindings = new Map<string, TmuxBinding>()
  private readonly structured: StructuredCodexControl
  private readonly structuredActionsInFlight = new Set<string>()
  private readonly deferredStructuredEvents = new Map<string, CodexAdapterEvent[]>()
  private latestAgents = new Map<string, RuntimeAgent>()
  private stopped = false

  constructor(
    private readonly ledger: TaskLedger,
    private readonly dependencies: CoreTaskRuntimeDependencies,
    private readonly callbacks: CoreTaskRuntimeCallbacks,
  ) {
    this.structured = dependencies.createStructuredCodex({
      onEvent: (event) => this.onStructuredEvent(event),
      onApproval: (request) => this.onStructuredApproval(request),
      // Raw output is private, ephemeral desktop data. It is deliberately not
      // passed to TaskLedger or the replayable remote publisher.
      onOutput: (taskId, text) => this.callbacks.publishDesktop('task.output', { taskId, text }),
    })
    for (const task of this.ledger.listTasks()) {
      if (task.active && task.adapter === 'codex-structured') {
        this.retireTask(task, 'The previous structured Codex connection did not survive the Core restart.')
      }
    }
  }

  actionAdapters(): TaskActionAdapters {
    return {
      // Observed tmux tasks are intentionally read-only over Mobile Remote.
      // Process identity checks cannot make a later paste/Enter or C-c atomic
      // with the foreground Codex process; the pane could return to a shell in
      // that gap. Only the structured app-server transport is remotely writable.
      'codex-structured': {
        message: async ({ task, message }) => this.withStructuredRemoteAction(task.id, async () => ({
          ok: (await this.structured.message(task.id, message)).ok,
        })),
        interrupt: async ({ task }) => this.withStructuredRemoteAction(task.id, async () => ({
          ok: (await this.structured.interrupt(task.id)).ok,
        })),
        decideApproval: async ({ task, approvalId, decision }) => this.withStructuredRemoteAction(task.id, async () => ({
          ok: this.structured.decideApproval(task.id, approvalId, decision).ok,
        })),
      },
    }
  }

  canAct(task: PersistedTask): boolean {
    return task.active && task.adapter === 'codex-structured'
  }

  async reconcileSnapshot(
    snapshot: RuntimeSnapshot,
    fallbackSelector: SnapshotTaskAdapterSelector = () => 'process-monitor',
  ): Promise<void> {
    if (this.stopped) return
    this.latestAgents = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
    const identities = new Map<string, TmuxProcessIdentity>()
    await Promise.all(snapshot.agents.map(async (agent) => {
      if (agent.kind !== 'codex' || !agent.tmuxSession) return
      try {
        identities.set(agent.id, await this.dependencies.tmuxControl.inspect(agent.tmuxSession))
      } catch {
        // A missing, multi-pane, dead, shell, or ambiguous target is read-only.
      }
    }))

    for (const agent of snapshot.agents) {
      const active = this.ledger.getActiveTaskForAgent(agent.id)
      if (!active || active.adapter === 'codex-structured') continue
      const identity = identities.get(agent.id)
      const binding = this.tmuxBindings.get(active.id)
      const remainsBound = active.adapter === 'tmux-compatibility'
        && identity
        && binding
        && binding.session === agent.tmuxSession
        && sameIdentity(binding.identity, identity)
      const desiredAdapter = identity ? 'tmux-compatibility' : this.safeFallback(fallbackSelector(agent))
      if (!remainsBound && (active.adapter !== desiredAdapter || active.adapter === 'tmux-compatibility')) {
        this.retireTask(active, identity
          ? 'The observed Codex process changed; the previous task binding was retired.'
          : 'The Codex tmux target is no longer safely actionable.')
      }
    }

    const update = this.ledger.updateFromSnapshot(snapshot, (agent) => (
      identities.has(agent.id) ? 'tmux-compatibility' : this.safeFallback(fallbackSelector(agent))
    ))
    for (const event of update.events) this.callbacks.publishRemote(event)

    const activeIds = new Set<string>()
    for (const agent of snapshot.agents) {
      const identity = identities.get(agent.id)
      if (!identity) continue
      const task = this.ledger.getActiveTaskForAgent(agent.id)
      if (!task || task.adapter !== 'tmux-compatibility') continue
      activeIds.add(task.id)
      this.tmuxBindings.set(task.id, {
        agentId: agent.id,
        session: agent.tmuxSession,
        identity,
      })
    }
    for (const taskId of this.tmuxBindings.keys()) {
      if (!activeIds.has(taskId)) this.tmuxBindings.delete(taskId)
    }
  }

  async startStructured(agent: AgentConfig, promptValue: unknown): Promise<PersistedTask> {
    const prompt = validPrompt(promptValue)
    if (agent.kind !== 'codex') throw new Error('Structured tasks can only be started for a configured Codex Agent.')
    if (!agent.cwd) throw new Error('The Codex Agent needs a configured working directory.')
    const active = this.ledger.getActiveTaskForAgent(agent.id)
    if (active) {
      if (active.adapter === 'codex-structured') this.structured.stop(active.id)
      this.retireTask(active, 'The previous task was replaced by a new structured Codex task.')
    }
    const created = this.ledger.createTask({
      agentId: agent.id,
      adapter: 'codex-structured',
      status: 'starting',
      summary: 'Structured Codex task is starting.',
    })
    if (created.event) this.callbacks.publishRemote(created.event)
    try {
      await this.structured.startTask({ taskId: created.task.id, cwd: agent.cwd, prompt })
      return this.ledger.getTask(created.task.id) ?? created.task
    } catch (error) {
      const failed = this.ledger.transitionTask({
        taskId: created.task.id,
        status: 'failed',
        summary: 'Structured Codex task could not be started.',
        active: false,
        eventType: 'task.start_failed',
      })
      if (failed.event) this.callbacks.publishRemote(failed.event)
      throw error
    }
  }

  async messageStructured(taskId: string, message: string): Promise<ActionResult> {
    const task = this.requireStructuredTask(taskId)
    const result = await this.structured.message(task.id, message)
    if (result.ok) this.transitionStructuredAction(task.id, 'running', 'Codex received additional input.', true, 'task.message_received')
    return result
  }

  async interruptStructured(taskId: string): Promise<ActionResult> {
    const task = this.requireStructuredTask(taskId)
    const result = await this.structured.interrupt(task.id)
    if (result.ok) this.transitionStructuredAction(task.id, 'interrupted', 'Codex task was interrupted.', false, 'task.interrupted')
    return result
  }

  decideStructuredApproval(taskId: string, approvalId: string, decision: 'approve' | 'reject'): ActionResult {
    this.requireStructuredTask(taskId)
    const approval = this.ledger.getApproval(approvalId)
    if (!approval || approval.taskId !== taskId || approval.status !== 'pending') {
      throw new Error('The approval request is no longer pending for this task.')
    }
    const result = this.structured.decideApproval(taskId, approvalId, decision)
    if (result.ok) {
      const resolved = this.ledger.resolveApproval({
        approvalId,
        taskId,
        status: decision === 'approve' ? 'approved' : 'rejected',
        decisionSummary: decision === 'approve'
          ? 'A one-time approval was granted from the desktop.'
          : 'The approval was rejected from the desktop.',
      })
      if (resolved.event) this.callbacks.publishRemote(resolved.event)
      this.transitionStructuredAction(taskId, 'running', 'Codex received an approval decision.', true, 'task.approval_decided')
    }
    return result
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.tmuxBindings.clear()
    this.deferredStructuredEvents.clear()
    this.structuredActionsInFlight.clear()
    this.structured.stopAll()
  }

  private safeFallback(adapter: RemoteTaskAdapter): RemoteTaskAdapter {
    return adapter === 'tmux-compatibility' || adapter === 'codex-structured' ? 'process-monitor' : adapter
  }

  private async requireCurrentTmuxBinding(task: PersistedTask): Promise<TmuxBinding> {
    const binding = this.tmuxBindings.get(task.id)
    if (!binding) throw new Error('This tmux task has no verified in-memory process binding.')
    const actual = await this.dependencies.tmuxControl.inspect(binding.session)
    if (!sameIdentity(actual, binding.identity)) {
      this.retireTask(task, 'The Codex process changed; the previous task binding was retired.')
      const agent = this.latestAgents.get(task.agentId)
      if (agent) await this.reconcileSnapshot({
        capturedAt: new Date().toISOString(),
        agents: [...this.latestAgents.values()],
        discovered: [],
        capabilities: {
          platform: process.platform,
          terminals: [],
          tmux: true,
          wmctrl: false,
          xdotool: false,
          docker: false,
          homeDirectory: '',
        },
        scanError: null,
      })
      throw new Error('The Codex process changed after this task was observed; remote input was refused.')
    }
    return binding
  }

  private retireTask(task: PersistedTask, summary: string): void {
    const current = this.ledger.getTask(task.id)
    if (!current?.active) return
    this.tmuxBindings.delete(task.id)
    const changed = this.ledger.transitionTask({
      taskId: current.id,
      status: 'interrupted',
      summary,
      active: false,
      eventType: 'task.binding_retired',
    })
    if (changed.event) this.callbacks.publishRemote(changed.event)
  }

  private requireStructuredTask(taskId: string): PersistedTask {
    const task = this.ledger.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (task.adapter !== 'codex-structured' || !task.active) throw new Error('The structured Codex task is not active.')
    return task
  }

  private transitionStructuredAction(
    taskId: string,
    status: CoreTaskRecord['status'],
    summary: string,
    active: boolean,
    eventType: string,
  ): void {
    const changed = this.ledger.transitionTask({ taskId, status, summary, active, eventType })
    if (changed.event) this.callbacks.publishRemote(changed.event)
  }

  private onStructuredApproval(request: CodexApprovalRequest): void {
    if (this.stopped) return
    try {
      const recorded = this.ledger.recordApproval({
        id: request.id,
        taskId: request.taskId,
        promptSummary: request.summary,
        createdAt: request.createdAt,
        expiresAt: new Date(Date.parse(request.createdAt) + APPROVAL_LIFETIME_MS).toISOString(),
      })
      if (recorded.event) this.callbacks.publishRemote(recorded.event)
    } catch (error) {
      console.error('Console Core could not record a structured Codex approval', error)
    }
  }

  private onStructuredEvent(event: CodexAdapterEvent): void {
    if (this.stopped) return
    // These action acknowledgements are recorded by the desktop method or by
    // TaskCommandService's claim/complete transaction, so recording them here
    // would race the durable request receipt version.
    if (['task.message_delivered', 'approval.resolved', 'agent.message'].includes(event.type)) return
    if (this.structuredActionsInFlight.has(event.taskId)) {
      const pending = this.deferredStructuredEvents.get(event.taskId) ?? []
      pending.push(event)
      this.deferredStructuredEvents.set(event.taskId, pending)
      return
    }
    this.recordStructuredEvent(event)
  }

  private recordStructuredEvent(event: CodexAdapterEvent): void {
    const task = this.ledger.getTask(event.taskId)
    if (!task || task.adapter !== 'codex-structured') return
    try {
      const changed = this.ledger.transitionTask({
        taskId: event.taskId,
        status: structuredStatus(event.status),
        summary: event.summary,
        active: structuredActive(event.status),
        eventType: event.type,
        updatedAt: event.createdAt,
      })
      if (changed.event) this.callbacks.publishRemote(changed.event)
    } catch (error) {
      console.error('Console Core could not record a structured Codex event', error)
    }
  }

  private async withStructuredRemoteAction<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    this.structuredActionsInFlight.add(taskId)
    try {
      return await operation()
    } finally {
      this.structuredActionsInFlight.delete(taskId)
      setImmediate(() => {
        const events = this.deferredStructuredEvents.get(taskId) ?? []
        this.deferredStructuredEvents.delete(taskId)
        for (const event of events) this.recordStructuredEvent(event)
      })
    }
  }
}

export function createDefaultCoreTaskRuntimeDependencies(version: string): CoreTaskRuntimeDependencies {
  return {
    tmuxControl: new TmuxControlAdapter(),
    createStructuredCodex: (callbacks) => new CodexAppServerAdapter(version, callbacks),
  }
}
