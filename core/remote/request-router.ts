import { randomUUID } from 'node:crypto'
import { CORE_RPC_ERROR, CoreRpcException } from '../../shared/core-protocol'
import type {
  RemoteAgentDetail,
  RemoteApprovalDecisionParams,
  RemoteDashboard,
  RemoteEventsParams,
  RemoteEventsResult,
  RemoteTaskInterruptParams,
  RemoteTaskMessageParams,
  RemoteTaskView,
} from '../../shared/remote-protocol'
import {
  REMOTE_MAX_MESSAGE_BYTES,
  requireOpaqueId,
  requireRecord,
  type GatewayEvent,
  type RemoteDispatchEnvelope,
  type RemoteDispatchResponse,
  type RemoteEventStreamPollResult,
} from '../../shared/remote-validation'
import {
  RemoteAuthorizationService,
  RemoteSecurityError,
  type AuthorizedRemoteRequest,
} from './authorization-service'
import type { PairingService } from './pairing-service'
import type { RemoteIdempotencyService } from './idempotency-service'

const MAX_STREAMS = 32
const MAX_STREAMS_PER_DEVICE = 8
const STREAM_LIFETIME_MS = 5 * 60 * 1_000

interface RateWindow {
  startedAt: number
  count: number
}

class AuthenticatedRateLimiter {
  private readonly windows = new Map<string, RateWindow>()

  take(key: string, limit: number, now: number): boolean {
    if (this.windows.size > 4_096) {
      for (const [candidate, window] of this.windows) {
        if (now - window.startedAt >= 120_000) this.windows.delete(candidate)
      }
      if (this.windows.size > 4_096) return false
    }
    const current = this.windows.get(key)
    if (!current || now - current.startedAt >= 60_000) {
      this.windows.set(key, { startedAt: now, count: 1 })
      return true
    }
    current.count += 1
    return current.count <= limit
  }

  clear(): void {
    this.windows.clear()
  }
}

export interface RemoteCoreActions {
  dashboard(): Promise<RemoteDashboard> | RemoteDashboard
  agent(agentId: string): Promise<RemoteAgentDetail> | RemoteAgentDetail
  task(taskId: string): Promise<RemoteTaskView> | RemoteTaskView
  events(params: RemoteEventsParams): Promise<RemoteEventsResult> | RemoteEventsResult
  message(params: RemoteTaskMessageParams, effectGuard: () => void): Promise<unknown> | unknown
  interrupt(params: RemoteTaskInterruptParams, effectGuard: () => void): Promise<unknown> | unknown
  decideApproval(params: RemoteApprovalDecisionParams, effectGuard: () => void): Promise<unknown> | unknown
}

export interface CoreRemoteStreamOpenResult {
  streamId: string
  expiresAt: string
}

interface StreamState {
  id: string
  connectionId: string
  authorized: AuthorizedRemoteRequest
  params: RemoteEventsParams
  afterSeq: number
  sourceStreamId: string | undefined
  expiresAtMs: number
}

interface AuthorizedEventsResult {
  result: RemoteEventsResult
  /** Last raw ledger sequence examined, including events hidden by grants. */
  scannedThroughSeq: number
}

function parseJsonBody(envelope: RemoteDispatchEnvelope, expectedKeys: readonly string[]): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(envelope.bodyBase64, 'base64').toString('utf8'))
  } catch {
    throw new RemoteSecurityError(400, 'INVALID_JSON', 'Request body must be valid JSON.')
  }
  const body = requireRecord(parsed, 'Request body')
  const actual = Object.keys(body).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteSecurityError(400, 'INVALID_BODY', 'Request body contains unknown or missing fields.')
  }
  return body
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RemoteSecurityError(400, 'INVALID_TASK_VERSION', 'Task version is invalid.')
  }
  return Number(value)
}

function safeMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
    throw new RemoteSecurityError(400, 'INVALID_MESSAGE', 'Message must be non-empty plain text.')
  }
  if (Buffer.byteLength(value, 'utf8') > REMOTE_MAX_MESSAGE_BYTES) {
    throw new RemoteSecurityError(413, 'MESSAGE_TOO_LARGE', 'Message exceeds 8 KiB.')
  }
  return value
}

function queryParams(target: string): URLSearchParams {
  const url = new URL(target, 'http://127.0.0.1')
  for (const key of new Set(url.searchParams.keys())) {
    if (url.searchParams.getAll(key).length !== 1) {
      throw new RemoteSecurityError(400, 'DUPLICATE_QUERY', 'Request query is invalid.')
    }
  }
  return url.searchParams
}

function eventsParams(target: string): RemoteEventsParams {
  const query = queryParams(target)
  const allowed = new Set(['afterSeq', 'limit', 'taskId', 'streamId'])
  if ([...query.keys()].some((key) => !allowed.has(key))) {
    throw new RemoteSecurityError(400, 'INVALID_QUERY', 'Event query is invalid.')
  }
  const afterText = query.get('afterSeq') ?? '0'
  const limitText = query.get('limit')
  if (!/^\d{1,16}$/.test(afterText) || limitText && !/^\d{1,4}$/.test(limitText)) {
    throw new RemoteSecurityError(400, 'INVALID_QUERY', 'Event cursor is invalid.')
  }
  const afterSeq = Number(afterText)
  const limit = limitText ? Number(limitText) : 100
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || limit < 1 || limit > 1_000) {
    throw new RemoteSecurityError(400, 'INVALID_QUERY', 'Event cursor is invalid.')
  }
  const taskId = query.get('taskId') ?? undefined
  const streamId = query.get('streamId') ?? undefined
  if (taskId) requireOpaqueId(taskId, 'Task ID')
  if (streamId) requireOpaqueId(streamId, 'Stream ID')
  return { afterSeq, limit, ...(taskId ? { taskId } : {}), ...(streamId ? { streamId } : {}) }
}

function writeTimestamps(authorized: AuthorizedRemoteRequest): { issuedAt: string; expiresAt: string } {
  const issued = authorized.verified.timestampSeconds * 1_000
  return { issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + 60_000).toISOString() }
}

function publicFailure(error: unknown): RemoteDispatchResponse {
  if (error instanceof RemoteSecurityError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } }
  }
  if (error instanceof CoreRpcException) {
    if (error.code === CORE_RPC_ERROR.NOT_FOUND) {
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Requested Agent task was not found.' } } }
    }
    if ([CORE_RPC_ERROR.CONFLICT, CORE_RPC_ERROR.STALE_TASK, CORE_RPC_ERROR.NOT_ACTIONABLE,
      CORE_RPC_ERROR.REQUEST_IN_PROGRESS, CORE_RPC_ERROR.REQUEST_OUTCOME_UNKNOWN].includes(error.code as never)) {
      return { status: 409, body: { error: { code: 'ACTION_CONFLICT', message: 'Remote action cannot be applied to the current task state.' } } }
    }
    if (error.code === CORE_RPC_ERROR.REQUEST_EXPIRED) {
      return { status: 408, body: { error: { code: 'REQUEST_EXPIRED', message: 'Remote action has expired.' } } }
    }
    if (error.code === CORE_RPC_ERROR.TOO_MANY_REQUESTS) {
      return { status: 429, headers: { 'retry-after': '60' }, body: { error: { code: 'TOO_MANY_REQUESTS', message: 'Local Core is busy.' } } }
    }
  }
  return { status: 503, body: { error: { code: 'CORE_UNAVAILABLE', message: 'Local Core is unavailable.' } } }
}

function isIdempotentWriteRoute(method: string, path: string): boolean {
  if (method !== 'POST') return false
  return /^\/v1\/tasks\/[a-zA-Z0-9_.:-]{1,160}\/(?:messages|interrupt)$/.test(path)
    || /^\/v1\/approvals\/[a-zA-Z0-9_.:-]{1,160}\/decision$/.test(path)
}

/** Runs only inside the long-lived Core process. */
export class CoreRemoteRequestRouter {
  private readonly streams = new Map<string, StreamState>()
  private readonly activeByDevice = new Map<string, number>()
  private readonly authenticatedLimiter = new AuthenticatedRateLimiter()

  constructor(
    private readonly actions: RemoteCoreActions,
    private readonly authorization: RemoteAuthorizationService,
    private readonly pairing: PairingService,
    private readonly idempotency: RemoteIdempotencyService,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(envelope: RemoteDispatchEnvelope): Promise<RemoteDispatchResponse> {
    const target = new URL(envelope.target, 'http://127.0.0.1')
    const path = target.pathname
    let releaseCapacity: () => void = () => undefined
    try {
      if (target.search && path !== '/v1/events') {
        throw new RemoteSecurityError(400, 'INVALID_QUERY', 'This Gateway route does not accept query parameters.')
      }
      if (envelope.method === 'POST' && /^\/v1\/pairings\/[0-9a-f-]{36}\/claim$/i.test(path)) {
        return { status: 202, body: await this.pairing.claim(envelope) }
      }
      const authorized = await this.authorization.authorize({
        envelope,
        allowIdempotentReplay: isIdempotentWriteRoute(envelope.method, path),
        beforeTokenVerification: ({ device }) => {
          releaseCapacity = this.claimAuthenticatedCapacity(device.id, envelope.method, path)
        },
      })
      if (envelope.method === 'GET' && path === '/v1/dashboard') {
        return { status: 200, body: this.filterDashboard(await this.actions.dashboard(), authorized) }
      }
      const agentMatch = /^\/v1\/agents\/([a-zA-Z0-9_.:-]{1,160})$/.exec(path)
      if (envelope.method === 'GET' && agentMatch) {
        this.authorization.requirePermission(authorized, 'view', agentMatch[1])
        return { status: 200, body: this.filterAgentDetail(await this.actions.agent(agentMatch[1]), authorized) }
      }
      const taskMatch = /^\/v1\/tasks\/([a-zA-Z0-9_.:-]{1,160})$/.exec(path)
      if (envelope.method === 'GET' && taskMatch) {
        const task = await this.actions.task(taskMatch[1])
        this.authorization.requirePermission(authorized, 'view', task.agentId)
        return { status: 200, body: task }
      }
      if (envelope.method === 'GET' && path === '/v1/events') {
        return { status: 200, body: (await this.authorizedEvents(envelope.target, authorized)).result }
      }
      const messageMatch = /^\/v1\/tasks\/([a-zA-Z0-9_.:-]{1,160})\/messages$/.exec(path)
      if (envelope.method === 'POST' && messageMatch) {
        const task = await this.actions.task(messageMatch[1])
        this.authorization.requirePermission(authorized, 'message', task.agentId)
        const body = parseJsonBody(envelope, ['expectedTaskVersion', 'message'])
        const params: RemoteTaskMessageParams = {
          requestId: authorized.verified.envelope.headers.requestId,
          actor: { userId: authorized.claims.userId, deviceId: authorized.device.id },
          ...writeTimestamps(authorized),
          taskId: task.id,
          expectedTaskVersion: positiveVersion(body.expectedTaskVersion),
          message: safeMessage(body.message),
        }
        return await this.executeWrite(authorized, 'message', task.agentId, (guard) => this.actions.message(params, guard))
      }
      const interruptMatch = /^\/v1\/tasks\/([a-zA-Z0-9_.:-]{1,160})\/interrupt$/.exec(path)
      if (envelope.method === 'POST' && interruptMatch) {
        const task = await this.actions.task(interruptMatch[1])
        this.authorization.requirePermission(authorized, 'interrupt', task.agentId)
        const body = parseJsonBody(envelope, ['expectedTaskVersion'])
        const params: RemoteTaskInterruptParams = {
          requestId: authorized.verified.envelope.headers.requestId,
          actor: { userId: authorized.claims.userId, deviceId: authorized.device.id },
          ...writeTimestamps(authorized),
          taskId: task.id,
          expectedTaskVersion: positiveVersion(body.expectedTaskVersion),
        }
        return await this.executeWrite(authorized, 'interrupt', task.agentId, (guard) => this.actions.interrupt(params, guard))
      }
      const approvalMatch = /^\/v1\/approvals\/([a-zA-Z0-9_.:-]{1,160})\/decision$/.exec(path)
      if (envelope.method === 'POST' && approvalMatch) {
        const body = parseJsonBody(envelope, ['decision', 'expectedTaskVersion', 'taskId'])
        const taskId = requireOpaqueId(body.taskId, 'Task ID')
        const task = await this.actions.task(taskId)
        this.authorization.requirePermission(authorized, 'approve', task.agentId)
        if (body.decision !== 'approve' && body.decision !== 'reject') {
          throw new RemoteSecurityError(400, 'INVALID_DECISION', 'Approval decision is invalid.')
        }
        const params: RemoteApprovalDecisionParams = {
          requestId: authorized.verified.envelope.headers.requestId,
          actor: { userId: authorized.claims.userId, deviceId: authorized.device.id },
          ...writeTimestamps(authorized),
          taskId,
          expectedTaskVersion: positiveVersion(body.expectedTaskVersion),
          approvalId: approvalMatch[1],
          decision: body.decision,
        }
        return await this.executeWrite(authorized, 'approve', task.agentId, (guard) => this.actions.decideApproval(params, guard))
      }
      throw new RemoteSecurityError(404, 'NOT_FOUND', 'Gateway route was not found.')
    } catch (error) {
      return publicFailure(error)
    } finally {
      releaseCapacity()
    }
  }

  async openStream(envelope: RemoteDispatchEnvelope, connectionId: string): Promise<CoreRemoteStreamOpenResult> {
    this.sweepStreams()
    if (this.streams.size >= MAX_STREAMS) throw new RemoteSecurityError(429, 'TOO_MANY_STREAMS', 'Too many event streams are active.')
    const path = new URL(envelope.target, 'http://127.0.0.1').pathname
    if (envelope.method !== 'GET' || path !== '/v1/events/stream') {
      throw new RemoteSecurityError(404, 'NOT_FOUND', 'Event stream route was not found.')
    }
    let releaseCapacity: () => void = () => undefined
    try {
      const authorized = await this.authorization.authorize({
        envelope,
        beforeTokenVerification: ({ device }) => {
          releaseCapacity = this.claimAuthenticatedCapacity(device.id, envelope.method, path)
        },
      })
      const deviceStreams = [...this.streams.values()]
        .filter((stream) => stream.authorized.device.id === authorized.device.id)
        .length
      if (deviceStreams >= MAX_STREAMS_PER_DEVICE) {
        throw new RemoteSecurityError(429, 'TOO_MANY_STREAMS', 'Too many event streams are active for this device.')
      }
      const params = eventsParams(envelope.target)
      if (params.taskId) {
        const task = await this.actions.task(params.taskId)
        this.authorization.requirePermission(authorized, 'view', task.agentId)
      }
      const now = this.now()
      const state: StreamState = {
        id: randomUUID(),
        connectionId,
        authorized,
        params,
        afterSeq: params.afterSeq,
        sourceStreamId: params.streamId,
        expiresAtMs: Math.min(now + STREAM_LIFETIME_MS, authorized.claims.expiresAt * 1_000),
      }
      this.streams.set(state.id, state)
      return { streamId: state.id, expiresAt: new Date(state.expiresAtMs).toISOString() }
    } finally {
      releaseCapacity()
    }
  }

  async pollStream(streamId: string, connectionId: string): Promise<RemoteEventStreamPollResult> {
    this.sweepStreams()
    const state = this.streams.get(requireOpaqueId(streamId, 'Remote stream ID'))
    if (!state || state.connectionId !== connectionId) {
      throw new RemoteSecurityError(404, 'STREAM_NOT_FOUND', 'Event stream is closed.')
    }
    try {
      this.authorization.assertStillAuthorized(state.authorized)
      if (!this.authenticatedLimiter.take(`poll:${state.authorized.device.id}`, 120, this.now())) {
        throw new RemoteSecurityError(429, 'TOO_MANY_REQUESTS', 'Event stream polling limit was reached.')
      }
      const authorizedEvents = await this.authorizedEvents(
        `/v1/events?${new URLSearchParams({
          afterSeq: String(state.afterSeq),
          limit: String(state.params.limit ?? 100),
          ...(state.params.taskId ? { taskId: state.params.taskId } : {}),
          ...(state.sourceStreamId ? { streamId: state.sourceStreamId } : {}),
        }).toString()}`,
        state.authorized,
      )
      const result = authorizedEvents.result
      const events: GatewayEvent[] = []
      if (result.resetRequired) {
        events.push({
          // A reset is a synthetic control event, not a committed ledger
          // record. Keep its sequence at the reserved sentinel value so a
          // client cannot mistake latestSeq for an event it actually saw.
          seq: 0,
          type: 'stream.reset',
          payload: {
            streamId: result.streamId,
            oldestAvailableSeq: result.oldestAvailableSeq,
            latestSeq: result.latestSeq,
          },
          createdAt: new Date(this.now()).toISOString(),
        })
        state.afterSeq = result.latestSeq
      } else {
        for (const event of result.events) {
          state.afterSeq = Math.max(state.afterSeq, event.seq)
          events.push({ seq: event.seq, type: event.type, payload: event, createdAt: event.createdAt })
        }
        // Hidden events still consumed ledger cursor space. Advancing past the
        // raw batch prevents a device with sparse grants from rescanning the
        // same invisible prefix forever and eventually exposes later visible
        // events without leaking their contents.
        state.afterSeq = Math.max(state.afterSeq, authorizedEvents.scannedThroughSeq)
      }
      state.sourceStreamId = result.streamId
      return { closed: false, currentSeq: state.afterSeq, events }
    } catch (error) {
      this.streams.delete(state.id)
      throw error
    }
  }

  closeStream(streamId: string, connectionId: string): boolean {
    const state = this.streams.get(streamId)
    if (!state || state.connectionId !== connectionId) return false
    this.streams.delete(streamId)
    return true
  }

  closeConnectionStreams(connectionId: string): void {
    for (const state of this.streams.values()) {
      if (state.connectionId === connectionId) this.streams.delete(state.id)
    }
  }

  close(): void {
    this.streams.clear()
    this.activeByDevice.clear()
    this.authenticatedLimiter.clear()
  }

  private claimAuthenticatedCapacity(
    deviceId: string,
    method: string,
    path: string,
  ): () => void {
    const active = (this.activeByDevice.get(deviceId) ?? 0) + 1
    if (active > 8) {
      throw new RemoteSecurityError(429, 'TOO_MANY_DEVICE_REQUESTS', 'Too many authenticated requests are active for this device.')
    }
    const approval = method === 'POST' && /^\/v1\/approvals\//.test(path)
    const write = method === 'POST'
    const category = approval ? 'approval' : write ? 'write' : 'read'
    const limit = approval ? 5 : write ? 10 : 60
    if (!this.authenticatedLimiter.take(`${category}:${deviceId}`, limit, this.now())) {
      throw new RemoteSecurityError(429, 'TOO_MANY_REQUESTS', 'Authenticated device request limit was reached.')
    }
    this.activeByDevice.set(deviceId, active)
    return () => {
      const remaining = Math.max(0, (this.activeByDevice.get(deviceId) ?? 1) - 1)
      if (remaining === 0) this.activeByDevice.delete(deviceId)
      else this.activeByDevice.set(deviceId, remaining)
    }
  }

  private async executeWrite(
    authorized: AuthorizedRemoteRequest,
    permission: 'message' | 'interrupt' | 'approve',
    agentId: string,
    action: (effectGuard: () => void) => Promise<unknown> | unknown,
  ): Promise<RemoteDispatchResponse> {
    const result = await this.idempotency.execute(authorized, async () => {
      try {
        const effectGuard = () => {
          this.authorization.assertStillAuthorized(authorized)
          this.authorization.requirePermission(authorized, permission, agentId)
        }
        effectGuard()
        return { status: 200, body: await action(effectGuard) }
      } catch (error) {
        // Known public failures are receipts too. A process crash cannot reach
        // this branch, so its pre-effect receipt remains uncertain on restart.
        return publicFailure(error)
      }
    })
    return result.response
  }

  private async authorizedEvents(target: string, authorized: AuthorizedRemoteRequest): Promise<AuthorizedEventsResult> {
    const params = eventsParams(target)
    if (params.taskId) {
      const task = await this.actions.task(params.taskId)
      this.authorization.requirePermission(authorized, 'view', task.agentId)
    }
    const result = await this.actions.events(params)
    const scannedThroughSeq = result.resetRequired
      ? result.latestSeq
      : result.events.at(-1)?.seq ?? params.afterSeq
    if (params.taskId) return { result, scannedThroughSeq }
    const visibleTaskIds = new Set<string>()
    const taskIds = [...new Set(result.events.flatMap((event) => event.taskId ? [event.taskId] : []))]
    for (const taskId of taskIds) {
      try {
        const task = await this.actions.task(taskId)
        if (this.authorization.grantFor(authorized, task.agentId)?.canView) visibleTaskIds.add(taskId)
      } catch {
        // A removed or unknown task is omitted instead of leaking its event.
      }
    }
    // Authorization is per Agent. A legacy/global event with no task owner has
    // no grant to evaluate and must therefore remain private.
    return {
      result: { ...result, events: result.events.filter((event) => event.taskId !== null && visibleTaskIds.has(event.taskId)) },
      scannedThroughSeq,
    }
  }

  private filterDashboard(dashboard: RemoteDashboard, authorized: AuthorizedRemoteRequest): RemoteDashboard {
    return {
      ...dashboard,
      agents: dashboard.agents.flatMap((agent) => {
        const grant = this.authorization.grantFor(authorized, agent.id)
        if (!grant?.canView) return []
        return [{
          ...agent,
          capabilities: {
            view: true,
            viewEvents: true,
            message: agent.capabilities.message && grant.canMessage,
            approve: agent.capabilities.approve && grant.canApprove,
            interrupt: agent.capabilities.interrupt && grant.canInterrupt,
          },
        }]
      }),
    }
  }

  private filterAgentDetail(detail: RemoteAgentDetail, authorized: AuthorizedRemoteRequest): RemoteAgentDetail {
    const grant = this.authorization.grantFor(authorized, detail.agent.id)
    if (!grant?.canView) throw new RemoteSecurityError(403, 'AGENT_PERMISSION_DENIED', 'Remote request is not authorized.')
    return {
      ...detail,
      agent: {
        ...detail.agent,
        capabilities: {
          view: true,
          viewEvents: true,
          message: detail.agent.capabilities.message && grant.canMessage,
          approve: detail.agent.capabilities.approve && grant.canApprove,
          interrupt: detail.agent.capabilities.interrupt && grant.canInterrupt,
        },
      },
      approvals: grant.canApprove ? detail.approvals : [],
    }
  }

  private sweepStreams(): void {
    const now = this.now()
    for (const stream of this.streams.values()) {
      if (stream.expiresAtMs <= now) this.streams.delete(stream.id)
    }
  }
}
