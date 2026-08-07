import { CORE_RPC_ERROR, CoreRpcException } from '../../shared/core-protocol'
import type {
  RemoteActionResult,
  RemoteApprovalDecisionParams,
  RemoteEvent,
  RemoteTaskAdapter,
  RemoteTaskInterruptParams,
  RemoteTaskMessageParams,
  RemoteWriteEnvelope,
} from '../../shared/remote-protocol'
import { REMOTE_MAX_MESSAGE_BYTES } from '../../shared/remote-validation'
import { TaskLedger, type PersistedTask } from './task-ledger'

const MAX_WRITE_LIFETIME_MS = 60_000
const MAX_CLOCK_SKEW_MS = 30_000

export interface TaskActionAdapter {
  message(input: { task: PersistedTask; message: string }): Promise<{ ok: boolean }>
  interrupt(input: { task: PersistedTask }): Promise<{ ok: boolean }>
  decideApproval(input: {
    task: PersistedTask
    approvalId: string
    decision: 'approve' | 'reject'
  }): Promise<{ ok: boolean }>
}

export type TaskActionAdapters = Partial<Record<RemoteTaskAdapter, TaskActionAdapter>>

type EventPublisher = (event: RemoteEvent) => void

function isIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
}

function validateEnvelope(input: RemoteWriteEnvelope): void {
  if (!isIdentifier(input.requestId)) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'requestId is invalid.')
  }
  if (!isIdentifier(input.taskId)) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'taskId is invalid.')
  }
  if (!input.actor || !isIdentifier(input.actor.userId) || !isIdentifier(input.actor.deviceId)) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'A verified user and device identity are required.')
  }
  if (!Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'expectedTaskVersion must be a positive integer.')
  }
  const issuedAt = Date.parse(input.issuedAt)
  const expiresAt = Date.parse(input.expiresAt)
  const now = Date.now()
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'Remote request timestamps are invalid.')
  }
  if (expiresAt - issuedAt > MAX_WRITE_LIFETIME_MS || issuedAt > now + MAX_CLOCK_SKEW_MS || expiresAt <= now) {
    throw new CoreRpcException(CORE_RPC_ERROR.REQUEST_EXPIRED, 'The remote write request has expired.')
  }
}

/**
 * Serializes task writes and provides claim-before-effect semantics.
 * Adapter implementations are injected by the local Core; no raw protocol is
 * exposed to the Gateway and no request body is persisted.
 */
export class TaskCommandService {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly ledger: TaskLedger,
    private readonly adapters: TaskActionAdapters,
    private readonly publish: EventPublisher = () => undefined,
  ) {}

  hasAdapter(adapter: RemoteTaskAdapter): boolean {
    return Boolean(this.adapters[adapter])
  }

  message(input: RemoteTaskMessageParams, effectGuard: () => void = () => undefined): Promise<RemoteActionResult> {
    validateEnvelope(input)
    if (
      typeof input.message !== 'string'
      || !input.message.trim()
      || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input.message)
    ) {
      throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'message must be non-empty plain text.')
    }
    if (Buffer.byteLength(input.message, 'utf8') > REMOTE_MAX_MESSAGE_BYTES) {
      throw new CoreRpcException(CORE_RPC_ERROR.MESSAGE_TOO_LARGE, 'Remote message exceeds 8 KiB.')
    }
    return this.enqueue(input.taskId, () => this.execute(
      'task.message',
      input,
      { message: input.message },
      effectGuard,
      (adapter, task) => adapter.message({ task, message: input.message }),
      {
        successAction: 'message_sent',
        successMessage: 'The Agent accepted the remote message.',
        failureAction: 'message_rejected',
        failureMessage: 'The Agent did not accept the remote message.',
        nextStatus: 'running',
        active: true,
        summary: 'Agent received a remote message.',
        eventType: 'task.message_received',
      },
    ))
  }

  interrupt(input: RemoteTaskInterruptParams, effectGuard: () => void = () => undefined): Promise<RemoteActionResult> {
    validateEnvelope(input)
    return this.enqueue(input.taskId, () => this.execute(
      'task.interrupt',
      input,
      {},
      effectGuard,
      (adapter, task) => adapter.interrupt({ task }),
      {
        successAction: 'interrupted',
        successMessage: 'The Agent task was interrupted.',
        failureAction: 'interrupt_rejected',
        failureMessage: 'The Agent task could not be interrupted.',
        nextStatus: 'interrupted',
        active: false,
        summary: 'Agent task was interrupted remotely.',
        eventType: 'task.interrupted',
      },
    ))
  }

  decideApproval(input: RemoteApprovalDecisionParams, effectGuard: () => void = () => undefined): Promise<RemoteActionResult> {
    validateEnvelope(input)
    if (!isIdentifier(input.approvalId) || !['approve', 'reject'].includes(input.decision)) {
      throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'Approval decision is invalid.')
    }
    const approval = this.ledger.getApproval(input.approvalId)
    if (!approval || approval.taskId !== input.taskId) {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Approval not found for this task.')
    }
    if (approval.status !== 'pending') {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Approval is no longer pending.')
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      throw new CoreRpcException(CORE_RPC_ERROR.REQUEST_EXPIRED, 'Approval has expired.')
    }
    return this.enqueue(input.taskId, () => this.execute(
      'approval.decide',
      input,
      { approvalId: input.approvalId, decision: input.decision },
      () => {
        effectGuard()
        const current = this.ledger.getApproval(input.approvalId)
        if (!current || current.taskId !== input.taskId || current.status !== 'pending') {
          throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Approval is no longer pending.')
        }
        if (Date.parse(current.expiresAt) <= Date.now()) {
          throw new CoreRpcException(CORE_RPC_ERROR.REQUEST_EXPIRED, 'Approval has expired.')
        }
      },
      (adapter, task) => adapter.decideApproval({
        task,
        approvalId: input.approvalId,
        decision: input.decision,
      }),
      {
        successAction: input.decision === 'approve' ? 'approved_once' : 'rejected',
        successMessage: input.decision === 'approve'
          ? 'The one-time approval was sent to the Agent.'
          : 'The approval request was rejected.',
        failureAction: 'decision_rejected',
        failureMessage: 'The Agent did not accept the approval decision.',
        nextStatus: 'running',
        active: true,
        summary: 'Agent received an approval decision.',
        eventType: 'task.approval_decided',
        approval: {
          id: input.approvalId,
          status: input.decision === 'approve' ? 'approved' : 'rejected',
          decisionSummary: input.decision === 'approve'
            ? 'A one-time approval was granted remotely.'
            : 'The approval was rejected remotely.',
        },
      },
    ))
  }

  private async execute(
    operation: string,
    envelope: RemoteWriteEnvelope,
    operationBody: unknown,
    effectGuard: () => void,
    invoke: (adapter: TaskActionAdapter, task: PersistedTask) => Promise<{ ok: boolean }>,
    completion: {
      successAction: string
      successMessage: string
      failureAction: string
      failureMessage: string
      nextStatus: PersistedTask['status']
      active: boolean
      summary: string
      eventType: string
      approval?: {
        id: string
        status: 'approved' | 'rejected'
        decisionSummary: string
      }
    },
  ): Promise<RemoteActionResult> {
    // A request may have waited behind an earlier action for the same task.
    // Recheck both its short lifetime and its live device/grant guard at the
    // queue boundary immediately before any durable claim or adapter effect.
    validateEnvelope(envelope)
    effectGuard()
    const task = this.ledger.getTask(envelope.taskId)
    if (!task) throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Task not found.')
    const adapter = this.adapters[task.adapter]
    if (!adapter) {
      throw new CoreRpcException(CORE_RPC_ERROR.ADAPTER_UNAVAILABLE, 'No local adapter is available for this task.')
    }
    const requestHash = TaskLedger.requestHash({
      operation,
      taskId: envelope.taskId,
      expectedTaskVersion: envelope.expectedTaskVersion,
      actor: envelope.actor,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      body: operationBody,
    })
    const claim = this.ledger.claimRemoteRequest({
      requestId: envelope.requestId,
      operation,
      taskId: envelope.taskId,
      expectedTaskVersion: envelope.expectedTaskVersion,
      actorUserId: envelope.actor.userId,
      actorDeviceId: envelope.actor.deviceId,
      requestHash,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
    })
    switch (claim.kind) {
      case 'duplicate':
        return claim.response
      case 'in_progress':
        throw new CoreRpcException(CORE_RPC_ERROR.REQUEST_IN_PROGRESS, 'This request is already being processed.')
      case 'unknown':
        throw new CoreRpcException(
          CORE_RPC_ERROR.REQUEST_OUTCOME_UNKNOWN,
          'The earlier request outcome is unknown and will not be repeated automatically.',
        )
      case 'not_found':
        throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Task not found.')
      case 'not_active':
        throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Task is no longer active.')
      case 'stale':
        throw new CoreRpcException(CORE_RPC_ERROR.STALE_TASK, 'Task changed before this request arrived.', {
          currentVersion: claim.task.version,
        })
      case 'claimed':
        break
    }

    try {
      const outcome = await invoke(adapter, claim.task)
      const completed = this.ledger.completeRemoteRequest({
        requestId: envelope.requestId,
        ok: outcome.ok,
        action: outcome.ok ? completion.successAction : completion.failureAction,
        message: outcome.ok ? completion.successMessage : completion.failureMessage,
        outcome: outcome.ok ? 'completed' : 'failed',
        ...(outcome.ok ? {
          nextStatus: completion.nextStatus,
          active: completion.active,
          summary: completion.summary,
          eventType: completion.eventType,
          ...(completion.approval ? { approval: completion.approval } : {}),
        } : {}),
      })
      for (const event of completed.events) this.publish(event)
      return completed.response
    } catch (error) {
      this.ledger.markRemoteRequestUnknown(envelope.requestId)
      if (error instanceof CoreRpcException) throw error
      throw new CoreRpcException(
        CORE_RPC_ERROR.REQUEST_OUTCOME_UNKNOWN,
        'The local adapter did not return a durable outcome; this action will not be retried automatically.',
      )
    }
  }

  private enqueue<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const settled = next.then(() => undefined, () => undefined)
    this.queues.set(taskId, settled)
    void settled.finally(() => {
      if (this.queues.get(taskId) === settled) this.queues.delete(taskId)
    })
    return next
  }
}
