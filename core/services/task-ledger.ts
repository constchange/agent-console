import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CoreTaskRecord,
  CoreTaskStatus,
  RuntimeAgent,
  RuntimeSnapshot,
} from '../../shared/types'
import type {
  RemoteActionResult,
  RemoteApprovalStatus,
  RemoteApprovalView,
  RemoteEvent,
  RemoteEventsResult,
  RemoteTaskAdapter,
} from '../../shared/remote-protocol'

const SCHEMA_VERSION = 2
const MAX_REPLAY_EVENTS = 1_000
const MAX_STORED_EVENTS = 10_000
const MAX_LIVE_REQUEST_RECEIPTS_PER_DEVICE = 4_096
const MAX_LIVE_REQUEST_RECEIPTS_TOTAL = 32_768

export interface PersistedAgentObservation {
  agentId: string
  projectId: string
  displayName: string
  kind: RuntimeAgent['kind']
  status: RuntimeAgent['status']
  summary: string
  present: boolean
  firstSeenAt: string
  lastSeenAt: string
  sourceCapturedAt: string
}

export type PersistedTask = CoreTaskRecord

export interface PersistedApproval extends RemoteApprovalView {}

export interface SnapshotLedgerUpdate {
  observations: PersistedAgentObservation[]
  tasks: PersistedTask[]
  events: RemoteEvent[]
}

export type SnapshotTaskAdapterSelector = (agent: RuntimeAgent) => RemoteTaskAdapter

export interface TaskMutationResult {
  task: PersistedTask
  event: RemoteEvent | null
}

export interface LedgerStorageSettings {
  foreignKeys: boolean
  journalMode: string
  synchronous: number
  schemaVersion: number
}

export type RequestReceiptState = 'claimed' | 'completed' | 'failed' | 'unknown'

export interface ClaimRemoteRequestInput {
  requestId: string
  operation: string
  taskId: string
  expectedTaskVersion: number
  actorUserId: string
  actorDeviceId: string
  requestHash: string
  issuedAt: string
  expiresAt: string
}

export type ClaimRemoteRequestResult =
  | { kind: 'claimed'; task: PersistedTask }
  | { kind: 'duplicate'; state: 'completed' | 'failed'; response: RemoteActionResult }
  | { kind: 'in_progress' }
  | { kind: 'unknown' }
  | { kind: 'not_found' }
  | { kind: 'not_active'; task: PersistedTask }
  | { kind: 'stale'; task: PersistedTask }

export interface CompleteRemoteRequestInput {
  requestId: string
  ok: boolean
  action: string
  message: string
  outcome: 'completed' | 'failed'
  nextStatus?: CoreTaskStatus
  active?: boolean
  summary?: string
  eventType?: string
  approval?: {
    id: string
    status: Exclude<RemoteApprovalStatus, 'pending'>
    decisionSummary: string
  }
}

interface ObservationRow {
  agent_id: string
  project_id: string
  display_name: string
  kind: RuntimeAgent['kind']
  status: RuntimeAgent['status']
  summary: string
  present: number
  first_seen_at: string
  last_seen_at: string
  source_captured_at: string
}

interface TaskRow {
  task_id: string
  agent_id: string
  adapter: RemoteTaskAdapter
  status: CoreTaskStatus
  summary: string
  created_at: string
  updated_at: string
  version: number | bigint
  active: number
}

interface ApprovalRow {
  approval_id: string
  task_id: string
  status: RemoteApprovalStatus
  prompt_summary: string
  decision_summary: string
  created_at: string
  updated_at: string
  expires_at: string
}

interface EventRow {
  seq: number | bigint
  task_id: string | null
  task_version: number | bigint | null
  event_type: string
  status: string
  summary: string
  created_at: string
}

interface RequestReceiptRow {
  request_id: string
  operation: string
  task_id: string
  expected_task_version: number | bigint
  actor_user_id: string
  actor_device_id: string
  request_hash: string
  state: RequestReceiptState
  response_json: string
  issued_at: string
  expires_at: string
  created_at: string
  updated_at: string
}

function boundedInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function cleanText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || fallback).slice(0, max)
}

function publicText(value: unknown, fallback: string, max: number): string {
  return cleanText(value, fallback, max)
    .replace(/(^|\s)(?:~\/|\/)[^\s,;]+/g, '$1[private path]')
    .replace(/\b[a-zA-Z]:\\[^\s,;]+/g, '[private path]')
    .slice(0, max)
}

function identifier(value: unknown, label: string): string {
  const id = cleanText(value, '', 160)
  if (!id || !/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw new Error(`${label} may only contain letters, numbers, dot, colon, dash, and underscore.`)
  }
  return id
}

function eventType(value: unknown): string {
  const type = cleanText(value, '', 80).toLowerCase()
  if (!type || !/^[a-z0-9._-]+$/.test(type)) {
    throw new Error('Event type may only contain lowercase letters, numbers, dot, dash, and underscore.')
  }
  return type
}

function timestamp(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback
  return new Date(value).toISOString()
}

function publicSummary(agent: RuntimeAgent): string {
  const name = cleanText(agent.name, 'Agent', 100)
  const labels: Record<RuntimeAgent['status'], string> = {
    thinking: 'is working',
    running: 'is running',
    waiting: 'is waiting for input',
    idle: 'is idle',
    finished: 'has finished',
    error: 'needs attention',
    stopped: 'is stopped',
    offline: 'is offline',
  }
  return `${name} ${labels[agent.status]}.`
}

function runtimeTaskStatus(status: RuntimeAgent['status']): CoreTaskStatus {
  switch (status) {
    case 'thinking':
    case 'running':
      return 'running'
    case 'waiting':
      return 'needs_input'
    case 'finished':
      return 'completed'
    case 'error':
      return 'failed'
    case 'stopped':
      return 'interrupted'
    case 'idle':
    case 'offline':
      return 'unknown'
  }
}

function runtimeIsActive(status: RuntimeAgent['status']): boolean {
  return ['thinking', 'running', 'waiting', 'idle'].includes(status)
}

function observationFromRow(row: ObservationRow): PersistedAgentObservation {
  return {
    agentId: row.agent_id,
    projectId: row.project_id,
    displayName: row.display_name,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    present: row.present === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sourceCapturedAt: row.source_captured_at,
  }
}

function taskFromRow(row: TaskRow): PersistedTask {
  return {
    id: row.task_id,
    agentId: row.agent_id,
    adapter: row.adapter,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
    active: row.active === 1,
  }
}

function approvalFromRow(row: ApprovalRow): PersistedApproval {
  return {
    id: row.approval_id,
    taskId: row.task_id,
    status: row.status,
    promptSummary: row.prompt_summary,
    decisionSummary: row.decision_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }
}

function eventFromRow(row: EventRow): RemoteEvent {
  return {
    seq: Number(row.seq),
    taskId: row.task_id,
    taskVersion: row.task_version == null ? null : Number(row.task_version),
    type: row.event_type,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
  }
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function safeRemoteActionResult(value: unknown): RemoteActionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stored request receipt is invalid.')
  const result = value as Partial<RemoteActionResult>
  return {
    ok: Boolean(result.ok),
    requestId: identifier(result.requestId, 'Request ID'),
    taskId: identifier(result.taskId, 'Task ID'),
    taskVersion: boundedInteger(Number(result.taskVersion), 0, 0, Number.MAX_SAFE_INTEGER),
    action: cleanText(result.action, 'unknown', 80),
    message: publicText(result.message, 'Request completed.', 300),
    duplicate: Boolean(result.duplicate),
    outcome: result.outcome === 'failed' || result.outcome === 'unknown' ? result.outcome : 'completed',
  }
}

/** Local single-writer ledger. It never stores raw commands, paths, output or message text. */
export class TaskLedger {
  private readonly database: DatabaseSync
  private closed = false

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
      chmodSync(path.dirname(databasePath), 0o700)
    }
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `)
    this.initializeSchema()
    this.recoverClaimedRequests()
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600)
  }

  static requestHash(value: unknown): string {
    return canonicalHash(value)
  }

  updateFromSnapshot(
    snapshot: RuntimeSnapshot,
    selectAdapter: SnapshotTaskAdapterSelector = () => 'process-monitor',
  ): SnapshotLedgerUpdate {
    this.assertOpen()
    const capturedAt = timestamp(snapshot.capturedAt)
    const seen = new Set<string>()
    const events: RemoteEvent[] = []

    this.transaction(() => {
      for (const agent of snapshot.agents) {
        const agentId = identifier(agent.id, 'Agent ID')
        if (seen.has(agentId)) continue
        seen.add(agentId)
        const existingObservation = this.getObservationRow(agentId)
        const summary = publicSummary(agent)
        this.database.prepare(`
          INSERT INTO agent_observations (
            agent_id, project_id, display_name, kind, status, summary, present,
            first_seen_at, last_seen_at, source_captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET
            project_id = excluded.project_id,
            display_name = excluded.display_name,
            kind = excluded.kind,
            status = excluded.status,
            summary = excluded.summary,
            present = 1,
            last_seen_at = excluded.last_seen_at,
            source_captured_at = excluded.source_captured_at
        `).run(
          agentId,
          identifier(agent.projectId, 'Project ID'),
          cleanText(agent.name, 'Agent', 100),
          cleanText(agent.kind, 'process', 40),
          agent.status,
          summary,
          existingObservation?.first_seen_at ?? capturedAt,
          capturedAt,
          capturedAt,
        )

        const activeTask = this.getActiveTaskRow(agentId)
        if (runtimeIsActive(agent.status)) {
          if (!activeTask) {
            const created = this.insertTask({
              id: randomUUID(),
              agentId,
              adapter: selectAdapter(agent),
              status: runtimeTaskStatus(agent.status),
              summary,
              createdAt: capturedAt,
            })
            events.push(this.insertEvent({
              taskId: created.id,
              taskVersion: created.version,
              type: 'task.created',
              status: created.status,
              summary: created.summary,
              createdAt: capturedAt,
            }))
          } else if (activeTask.adapter !== 'codex-structured') {
            const nextStatus = runtimeTaskStatus(agent.status)
            if (activeTask.status !== nextStatus || activeTask.summary !== summary) {
              const changed = this.updateTaskRow(activeTask, {
                status: nextStatus,
                summary,
                active: true,
                updatedAt: capturedAt,
              })
              events.push(this.insertEvent({
                taskId: changed.id,
                taskVersion: changed.version,
                type: 'task.status_changed',
                status: changed.status,
                summary: changed.summary,
                createdAt: capturedAt,
              }))
            }
          }
        } else if (activeTask && activeTask.adapter !== 'codex-structured') {
          const changed = this.updateTaskRow(activeTask, {
            status: runtimeTaskStatus(agent.status),
            summary,
            active: false,
            updatedAt: capturedAt,
          })
          events.push(this.insertEvent({
            taskId: changed.id,
            taskVersion: changed.version,
            type: 'task.completed',
            status: changed.status,
            summary: changed.summary,
            createdAt: capturedAt,
          }))
        }
      }

      const present = this.database.prepare(
        'SELECT agent_id FROM agent_observations WHERE present = 1',
      ).all() as Array<{ agent_id: string }>
      for (const row of present) {
        if (seen.has(row.agent_id)) continue
        const summary = 'Agent is no longer present in the current configuration.'
        this.database.prepare(`
          UPDATE agent_observations
          SET status = 'offline', summary = ?, present = 0,
              last_seen_at = ?, source_captured_at = ?
          WHERE agent_id = ?
        `).run(summary, capturedAt, capturedAt, row.agent_id)
        const activeTask = this.getActiveTaskRow(row.agent_id)
        if (activeTask && activeTask.adapter !== 'codex-structured') {
          const changed = this.updateTaskRow(activeTask, {
            status: 'interrupted',
            summary,
            active: false,
            updatedAt: capturedAt,
          })
          events.push(this.insertEvent({
            taskId: changed.id,
            taskVersion: changed.version,
            type: 'task.removed',
            status: changed.status,
            summary,
            createdAt: capturedAt,
          }))
        }
      }
    })

    return {
      observations: this.listObservations(),
      tasks: this.listTasks(),
      events,
    }
  }

  createTask(input: {
    id?: string
    agentId: string
    adapter: RemoteTaskAdapter
    status?: CoreTaskStatus
    summary?: string
    createdAt?: string
  }): TaskMutationResult {
    this.assertOpen()
    let task!: PersistedTask
    let event!: RemoteEvent
    this.transaction(() => {
      if (this.getActiveTaskRow(identifier(input.agentId, 'Agent ID'))) {
        throw new Error('This Agent already has an active task.')
      }
      task = this.insertTask({
        id: input.id ? identifier(input.id, 'Task ID') : randomUUID(),
        agentId: identifier(input.agentId, 'Agent ID'),
        adapter: input.adapter,
        status: input.status ?? 'starting',
        summary: publicText(input.summary, 'Task started.', 500),
        createdAt: timestamp(input.createdAt),
      })
      event = this.insertEvent({
        taskId: task.id,
        taskVersion: task.version,
        type: 'task.created',
        status: task.status,
        summary: task.summary,
        createdAt: task.createdAt,
      })
    })
    return { task, event }
  }

  transitionTask(input: {
    taskId: string
    expectedVersion?: number
    status: CoreTaskStatus
    summary: string
    active: boolean
    eventType?: string
    updatedAt?: string
  }): TaskMutationResult {
    this.assertOpen()
    let task!: PersistedTask
    let event!: RemoteEvent
    this.transaction(() => {
      const current = this.getTaskRow(identifier(input.taskId, 'Task ID'))
      if (!current) throw new Error('Task not found.')
      if (input.expectedVersion != null && Number(current.version) !== input.expectedVersion) {
        throw new Error('Task version is stale.')
      }
      task = this.updateTaskRow(current, {
        status: input.status,
        summary: publicText(input.summary, 'Task updated.', 500),
        active: input.active,
        updatedAt: timestamp(input.updatedAt),
      })
      event = this.insertEvent({
        taskId: task.id,
        taskVersion: task.version,
        type: input.eventType ?? 'task.status_changed',
        status: task.status,
        summary: task.summary,
        createdAt: task.updatedAt,
      })
    })
    return { task, event }
  }

  getTask(taskId: string): PersistedTask | null {
    this.assertOpen()
    const row = this.getTaskRow(identifier(taskId, 'Task ID'))
    return row ? taskFromRow(row) : null
  }

  getActiveTaskForAgent(agentId: string): PersistedTask | null {
    this.assertOpen()
    const row = this.getActiveTaskRow(identifier(agentId, 'Agent ID'))
    return row ? taskFromRow(row) : null
  }

  listTasks(agentId?: string): PersistedTask[] {
    this.assertOpen()
    const rows = agentId
      ? this.database.prepare(`
          SELECT task_id, agent_id, adapter, status, summary, created_at, updated_at, version, active
          FROM task_runs WHERE agent_id = ? ORDER BY created_at DESC, task_id
        `).all(identifier(agentId, 'Agent ID'))
      : this.database.prepare(`
          SELECT task_id, agent_id, adapter, status, summary, created_at, updated_at, version, active
          FROM task_runs ORDER BY active DESC, updated_at DESC, task_id
        `).all()
    return (rows as unknown as TaskRow[]).map(taskFromRow)
  }

  listObservations(): PersistedAgentObservation[] {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT agent_id, project_id, display_name, kind, status, summary, present,
             first_seen_at, last_seen_at, source_captured_at
      FROM agent_observations
      ORDER BY present DESC, display_name COLLATE NOCASE, agent_id
    `).all() as unknown as ObservationRow[]
    return rows.map(observationFromRow)
  }

  recordApproval(input: {
    id: string
    taskId: string
    promptSummary: string
    expiresAt: string
    createdAt?: string
  }): { approval: PersistedApproval; event: RemoteEvent | null } {
    this.assertOpen()
    const approvalId = identifier(input.id, 'Approval ID')
    const taskId = identifier(input.taskId, 'Task ID')
    const createdAt = timestamp(input.createdAt)
    const expiresAt = timestamp(input.expiresAt)
    const promptSummary = publicText(input.promptSummary, 'Approval requested.', 500)
    let event: RemoteEvent | null = null
    this.transaction(() => {
      const task = this.getTaskRow(taskId)
      if (!task) throw new Error('Task not found.')
      const existing = this.getApprovalRow(approvalId)
      if (existing && (existing.task_id !== taskId || existing.status !== 'pending')) {
        throw new Error('Approval ID was already used.')
      }
      const result = this.database.prepare(`
        INSERT INTO task_approvals (
          approval_id, task_id, status, prompt_summary, decision_summary,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, 'pending', ?, '', ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          prompt_summary = excluded.prompt_summary,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
        WHERE task_approvals.task_id = excluded.task_id AND task_approvals.status = 'pending'
      `).run(approvalId, taskId, promptSummary, createdAt, createdAt, expiresAt)
      if (Number(result.changes) > 0) {
        event = this.insertEvent({
          taskId,
          taskVersion: Number(task.version),
          type: 'approval.requested',
          status: 'pending',
          summary: promptSummary,
          createdAt,
        })
      }
    })
    return { approval: this.getApproval(approvalId)!, event }
  }

  getApproval(approvalId: string): PersistedApproval | null {
    this.assertOpen()
    const row = this.getApprovalRow(identifier(approvalId, 'Approval ID'))
    return row ? approvalFromRow(row) : null
  }

  listApprovals(taskId?: string): PersistedApproval[] {
    this.assertOpen()
    const rows = taskId
      ? this.database.prepare(`
          SELECT approval_id, task_id, status, prompt_summary, decision_summary,
                 created_at, updated_at, expires_at
          FROM task_approvals WHERE task_id = ? ORDER BY created_at, approval_id
        `).all(identifier(taskId, 'Task ID'))
      : this.database.prepare(`
          SELECT approval_id, task_id, status, prompt_summary, decision_summary,
                 created_at, updated_at, expires_at
          FROM task_approvals ORDER BY created_at, approval_id
        `).all()
    return (rows as unknown as ApprovalRow[]).map(approvalFromRow)
  }

  resolveApproval(input: {
    approvalId: string
    taskId: string
    status: 'approved' | 'rejected' | 'cancelled' | 'expired'
    decisionSummary: string
    updatedAt?: string
  }): { approval: PersistedApproval; event: RemoteEvent | null } {
    this.assertOpen()
    const approvalId = identifier(input.approvalId, 'Approval ID')
    const taskId = identifier(input.taskId, 'Task ID')
    const updatedAt = timestamp(input.updatedAt)
    const decisionSummary = publicText(input.decisionSummary, 'Approval resolved.', 500)
    let event: RemoteEvent | null = null
    this.transaction(() => {
      const approval = this.getApprovalRow(approvalId)
      const task = this.getTaskRow(taskId)
      if (!approval || approval.task_id !== taskId || approval.status !== 'pending' || !task) {
        throw new Error('Approval is no longer pending for this task.')
      }
      this.database.prepare(`
        UPDATE task_approvals
        SET status = ?, decision_summary = ?, updated_at = ?
        WHERE approval_id = ? AND task_id = ? AND status = 'pending'
      `).run(input.status, decisionSummary, updatedAt, approvalId, taskId)
      event = this.insertEvent({
        taskId,
        taskVersion: Number(task.version),
        type: 'approval.resolved',
        status: input.status,
        summary: decisionSummary,
        createdAt: updatedAt,
      })
    })
    return { approval: this.getApproval(approvalId)!, event }
  }

  claimRemoteRequest(input: ClaimRemoteRequestInput): ClaimRemoteRequestResult {
    this.assertOpen()
    const requestId = identifier(input.requestId, 'Request ID')
    const operation = eventType(input.operation)
    const taskId = identifier(input.taskId, 'Task ID')
    const actorUserId = identifier(input.actorUserId, 'User ID')
    const actorDeviceId = identifier(input.actorDeviceId, 'Device ID')
    const requestHash = input.requestHash.toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('Request hash must be SHA-256.')
    const issuedTime = Date.parse(input.issuedAt)
    const expiresTime = Date.parse(input.expiresAt)
    if (!Number.isFinite(issuedTime) || !Number.isFinite(expiresTime) || expiresTime <= issuedTime) {
      throw new Error('Remote request timestamps are invalid.')
    }
    const issuedAt = new Date(issuedTime).toISOString()
    const expiresAt = new Date(expiresTime).toISOString()
    let result!: ClaimRemoteRequestResult
    this.transaction(() => {
      const now = new Date().toISOString()
      // Signed writes cannot be accepted after expires_at, so retaining their
      // receipts longer adds no replay protection. Pruning here bounds steady
      // state even when a paired device continually rotates request IDs.
      this.database.prepare('DELETE FROM request_receipts WHERE expires_at <= ?').run(now)
      const existing = this.getReceiptRow(requestId)
      if (existing) {
        if (
          existing.operation !== operation
          || existing.task_id !== taskId
          || existing.actor_user_id !== actorUserId
          || existing.actor_device_id !== actorDeviceId
          || existing.request_hash !== requestHash
        ) {
          throw new Error('Request ID was already used for different request content.')
        }
        if (existing.state === 'claimed') result = { kind: 'in_progress' }
        else if (existing.state === 'unknown') result = { kind: 'unknown' }
        else result = {
          kind: 'duplicate',
          state: existing.state,
          response: { ...safeRemoteActionResult(JSON.parse(existing.response_json)), duplicate: true },
        }
        return
      }

      const taskRow = this.getTaskRow(taskId)
      if (!taskRow) {
        result = { kind: 'not_found' }
        return
      }
      const task = taskFromRow(taskRow)
      if (!task.active) {
        result = { kind: 'not_active', task }
        return
      }
      if (task.version !== input.expectedTaskVersion) {
        result = { kind: 'stale', task }
        return
      }
      const total = this.database.prepare(
        'SELECT COUNT(*) AS count FROM request_receipts',
      ).get() as unknown as { count: number | bigint }
      const device = this.database.prepare(
        'SELECT COUNT(*) AS count FROM request_receipts WHERE actor_device_id = ?',
      ).get(actorDeviceId) as unknown as { count: number | bigint }
      if (Number(total.count) >= MAX_LIVE_REQUEST_RECEIPTS_TOTAL
        || Number(device.count) >= MAX_LIVE_REQUEST_RECEIPTS_PER_DEVICE) {
        throw new Error('Remote request receipt capacity was reached.')
      }
      this.database.prepare(`
        INSERT INTO request_receipts (
          request_id, operation, task_id, expected_task_version, actor_user_id, actor_device_id,
          request_hash, state, response_json, issued_at, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', '', ?, ?, ?, ?)
      `).run(
        requestId,
        operation,
        taskId,
        input.expectedTaskVersion,
        actorUserId,
        actorDeviceId,
        requestHash,
        issuedAt,
        expiresAt,
        now,
        now,
      )
      result = { kind: 'claimed', task }
    })
    return result
  }

  completeRemoteRequest(input: CompleteRemoteRequestInput): {
    response: RemoteActionResult
    task: PersistedTask
    events: RemoteEvent[]
  } {
    this.assertOpen()
    const requestId = identifier(input.requestId, 'Request ID')
    const events: RemoteEvent[] = []
    let response!: RemoteActionResult
    let task!: PersistedTask
    this.transaction(() => {
      const receipt = this.getReceiptRow(requestId)
      if (!receipt || receipt.state !== 'claimed') throw new Error('Remote request is not in the claimed state.')
      const current = this.getTaskRow(receipt.task_id)
      if (!current) throw new Error('Task not found while completing request.')
      if (Number(current.version) !== Number(receipt.expected_task_version)) {
        this.database.prepare(`
          UPDATE request_receipts SET state = 'unknown', updated_at = ? WHERE request_id = ?
        `).run(new Date().toISOString(), requestId)
        throw new Error('Task changed while the remote action was executing; outcome is unknown.')
      }

      if (input.nextStatus || input.summary || input.active != null) {
        task = this.updateTaskRow(current, {
          status: input.nextStatus ?? current.status,
          summary: publicText(input.summary, current.summary, 500),
          active: input.active ?? current.active === 1,
          updatedAt: new Date().toISOString(),
        })
        events.push(this.insertEvent({
          taskId: task.id,
          taskVersion: task.version,
          type: input.eventType ?? 'task.action_completed',
          status: task.status,
          summary: task.summary,
          createdAt: task.updatedAt,
        }))
      } else {
        task = taskFromRow(current)
      }

      if (input.approval) {
        const approval = this.getApprovalRow(identifier(input.approval.id, 'Approval ID'))
        if (!approval || approval.task_id !== task.id || approval.status !== 'pending') {
          throw new Error('Approval is no longer pending for this task.')
        }
        const updatedAt = new Date().toISOString()
        const decisionSummary = publicText(input.approval.decisionSummary, 'Approval resolved.', 500)
        this.database.prepare(`
          UPDATE task_approvals
          SET status = ?, decision_summary = ?, updated_at = ?
          WHERE approval_id = ? AND status = 'pending'
        `).run(input.approval.status, decisionSummary, updatedAt, approval.approval_id)
        events.push(this.insertEvent({
          taskId: task.id,
          taskVersion: task.version,
          type: 'approval.resolved',
          status: input.approval.status,
          summary: decisionSummary,
          createdAt: updatedAt,
        }))
      }

      response = {
        ok: Boolean(input.ok),
        requestId,
        taskId: task.id,
        taskVersion: task.version,
        action: cleanText(input.action, 'unknown', 80),
        message: publicText(input.message, 'Request completed.', 300),
        duplicate: false,
        outcome: input.outcome,
      }
      this.database.prepare(`
        UPDATE request_receipts
        SET state = ?, response_json = ?, updated_at = ?
        WHERE request_id = ? AND state = 'claimed'
      `).run(input.outcome === 'completed' ? 'completed' : 'failed', JSON.stringify(response), new Date().toISOString(), requestId)
    })
    return { response, task, events }
  }

  markRemoteRequestUnknown(requestId: string): void {
    this.assertOpen()
    this.database.prepare(`
      UPDATE request_receipts
      SET state = 'unknown', updated_at = ?
      WHERE request_id = ? AND state = 'claimed'
    `).run(new Date().toISOString(), identifier(requestId, 'Request ID'))
  }

  events(afterSeq = 0, limit = 100, taskId?: string): RemoteEventsResult {
    this.assertOpen()
    const safeAfter = boundedInteger(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER)
    const safeLimit = boundedInteger(limit, 100, 1, MAX_REPLAY_EVENTS)
    const latestSeq = this.latestEventSeq()
    const oldestAvailableSeq = this.oldestEventSeq()
    const resetRequired = safeAfter > latestSeq || safeAfter < oldestAvailableSeq - 1
    const rows = resetRequired
      ? []
      : taskId
        ? this.database.prepare(`
            SELECT seq, task_id, task_version, event_type, status, summary, created_at
            FROM task_events WHERE seq > ? AND task_id = ? ORDER BY seq ASC LIMIT ?
          `).all(safeAfter, identifier(taskId, 'Task ID'), safeLimit)
        : this.database.prepare(`
            SELECT seq, task_id, task_version, event_type, status, summary, created_at
            FROM task_events WHERE seq > ? ORDER BY seq ASC LIMIT ?
          `).all(safeAfter, safeLimit)
    return {
      streamId: this.streamId(),
      oldestAvailableSeq,
      latestSeq,
      resetRequired,
      events: (rows as unknown as EventRow[]).map(eventFromRow),
    }
  }

  latestEventSeq(): number {
    this.assertOpen()
    const row = this.database.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM task_events',
    ).get() as unknown as { seq: number | bigint }
    return Number(row.seq)
  }

  streamId(): string {
    this.assertOpen()
    const row = this.database.prepare(
      "SELECT value FROM schema_meta WHERE key = 'remote_event_stream_id'",
    ).get() as unknown as { value: string } | undefined
    if (!row) throw new Error('Remote event stream identifier is missing.')
    return row.value
  }

  storageSettings(): LedgerStorageSettings {
    this.assertOpen()
    const foreignKeys = this.database.prepare('PRAGMA foreign_keys').get() as unknown as { foreign_keys: number }
    const journalMode = this.database.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string }
    const synchronous = this.database.prepare('PRAGMA synchronous').get() as unknown as { synchronous: number }
    return {
      foreignKeys: foreignKeys.foreign_keys === 1,
      journalMode: journalMode.journal_mode,
      synchronous: synchronous.synchronous,
      schemaVersion: this.schemaVersion(),
    }
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        present INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1)),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        source_captured_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        prompt_summary TEXT NOT NULL,
        decision_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS request_dedup (
        request_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `)

    const versionRow = this.database.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    ).get() as unknown as { value: string } | undefined
    const version = versionRow ? Number(versionRow.value) : 1
    if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
      throw new Error(`Unsupported task ledger schema version: ${versionRow?.value ?? 'missing'}`)
    }
    if (!versionRow) {
      this.database.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')",
      ).run()
    }
    if (version === 1) this.migrateV1ToV2()
    if (this.schemaVersion() !== SCHEMA_VERSION) {
      throw new Error(`Task ledger did not reach schema version ${SCHEMA_VERSION}.`)
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS request_receipts_device_expiry_idx
        ON request_receipts(actor_device_id, expires_at);
    `)
  }

  private migrateV1ToV2(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS agent_observations (
          agent_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          present INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1)),
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          source_captured_at TEXT NOT NULL
        ) STRICT;

        INSERT OR IGNORE INTO agent_observations (
          agent_id, project_id, display_name, kind, status, summary, present,
          first_seen_at, last_seen_at, source_captured_at
        )
        SELECT agent_id, project_id, display_name, kind, status, summary, present,
               first_seen_at, last_seen_at, source_captured_at
        FROM tasks;

        CREATE TABLE IF NOT EXISTS task_runs (
          task_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          adapter TEXT NOT NULL CHECK (adapter IN ('codex-structured', 'tmux-compatibility', 'process-monitor')),
          status TEXT NOT NULL CHECK (status IN (
            'starting', 'running', 'needs_input', 'needs_approval', 'completed',
            'failed', 'interrupted', 'recovering', 'unknown'
          )),
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS task_runs_one_active_agent_idx
          ON task_runs(agent_id) WHERE active = 1;
        CREATE INDEX IF NOT EXISTS task_runs_agent_updated_idx
          ON task_runs(agent_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS task_approvals (
          approval_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES task_runs(task_id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
          prompt_summary TEXT NOT NULL,
          decision_summary TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS task_approvals_task_status_idx
          ON task_approvals(task_id, status, created_at);

        CREATE TABLE IF NOT EXISTS task_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT REFERENCES task_runs(task_id) ON DELETE SET NULL,
          task_version INTEGER,
          event_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS task_events_task_seq_idx
          ON task_events(task_id, seq);

        CREATE TABLE IF NOT EXISTS request_receipts (
          request_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES task_runs(task_id) ON DELETE RESTRICT,
          expected_task_version INTEGER NOT NULL,
          actor_user_id TEXT NOT NULL,
          actor_device_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('claimed', 'completed', 'failed', 'unknown')),
          response_json TEXT NOT NULL DEFAULT '',
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS request_receipts_task_created_idx
          ON request_receipts(task_id, created_at);
        CREATE INDEX IF NOT EXISTS request_receipts_device_expiry_idx
          ON request_receipts(actor_device_id, expires_at);
      `)
      this.database.prepare(`
        INSERT OR IGNORE INTO schema_meta (key, value)
        VALUES ('remote_event_stream_id', ?)
      `).run(randomUUID())
      this.database.prepare(`
        UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'
      `).run()
    })
  }

  private schemaVersion(): number {
    const row = this.database.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    ).get() as unknown as { value: string } | undefined
    return Number(row?.value ?? 0)
  }

  private recoverClaimedRequests(): void {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.database.prepare('DELETE FROM request_receipts WHERE expires_at <= ?').run(now)
      this.database.prepare(`
        UPDATE request_receipts
        SET state = 'unknown', updated_at = ?
        WHERE state = 'claimed'
      `).run(now)
    })
  }

  private oldestEventSeq(): number {
    const row = this.database.prepare(
      'SELECT MIN(seq) AS seq FROM task_events',
    ).get() as unknown as { seq: number | bigint | null }
    return row.seq == null ? this.latestEventSeq() + 1 : Number(row.seq)
  }

  private getObservationRow(agentId: string): ObservationRow | null {
    const row = this.database.prepare(`
      SELECT agent_id, project_id, display_name, kind, status, summary, present,
             first_seen_at, last_seen_at, source_captured_at
      FROM agent_observations WHERE agent_id = ?
    `).get(agentId) as unknown as ObservationRow | undefined
    return row ?? null
  }

  private getTaskRow(taskId: string): TaskRow | null {
    const row = this.database.prepare(`
      SELECT task_id, agent_id, adapter, status, summary, created_at, updated_at, version, active
      FROM task_runs WHERE task_id = ?
    `).get(taskId) as unknown as TaskRow | undefined
    return row ?? null
  }

  private getActiveTaskRow(agentId: string): TaskRow | null {
    const row = this.database.prepare(`
      SELECT task_id, agent_id, adapter, status, summary, created_at, updated_at, version, active
      FROM task_runs WHERE agent_id = ? AND active = 1
    `).get(agentId) as unknown as TaskRow | undefined
    return row ?? null
  }

  private getApprovalRow(approvalId: string): ApprovalRow | null {
    const row = this.database.prepare(`
      SELECT approval_id, task_id, status, prompt_summary, decision_summary,
             created_at, updated_at, expires_at
      FROM task_approvals WHERE approval_id = ?
    `).get(approvalId) as unknown as ApprovalRow | undefined
    return row ?? null
  }

  private getReceiptRow(requestId: string): RequestReceiptRow | null {
    const row = this.database.prepare(`
      SELECT request_id, operation, task_id, expected_task_version, actor_user_id, actor_device_id,
             request_hash, state, response_json, issued_at, expires_at, created_at, updated_at
      FROM request_receipts WHERE request_id = ?
    `).get(requestId) as unknown as RequestReceiptRow | undefined
    return row ?? null
  }

  private insertTask(input: {
    id: string
    agentId: string
    adapter: RemoteTaskAdapter
    status: CoreTaskStatus
    summary: string
    createdAt: string
  }): PersistedTask {
    this.database.prepare(`
      INSERT INTO task_runs (
        task_id, agent_id, adapter, status, summary, created_at, updated_at, version, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
    `).run(input.id, input.agentId, input.adapter, input.status, input.summary, input.createdAt, input.createdAt)
    return taskFromRow(this.getTaskRow(input.id)!)
  }

  private updateTaskRow(current: TaskRow, input: {
    status: CoreTaskStatus
    summary: string
    active: boolean
    updatedAt: string
  }): PersistedTask {
    this.database.prepare(`
      UPDATE task_runs
      SET status = ?, summary = ?, active = ?, updated_at = ?, version = version + 1
      WHERE task_id = ? AND version = ?
    `).run(
      input.status,
      input.summary,
      input.active ? 1 : 0,
      input.updatedAt,
      current.task_id,
      Number(current.version),
    )
    return taskFromRow(this.getTaskRow(current.task_id)!)
  }

  private insertEvent(input: {
    taskId: string | null
    taskVersion: number | null
    type: string
    status: string
    summary: string
    createdAt: string
  }): RemoteEvent {
    const result = this.database.prepare(`
      INSERT INTO task_events (
        task_id, task_version, event_type, status, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.taskId,
      input.taskVersion,
      eventType(input.type),
      cleanText(input.status, '', 40),
      publicText(input.summary, 'Event recorded.', 500),
      timestamp(input.createdAt),
    )
    const seq = Number(result.lastInsertRowid)
    this.database.prepare(
      'DELETE FROM task_events WHERE seq <= ?',
    ).run(Math.max(0, seq - MAX_STORED_EVENTS))
    return eventFromRow(this.database.prepare(`
      SELECT seq, task_id, task_version, event_type, status, summary, created_at
      FROM task_events WHERE seq = ?
    `).get(seq) as unknown as EventRow)
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Task ledger is closed.')
  }
}
