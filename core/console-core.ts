import path from 'node:path'
import {
  CORE_PROTOCOL_VERSION,
  CORE_RPC_ERROR,
  CoreRpcException,
  isMethodAllowedForChannel,
  type CoreBootstrapResult,
  type CoreConfigCommitParams,
  type CoreConfigResult,
  type CoreHandlerMethod,
  type CorePreparedAgent,
  type CorePreparedProject,
  type CoreRequestContext,
} from '../shared/core-protocol'
import type { ActionResult, AgentConfig, CoreHealth, RuntimeSnapshot } from '../shared/types'
import type {
  RemoteCapabilities,
  RemoteEventsParams,
} from '../shared/remote-protocol'
import {
  CoreTaskRuntime,
  type CoreTaskRuntimeDependencies,
} from './adapters/core-task-runtime'
import {
  createRemoteAgentDetail,
  createRemoteDashboard,
  remoteTaskView,
} from './remote-projection'
import { ProcessMonitor } from './services/process-monitor'
import { SessionManager } from './services/session-manager'
import { StateStore, stateRevision } from './services/state-store'
import { commandExists, SystemManager } from './services/system-manager'
import {
  TaskLedger,
  type SnapshotTaskAdapterSelector,
} from './services/task-ledger'
import {
  TaskCommandService,
  type TaskActionAdapters,
} from './services/task-command-service'
import {
  CoreRemoteManager,
  type CoreRemoteRuntimeOptions,
} from './remote/core-remote-manager'

type DesktopEventPublisher = (type: string, payload: unknown) => void

export interface ConsoleCoreOptions {
  taskAdapters?: TaskActionAdapters
  selectSnapshotAdapter?: SnapshotTaskAdapterSelector
  runtime?: CoreTaskRuntimeDependencies
  remote?: CoreRemoteRuntimeOptions
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'Request parameters must be an object.')
  }
  return value as Record<string, unknown>
}

function identifier(params: unknown, key: string): string {
  const value = record(params)[key]
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, `${key} is invalid.`)
  }
  return value
}

export class ConsoleCore {
  private readonly store: StateStore
  private readonly system = new SystemManager()
  private readonly sessions = new SessionManager()
  private readonly monitor: ProcessMonitor
  private ledger: TaskLedger | null = null
  private commands: TaskCommandService | null = null
  private taskRuntime: CoreTaskRuntime | null = null
  private remoteManager: CoreRemoteManager | null = null
  private publishDesktop: DesktopEventPublisher = () => undefined
  private currentRevision = ''
  private commitQueue: Promise<void> = Promise.resolve()
  private snapshotQueue: Promise<void> = Promise.resolve()
  private started = false
  private structuredCodex: CoreHealth['structuredCodex'] = 'unavailable'
  private readonly startedAt = new Date().toISOString()

  constructor(
    private readonly userDataPath: string,
    private readonly appVersion: string,
    private readonly options: ConsoleCoreOptions = {},
  ) {
    this.store = new StateStore(userDataPath)
    this.monitor = new ProcessMonitor(() => this.store.current, this.system)
  }

  setDesktopEventPublisher(publisher: DesktopEventPublisher): void {
    this.publishDesktop = publisher
  }

  setClientCount(channel: 'desktop' | 'gateway', count: number): void {
    if (channel === 'desktop') this.monitor.setActiveClients(count)
  }

  async start(): Promise<void> {
    if (this.started) return
    const state = await this.store.load()
    await this.store.createPreCoreSnapshot('v0.4')
    this.currentRevision = stateRevision(state)
    this.ledger = new TaskLedger(path.join(this.userDataPath, 'console-core.sqlite'))
    this.taskRuntime = this.options.runtime
      ? new CoreTaskRuntime(this.ledger, this.options.runtime, {
          publishRemote: () => undefined,
          publishDesktop: (type, payload) => this.publishDesktop(type, payload),
        })
      : null
    this.commands = new TaskCommandService(
      this.ledger,
      { ...this.taskRuntime?.actionAdapters(), ...this.options.taskAdapters },
      () => undefined,
    )
    this.structuredCodex = this.taskRuntime && await commandExists('codex') ? 'deferred' : 'unavailable'
    this.monitor.subscribe((snapshot) => {
      this.publishDesktop('runtime.snapshot', snapshot)
      const update = async () => {
        try {
          if (this.taskRuntime) {
            await this.taskRuntime.reconcileSnapshot(snapshot, this.options.selectSnapshotAdapter)
          } else {
            this.ledger?.updateFromSnapshot(snapshot, this.options.selectSnapshotAdapter)
          }
        } catch (error) {
          console.error('Console Core could not update its local task ledger', error)
        }
      }
      this.snapshotQueue = this.snapshotQueue.then(update, update)
    })
    this.monitor.start()
    await this.monitor.scan(false)
    await this.snapshotQueue
    this.remoteManager = new CoreRemoteManager({
      ...this.options.remote,
      userDataPath: this.userDataPath,
      appVersion: this.appVersion,
      startedAt: this.startedAt,
      actions: {
        dashboard: () => this.remoteDashboard(),
        agent: (agentId) => this.remoteAgent(agentId),
        task: (taskId) => {
          const task = this.requireLedger().getTask(taskId)
          if (!task) throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Task not found.')
          return remoteTaskView(task)
        },
        events: (params) => this.remoteEvents(params),
        message: (params, effectGuard) => this.requireCommands().message(params, effectGuard),
        interrupt: (params, effectGuard) => this.requireCommands().interrupt(params, effectGuard),
        decideApproval: (params, effectGuard) => this.requireCommands().decideApproval(params, effectGuard),
      },
      getConsoleState: () => this.store.current,
      publishDesktop: (type, payload) => this.publishDesktop(type, payload),
    })
    await this.remoteManager.start()
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started && !this.ledger && !this.remoteManager && !this.taskRuntime) return
    this.monitor.stop()
    await this.snapshotQueue
    await this.store.flush()
    await this.remoteManager?.stop()
    this.remoteManager = null
    this.taskRuntime?.stop()
    this.taskRuntime = null
    this.commands = null
    this.ledger?.close()
    this.ledger = null
    this.started = false
  }

  async handle(method: CoreHandlerMethod, params: unknown, context: CoreRequestContext): Promise<unknown> {
    if (!this.started) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Console Core is still starting.')
    if (!isMethodAllowedForChannel(method, context.channel)) {
      throw new CoreRpcException(CORE_RPC_ERROR.FORBIDDEN_CHANNEL, `Method is not available on ${context.channel}.`)
    }
    if (method.startsWith('remote.')) return this.requireRemoteManager().handle(method, params, context)
    switch (method) {
      case 'core.health':
        return this.health()
      case 'core.bootstrap':
        return this.bootstrap()
      case 'core.flush':
        await this.flush()
        return { ok: true }
      case 'config.get':
        return this.config()
      case 'config.commit':
        return this.commit(params)
      case 'runtime.get':
        return this.monitor.current ?? this.monitor.scan(false)
      case 'runtime.refresh':
        return this.monitor.scan(true)
      case 'terminal.open':
        return this.prepareAgent(identifier(params, 'agentId'), true)
      case 'terminal.close':
        return this.prepareAgent(identifier(params, 'agentId'), false)
      case 'project.restore':
        return this.prepareProject(identifier(params, 'projectId'))
      case 'task.list':
        return this.requireLedger().listTasks()
      case 'task.get': {
        const task = this.requireLedger().getTask(identifier(params, 'taskId'))
        if (!task) throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Task not found.')
        return task
      }
      case 'approval.list':
        return this.requireLedger().listApprovals()
      case 'approval.get': {
        const approval = this.requireLedger().getApproval(identifier(params, 'approvalId'))
        if (!approval) throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Approval not found.')
        return approval
      }
      case 'task.start': {
        const values = record(params)
        return this.withRuntime(() => this.requireTaskRuntime().startStructured(
          this.findAgent(identifier(values, 'agentId')),
          values.prompt,
        ))
      }
      case 'task.message': {
        const values = record(params)
        return this.withRuntime(() => this.requireTaskRuntime().messageStructured(
          identifier(values, 'taskId'),
          typeof values.message === 'string' ? values.message : '',
        ))
      }
      case 'task.interrupt':
        return this.withRuntime(() => this.requireTaskRuntime().interruptStructured(identifier(params, 'taskId')))
      case 'approval.decide': {
        const values = record(params)
        if (values.decision !== 'approve' && values.decision !== 'reject') {
          throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'decision must be approve or reject.')
        }
        const decision = values.decision
        return this.withRuntime(() => this.requireTaskRuntime().decideStructuredApproval(
          identifier(values, 'taskId'),
          identifier(values, 'approvalId'),
          decision,
        ))
      }
    }
  }

  private health(): CoreHealth {
    return {
      appVersion: this.appVersion,
      protocolVersion: CORE_PROTOCOL_VERSION,
      startedAt: this.startedAt,
      pid: process.pid,
      transport: 'unix',
      stateRevision: this.currentRevision,
      structuredCodex: this.structuredCodex,
      tcpListening: false,
    }
  }

  private async bootstrap(): Promise<CoreBootstrapResult> {
    const snapshot = this.monitor.current ?? await this.monitor.scan(true)
    return {
      state: this.store.current,
      stateRevision: this.currentRevision,
      snapshot,
      stateNotice: this.store.loadNotice,
      health: this.health(),
    }
  }

  private config(): CoreConfigResult {
    return { state: this.store.current, stateRevision: this.currentRevision }
  }

  private commit(params: unknown): Promise<CoreConfigResult> {
    const operation = this.commitQueue.then(async () => {
      const value = record(params) as unknown as CoreConfigCommitParams
      if (typeof value.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedRevision)) {
        throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'expectedRevision must be a SHA-256 revision.')
      }
      if (value.expectedRevision !== this.currentRevision) {
        throw new CoreRpcException(CORE_RPC_ERROR.STALE_STATE, 'The saved configuration changed in another client.', {
          currentRevision: this.currentRevision,
        })
      }
      const state = await this.store.save(value.state)
      this.currentRevision = stateRevision(state)
      this.monitor.restart()
      void this.monitor.scan(true).catch((error) => {
        console.error('Console Core could not refresh after saving configuration', error)
      })
      const result = { state, stateRevision: this.currentRevision }
      this.publishDesktop('config.changed', result)
      this.remoteManager?.notifyConsoleSettingsChanged()
      return result
    })
    this.commitQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async prepareAgent(agentId: string, ensureSession: boolean): Promise<CorePreparedAgent> {
    const agent = this.findAgent(agentId)
    const runtimePid = this.monitor.current?.agents.find((item) => item.id === agent.id)?.pid ?? agent.pid ?? null
    const preparation = ensureSession && agent.tmuxSession
      ? await this.sessions.ensureTmuxSession(agent)
      : { ok: true, action: 'prepared', message: `${agent.name} is ready for the desktop terminal.` }
    return { agent, runtimePid, preparation }
  }

  private async prepareProject(projectId: string): Promise<CorePreparedProject> {
    if (!this.store.current.projects.some((project) => project.id === projectId)) {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Project not found.')
    }
    const configs = this.store.current.agents
      .filter((agent) => agent.projectId === projectId)
      .filter((agent) => agent.autoStart || agent.tmuxSession || agent.command)
      .sort((a, b) => a.order - b.order)
    if (configs.length === 0) {
      return {
        agents: [],
        preparationResults: [{ ok: false, action: 'empty', message: 'No launch command or tmux session is configured in this project.' }],
      }
    }
    const agents: CorePreparedAgent[] = []
    const preparationResults: ActionResult[] = []
    for (const config of configs) {
      const prepared = await this.prepareAgent(config.id, true)
      agents.push(prepared)
      preparationResults.push(prepared.preparation)
    }
    return { agents, preparationResults }
  }

  private remoteDashboard() {
    const snapshot: RuntimeSnapshot | null = this.monitor.current
    if (!snapshot) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'No runtime snapshot is available yet.')
    const ledger = this.requireLedger()
    return createRemoteDashboard(
      snapshot,
      ledger.listTasks(),
      this.remoteCursor(),
      (task) => this.remoteCapabilities(task),
    )
  }

  private remoteAgent(agentId: string) {
    const snapshot: RuntimeSnapshot | null = this.monitor.current
    if (!snapshot) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'No runtime snapshot is available yet.')
    const ledger = this.requireLedger()
    const result = createRemoteAgentDetail(
      snapshot,
      ledger.listTasks(agentId),
      ledger.listApprovals(),
      this.remoteCursor(),
      (task) => this.remoteCapabilities(task),
      agentId,
    )
    if (!result) throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Agent not found.')
    return result
  }

  private remoteEvents(params: unknown) {
    const value = record(params) as unknown as RemoteEventsParams
    if (!Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0) {
      throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'afterSeq must be a non-negative integer.')
    }
    if (value.limit != null && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 1_000)) {
      throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'limit must be between 1 and 1000.')
    }
    const ledger = this.requireLedger()
    const result = ledger.events(value.afterSeq, value.limit, value.taskId)
    if (value.streamId && value.streamId !== result.streamId) {
      return { ...result, events: [], resetRequired: true }
    }
    return result
  }

  private remoteCursor() {
    const ledger = this.requireLedger()
    const latestSeq = ledger.latestEventSeq()
    const result = ledger.events(latestSeq, 1)
    return {
      streamId: result.streamId,
      oldestAvailableSeq: result.oldestAvailableSeq,
      latestSeq: result.latestSeq,
    }
  }

  private remoteCapabilities(task: import('./services/task-ledger').PersistedTask | null): RemoteCapabilities {
    const actionable = Boolean(task && (
      this.taskRuntime ? this.taskRuntime.canAct(task) : this.commands?.hasAdapter(task.adapter) && task.active
    ))
    return {
      view: true,
      viewEvents: true,
      message: actionable,
      approve: actionable && task?.adapter === 'codex-structured',
      interrupt: actionable,
    }
  }

  private async flush(): Promise<void> {
    await this.commitQueue
    await this.store.flush()
  }

  private findAgent(agentId: string): AgentConfig {
    const agent = this.store.current.agents.find((item) => item.id === agentId)
    if (!agent) throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Agent not found.')
    return agent
  }

  private requireLedger(): TaskLedger {
    if (!this.ledger) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Task ledger is not ready.')
    return this.ledger
  }

  private requireCommands(): TaskCommandService {
    if (!this.commands) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Task command service is not ready.')
    return this.commands
  }

  private requireTaskRuntime(): CoreTaskRuntime {
    if (!this.taskRuntime) {
      throw new CoreRpcException(CORE_RPC_ERROR.ADAPTER_UNAVAILABLE, 'Structured Codex runtime is not available.')
    }
    return this.taskRuntime
  }

  private requireRemoteManager(): CoreRemoteManager {
    if (!this.remoteManager) {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Remote manager is not ready.')
    }
    return this.remoteManager
  }

  onConnectionClosed(connectionId: string, channel: 'desktop' | 'gateway'): void {
    if (channel === 'gateway') this.remoteManager?.closeConnection(connectionId)
  }

  private async withRuntime<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof CoreRpcException) throw error
      throw new CoreRpcException(
        CORE_RPC_ERROR.NOT_ACTIONABLE,
        error instanceof Error ? error.message : 'The local task runtime rejected this action.',
      )
    }
  }
}
