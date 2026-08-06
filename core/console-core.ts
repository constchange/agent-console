import path from 'node:path'
import {
  CORE_PROTOCOL_VERSION,
  CORE_RPC_ERROR,
  CoreRpcException,
  type CoreBootstrapResult,
  type CoreConfigCommitParams,
  type CoreConfigResult,
  type CoreHandlerMethod,
  type CorePreparedAgent,
  type CorePreparedProject,
  type CoreRemoteSnapshotResult,
  type CoreRequestContext,
} from '../shared/core-protocol'
import type { ActionResult, AgentConfig, CoreHealth, RuntimeSnapshot } from '../shared/types'
import { createRemoteSafeSnapshot } from './remote-projection'
import { ProcessMonitor } from './services/process-monitor'
import { SessionManager } from './services/session-manager'
import { StateStore, stateRevision } from './services/state-store'
import { commandExists, SystemManager } from './services/system-manager'
import { TaskLedger } from './services/task-ledger'

type EventPublisher = (type: string, payload: unknown) => void

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
  private publish: EventPublisher = () => undefined
  private currentRevision = ''
  private commitQueue: Promise<void> = Promise.resolve()
  private started = false
  private structuredCodex: CoreHealth['structuredCodex'] = 'unavailable'
  private readonly startedAt = new Date().toISOString()

  constructor(
    private readonly userDataPath: string,
    private readonly appVersion: string,
  ) {
    this.store = new StateStore(userDataPath)
    this.monitor = new ProcessMonitor(() => this.store.current, this.system)
  }

  setEventPublisher(publisher: EventPublisher): void {
    this.publish = publisher
  }

  setClientCount(count: number): void {
    this.monitor.setActiveClients(count)
  }

  async start(): Promise<void> {
    if (this.started) return
    const state = await this.store.load()
    await this.store.createPreCoreSnapshot('v0.4')
    this.currentRevision = stateRevision(state)
    this.ledger = new TaskLedger(path.join(this.userDataPath, 'console-core.sqlite'))
    this.structuredCodex = await commandExists('codex') ? 'deferred' : 'unavailable'
    this.monitor.subscribe((snapshot) => {
      try {
        this.ledger?.updateFromSnapshot(snapshot)
      } catch (error) {
        console.error('Console Core could not update its local task ledger', error)
      }
      this.publish('runtime.snapshot', snapshot)
    })
    this.monitor.start()
    await this.monitor.scan(false)
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.monitor.stop()
    await this.store.flush()
    this.ledger?.close()
    this.ledger = null
    this.started = false
  }

  async handle(method: CoreHandlerMethod, params: unknown, _context: CoreRequestContext): Promise<unknown> {
    if (!this.started) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Console Core is still starting.')
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
      case 'remote.snapshot':
        return this.remoteSnapshot()
      case 'task.start':
      case 'task.message':
      case 'task.interrupt':
      case 'approval.decide':
        throw new CoreRpcException(
          CORE_RPC_ERROR.ADAPTER_UNAVAILABLE,
          'Structured Codex control is reserved for the next stage and is not enabled in this computer-only build.',
        )
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
      this.publish('config.changed', result)
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

  private remoteSnapshot(): CoreRemoteSnapshotResult {
    const snapshot: RuntimeSnapshot | null = this.monitor.current
    if (!snapshot) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'No runtime snapshot is available yet.')
    return {
      snapshot: createRemoteSafeSnapshot(snapshot, this.requireLedger().listTasks()),
      gatewayEnabled: false,
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
}
