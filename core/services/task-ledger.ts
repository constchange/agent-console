import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActionResult, AgentStatus, RuntimeAgent, RuntimeSnapshot } from '../../shared/types'

const SCHEMA_VERSION = 1
const MAX_REPLAY_EVENTS = 1_000

export interface PersistedTask {
  id: string
  agentId: string
  projectId: string
  displayName: string
  kind: RuntimeAgent['kind']
  status: AgentStatus
  summary: string
  present: boolean
  firstSeenAt: string
  lastSeenAt: string
  sourceCapturedAt: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

export interface PersistedApproval {
  id: string
  taskId: string
  status: ApprovalStatus
  promptSummary: string
  decisionSummary: string
  createdAt: string
  updatedAt: string
}

export interface LedgerEvent {
  seq: number
  taskId: string | null
  type: string
  status: string
  summary: string
  createdAt: string
}

export interface NewLedgerEvent {
  taskId?: string | null
  type: string
  status?: string
  summary: string
  createdAt?: string
}

export interface DeduplicatedResult {
  duplicate: boolean
  response: ActionResult
}

export interface LedgerStorageSettings {
  foreignKeys: boolean
  journalMode: string
  synchronous: number
}

interface TaskRow {
  task_id: string
  agent_id: string
  project_id: string
  display_name: string
  kind: RuntimeAgent['kind']
  status: AgentStatus
  summary: string
  present: number
  first_seen_at: string
  last_seen_at: string
  source_captured_at: string
}

interface ApprovalRow {
  approval_id: string
  task_id: string
  status: ApprovalStatus
  prompt_summary: string
  decision_summary: string
  created_at: string
  updated_at: string
}

interface EventRow {
  seq: number | bigint
  task_id: string | null
  event_type: string
  status: string
  summary: string
  created_at: string
}

interface RequestRow {
  operation: string
  response_json: string
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
  const labels: Record<AgentStatus, string> = {
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

function sanitizeActionResult(value: ActionResult): ActionResult {
  return {
    ok: Boolean(value.ok),
    action: cleanText(value.action, 'unknown', 80),
    message: publicText(value.message, 'Request completed.', 300),
  }
}

function taskFromRow(row: TaskRow): PersistedTask {
  return {
    id: row.task_id,
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

function approvalFromRow(row: ApprovalRow): PersistedApproval {
  return {
    id: row.approval_id,
    taskId: row.task_id,
    status: row.status,
    promptSummary: row.prompt_summary,
    decisionSummary: row.decision_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function eventFromRow(row: EventRow): LedgerEvent {
  return {
    seq: Number(row.seq),
    taskId: row.task_id,
    type: row.event_type,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
  }
}

/**
 * A local, single-process ledger for durable user-visible Agent state.
 *
 * It intentionally does not persist RuntimeSnapshot output, process arguments,
 * working directories, launch commands, terminal names, or model reasoning.
 */
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

    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600)
  }

  updateFromSnapshot(snapshot: RuntimeSnapshot): PersistedTask[] {
    this.assertOpen()
    const capturedAt = timestamp(snapshot.capturedAt)
    const seen = new Set<string>()

    this.transaction(() => {
      for (const agent of snapshot.agents) {
        const taskId = identifier(agent.id, 'Agent ID')
        if (seen.has(taskId)) continue
        seen.add(taskId)

        const next = {
          taskId,
          agentId: taskId,
          projectId: identifier(agent.projectId, 'Project ID'),
          displayName: cleanText(agent.name, 'Agent', 100),
          kind: cleanText(agent.kind, 'process', 40) as RuntimeAgent['kind'],
          status: agent.status,
          summary: publicSummary(agent),
        }
        const existing = this.getTaskRow(taskId)

        if (!existing) {
          this.database.prepare(`
            INSERT INTO tasks (
              task_id, agent_id, project_id, display_name, kind, status, summary,
              present, first_seen_at, last_seen_at, source_captured_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `).run(
            next.taskId,
            next.agentId,
            next.projectId,
            next.displayName,
            next.kind,
            next.status,
            next.summary,
            capturedAt,
            capturedAt,
            capturedAt,
          )
          this.insertEvent({
            taskId,
            type: 'task.created',
            status: next.status,
            summary: next.summary,
            createdAt: capturedAt,
          })
          continue
        }

        const changed = existing.project_id !== next.projectId
          || existing.display_name !== next.displayName
          || existing.kind !== next.kind
          || existing.status !== next.status
          || existing.summary !== next.summary
          || existing.present !== 1

        this.database.prepare(`
          UPDATE tasks
          SET project_id = ?, display_name = ?, kind = ?, status = ?, summary = ?,
              present = 1, last_seen_at = ?, source_captured_at = ?
          WHERE task_id = ?
        `).run(
          next.projectId,
          next.displayName,
          next.kind,
          next.status,
          next.summary,
          capturedAt,
          capturedAt,
          taskId,
        )

        if (changed) {
          const type = existing.present !== 1
            ? 'task.restored'
            : existing.status !== next.status
              ? 'task.status_changed'
              : 'task.updated'
          this.insertEvent({
            taskId,
            type,
            status: next.status,
            summary: next.summary,
            createdAt: capturedAt,
          })
        }
      }

      const presentRows = this.database.prepare(
        'SELECT task_id FROM tasks WHERE present = 1',
      ).all() as Array<{ task_id: string }>
      for (const row of presentRows) {
        if (seen.has(row.task_id)) continue
        const summary = 'Agent is no longer present in the current configuration.'
        this.database.prepare(`
          UPDATE tasks
          SET status = 'offline', summary = ?, present = 0,
              last_seen_at = ?, source_captured_at = ?
          WHERE task_id = ?
        `).run(summary, capturedAt, capturedAt, row.task_id)
        this.insertEvent({
          taskId: row.task_id,
          type: 'task.removed',
          status: 'offline',
          summary,
          createdAt: capturedAt,
        })
      }
    })

    return this.listTasks()
  }

  getTask(taskId: string): PersistedTask | null {
    this.assertOpen()
    const row = this.getTaskRow(identifier(taskId, 'Task ID'))
    return row ? taskFromRow(row) : null
  }

  listTasks(): PersistedTask[] {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT task_id, agent_id, project_id, display_name, kind, status, summary,
             present, first_seen_at, last_seen_at, source_captured_at
      FROM tasks
      ORDER BY present DESC, display_name COLLATE NOCASE, task_id
    `).all() as unknown as TaskRow[]
    return rows.map(taskFromRow)
  }

  recordApproval(input: {
    id: string
    taskId: string
    promptSummary: string
    createdAt?: string
  }): PersistedApproval {
    this.assertOpen()
    const approvalId = identifier(input.id, 'Approval ID')
    const taskId = identifier(input.taskId, 'Task ID')
    const createdAt = timestamp(input.createdAt)
    const promptSummary = publicText(input.promptSummary, 'Approval requested.', 500)
    const existing = this.getApproval(approvalId)
    if (existing) {
      if (existing.taskId !== taskId) {
        throw new Error('Approval ID was already used for a different task.')
      }
      if (existing.status !== 'pending' || existing.promptSummary === promptSummary) return existing
    }
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO approvals (
          approval_id, task_id, status, prompt_summary, decision_summary, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, '', ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          prompt_summary = excluded.prompt_summary,
          updated_at = excluded.updated_at
        WHERE approvals.task_id = excluded.task_id AND approvals.status = 'pending'
      `).run(approvalId, taskId, promptSummary, createdAt, createdAt)
      this.insertEvent({
        taskId,
        type: 'approval.requested',
        status: 'pending',
        summary: promptSummary,
        createdAt,
      })
    })
    return this.getApproval(approvalId)!
  }

  resolveApproval(
    approvalId: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    decisionSummary = 'Approval resolved.',
    resolvedAt?: string,
  ): PersistedApproval {
    this.assertOpen()
    const id = identifier(approvalId, 'Approval ID')
    const allowed: ApprovalStatus[] = ['approved', 'rejected', 'cancelled', 'expired']
    if (!allowed.includes(status)) throw new Error('Approval resolution is invalid.')
    const updatedAt = timestamp(resolvedAt)
    const summary = publicText(decisionSummary, 'Approval resolved.', 500)
    const current = this.getApproval(id)
    if (!current) throw new Error('Approval not found.')
    if (current.status !== 'pending') return current

    this.transaction(() => {
      this.database.prepare(`
        UPDATE approvals
        SET status = ?, decision_summary = ?, updated_at = ?
        WHERE approval_id = ? AND status = 'pending'
      `).run(status, summary, updatedAt, id)
      this.insertEvent({
        taskId: current.taskId,
        type: 'approval.resolved',
        status,
        summary,
        createdAt: updatedAt,
      })
    })
    return this.getApproval(id)!
  }

  getApproval(approvalId: string): PersistedApproval | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT approval_id, task_id, status, prompt_summary, decision_summary, created_at, updated_at
      FROM approvals
      WHERE approval_id = ?
    `).get(identifier(approvalId, 'Approval ID')) as unknown as ApprovalRow | undefined
    return row ? approvalFromRow(row) : null
  }

  listApprovals(taskId?: string): PersistedApproval[] {
    this.assertOpen()
    const rows = taskId
      ? this.database.prepare(`
          SELECT approval_id, task_id, status, prompt_summary, decision_summary, created_at, updated_at
          FROM approvals WHERE task_id = ? ORDER BY created_at, approval_id
        `).all(identifier(taskId, 'Task ID'))
      : this.database.prepare(`
          SELECT approval_id, task_id, status, prompt_summary, decision_summary, created_at, updated_at
          FROM approvals ORDER BY created_at, approval_id
        `).all()
    return (rows as unknown as ApprovalRow[]).map(approvalFromRow)
  }

  appendEvent(event: NewLedgerEvent): LedgerEvent {
    this.assertOpen()
    return this.insertEvent(event)
  }

  replayEvents(afterSeq = 0, limit = 100): LedgerEvent[] {
    this.assertOpen()
    const safeAfter = boundedInteger(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER)
    const safeLimit = boundedInteger(limit, 100, 1, MAX_REPLAY_EVENTS)
    const rows = this.database.prepare(`
      SELECT seq, task_id, event_type, status, summary, created_at
      FROM events
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(safeAfter, safeLimit) as unknown as EventRow[]
    return rows.map(eventFromRow)
  }

  latestEventSeq(): number {
    this.assertOpen()
    const row = this.database.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM events',
    ).get() as unknown as { seq: number | bigint }
    return Number(row.seq)
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
    }
  }

  findRequest(requestId: string, operation: string): ActionResult | null {
    this.assertOpen()
    const id = identifier(requestId, 'Request ID')
    const safeOperation = eventType(operation)
    const row = this.database.prepare(`
      SELECT operation, response_json
      FROM request_dedup
      WHERE request_id = ?
    `).get(id) as unknown as RequestRow | undefined
    if (!row) return null
    if (row.operation !== safeOperation) {
      throw new Error('Request ID was already used for a different operation.')
    }
    return sanitizeActionResult(JSON.parse(row.response_json) as ActionResult)
  }

  rememberRequest(
    requestId: string,
    operation: string,
    response: ActionResult,
    createdAt?: string,
  ): DeduplicatedResult {
    this.assertOpen()
    const id = identifier(requestId, 'Request ID')
    const safeOperation = eventType(operation)
    const safeResponse = sanitizeActionResult(response)
    const existing = this.findRequest(id, safeOperation)
    if (existing) return { duplicate: true, response: existing }

    const result = this.database.prepare(`
      INSERT OR IGNORE INTO request_dedup (request_id, operation, response_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, safeOperation, JSON.stringify(safeResponse), timestamp(createdAt))
    if (Number(result.changes) === 1) return { duplicate: false, response: safeResponse }

    const stored = this.findRequest(id, safeOperation)
    if (!stored) throw new Error('Deduplicated request could not be read after insertion.')
    return { duplicate: true, response: stored }
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

      CREATE INDEX IF NOT EXISTS approvals_task_status_idx
        ON approvals(task_id, status, created_at);
      CREATE INDEX IF NOT EXISTS events_task_seq_idx
        ON events(task_id, seq);
    `)

    const versionRow = this.database.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    ).get() as unknown as { value: string } | undefined
    if (versionRow && versionRow.value !== String(SCHEMA_VERSION)) {
      throw new Error(`Unsupported task ledger schema version: ${versionRow.value}`)
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)
    `).run(String(SCHEMA_VERSION))
  }

  private getTaskRow(taskId: string): TaskRow | null {
    const row = this.database.prepare(`
      SELECT task_id, agent_id, project_id, display_name, kind, status, summary,
             present, first_seen_at, last_seen_at, source_captured_at
      FROM tasks
      WHERE task_id = ?
    `).get(taskId) as unknown as TaskRow | undefined
    return row ?? null
  }

  private insertEvent(event: NewLedgerEvent): LedgerEvent {
    const taskId = event.taskId == null ? null : identifier(event.taskId, 'Task ID')
    const type = eventType(event.type)
    const status = cleanText(event.status, '', 40)
    const summary = publicText(event.summary, 'Event recorded.', 500)
    const createdAt = timestamp(event.createdAt)
    const result = this.database.prepare(`
      INSERT INTO events (task_id, event_type, status, summary, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, type, status, summary, createdAt)
    const seq = Number(result.lastInsertRowid)
    return { seq, taskId, type, status, summary, createdAt }
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
