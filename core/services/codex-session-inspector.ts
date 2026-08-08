import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CodexSessionSummary } from '../../shared/types'

const HEAD_BYTES = 2 * 1024 * 1024
const TAIL_BYTES = 4 * 1024 * 1024
const SYNTHETIC_CONTEXT_BLOCK = /<(environment_context|permissions|permissions_instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|system-reminder)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi

interface CachedInspection {
  size: number
  modifiedAt: number
  value: CodexRuntimeSession
}

interface SummaryPart {
  threadId: string | null
  createdAt: string | null
  firstPrompt: string
  latestPrompt: string
  lastCompletedResponse: string
  lastFinalResponse: string
  taskActive: boolean | null
}

export interface CodexRuntimeSession {
  summary: CodexSessionSummary
  threadId: string | null
  /**
   * Structured Codex lifecycle state. `null` means the session did not expose
   * a lifecycle event that this version of Agent Console understands.
   */
  taskActive: boolean | null
}

export interface CodexSessionInspectorOptions {
  procRoot?: string
  sessionRoots?: string[]
  goalDatabasePath?: string
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedText(value: string): string {
  return value
    .replace(SYNTHETIC_CONTEXT_BLOCK, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function messageText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') return normalizedText(payload.text)
  if (!Array.isArray(payload.content)) return ''
  return normalizedText(payload.content.map((entry) => {
    const item = objectValue(entry)
    if (!item) return ''
    if (typeof item.input_text === 'string') return item.input_text
    if (typeof item.output_text === 'string') return item.output_text
    if (typeof item.text === 'string') return item.text
    return ''
  }).join(' '))
}

function firstCharacters(value: string, count: number): string {
  return Array.from(value).slice(0, count).join('')
}

function lastCharacters(value: string, count: number): string {
  return Array.from(value).slice(-count).join('')
}

function summarizeLines(value: string): SummaryPart {
  const summary: SummaryPart = {
    threadId: null,
    createdAt: null,
    firstPrompt: '',
    latestPrompt: '',
    lastCompletedResponse: '',
    lastFinalResponse: '',
    taskActive: null,
  }

  for (const line of value.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown> | null = null
    try {
      record = objectValue(JSON.parse(line))
    } catch {
      continue
    }
    if (!record) continue
    const payload = objectValue(record.payload)
    if (!payload) continue

    if (record.type === 'session_meta') {
      if (!summary.threadId) {
        const threadId = typeof payload.id === 'string'
          ? payload.id
          : typeof payload.session_id === 'string' ? payload.session_id : null
        if (threadId && /^[a-f0-9-]{16,64}$/i.test(threadId)) summary.threadId = threadId
      }
      if (!summary.createdAt) {
        const timestamp = typeof payload.timestamp === 'string'
          ? payload.timestamp
          : typeof record.timestamp === 'string' ? record.timestamp : null
        if (timestamp && Number.isFinite(Date.parse(timestamp))) summary.createdAt = timestamp
      }
      continue
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'task_started') {
        summary.taskActive = true
        continue
      }
      if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        summary.taskActive = false
        if (payload.type === 'task_complete') {
          const completed = typeof payload.last_agent_message === 'string'
            ? normalizedText(payload.last_agent_message)
            : ''
          if (completed) summary.lastCompletedResponse = completed
        }
        continue
      }
    }

    if (record.type !== 'response_item' || payload.type !== 'message') continue
    const text = messageText(payload)
    if (!text) continue
    if (payload.role === 'user') {
      if (!summary.firstPrompt) summary.firstPrompt = text
      summary.latestPrompt = text
    } else if (payload.role === 'assistant' && payload.phase === 'final_answer') {
      summary.lastFinalResponse = text
    }
  }
  return summary
}

function mergeParts(head: SummaryPart, tail: SummaryPart): CodexRuntimeSession {
  return {
    summary: {
      createdAt: head.createdAt ?? tail.createdAt,
      firstPrompt: firstCharacters(head.firstPrompt || tail.firstPrompt, 50),
      latestPrompt: firstCharacters(tail.latestPrompt || head.latestPrompt, 50),
      lastCompletedResponse: lastCharacters(
        tail.lastCompletedResponse
          || head.lastCompletedResponse
          || tail.lastFinalResponse
          || head.lastFinalResponse,
        50,
      ),
      goal: '',
    },
    threadId: head.threadId ?? tail.threadId,
    taskActive: tail.taskActive ?? head.taskActive,
  }
}

function isInside(candidate: string, root: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`)
}

export class CodexSessionInspector {
  private readonly procRoot: string
  private readonly sessionRoots: string[]
  private readonly goalDatabasePath: string
  private readonly cache = new Map<string, CachedInspection>()
  private goalDatabase: DatabaseSync | null = null

  constructor(options: CodexSessionInspectorOptions = {}) {
    this.procRoot = path.resolve(options.procRoot ?? '/proc')
    const codexHome = process.env.CODEX_HOME && path.isAbsolute(process.env.CODEX_HOME)
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), '.codex')
    this.sessionRoots = (options.sessionRoots ?? [
      path.join(codexHome, 'sessions'),
      path.join(codexHome, 'archived_sessions'),
    ]).map((root) => path.resolve(root))
    this.goalDatabasePath = path.resolve(options.goalDatabasePath ?? path.join(codexHome, 'goals_1.sqlite'))
  }

  async inspect(pid: number): Promise<CodexSessionSummary | null> {
    const runtime = await this.inspectRuntime(pid)
    return runtime ? { ...runtime.summary } : null
  }

  async inspectRuntime(pid: number): Promise<CodexRuntimeSession | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    const sessionPath = await this.findOpenSession(pid)
    if (!sessionPath) return null

    try {
      const stats = await fs.stat(sessionPath)
      if (!stats.isFile()) return null
      const cached = this.cache.get(sessionPath)
      if (cached && cached.size === stats.size && cached.modifiedAt === stats.mtimeMs) {
        return this.withCurrentGoal(cached.value)
      }

      const handle = await fs.open(sessionPath, 'r')
      try {
        let headSummary: SummaryPart
        if (cached && stats.size > cached.size) {
          headSummary = {
            threadId: cached.value.threadId,
            createdAt: cached.value.summary.createdAt,
            firstPrompt: cached.value.summary.firstPrompt,
            latestPrompt: cached.value.summary.latestPrompt,
            lastCompletedResponse: cached.value.summary.lastCompletedResponse,
            lastFinalResponse: '',
            taskActive: cached.value.taskActive,
          }
        } else {
          const headLength = Math.min(HEAD_BYTES, stats.size)
          const headBuffer = Buffer.alloc(headLength)
          await handle.read(headBuffer, 0, headLength, 0)
          let headText = headBuffer.toString('utf8')
          if (stats.size > headLength) headText = headText.slice(0, headText.lastIndexOf('\n') + 1)
          headSummary = summarizeLines(headText)
        }

        let tailText = ''
        if (stats.size > HEAD_BYTES || cached) {
          const tailStart = Math.max(0, stats.size - TAIL_BYTES)
          const readStart = Math.max(0, tailStart - 1)
          const tailLength = stats.size - readStart
          const tailBuffer = Buffer.alloc(tailLength)
          await handle.read(tailBuffer, 0, tailLength, readStart)
          tailText = tailBuffer.toString('utf8')
          if (readStart > 0) {
            const firstBreak = tailText.indexOf('\n')
            tailText = firstBreak >= 0 ? tailText.slice(firstBreak + 1) : ''
          }
        }

        const value = mergeParts(headSummary, summarizeLines(tailText))
        this.cache.set(sessionPath, { size: stats.size, modifiedAt: stats.mtimeMs, value })
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
        return this.withCurrentGoal(value)
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  private withCurrentGoal(value: CodexRuntimeSession): CodexRuntimeSession {
    return {
      summary: { ...value.summary, goal: this.readGoal(value.threadId) },
      threadId: value.threadId,
      taskActive: value.taskActive,
    }
  }

  private readGoal(threadId: string | null): string {
    if (!threadId) return ''
    try {
      this.goalDatabase ??= new DatabaseSync(this.goalDatabasePath, { readOnly: true })
      const row = this.goalDatabase.prepare(
        'SELECT objective FROM thread_goals WHERE thread_id = ? LIMIT 1',
      ).get(threadId) as { objective?: unknown } | undefined
      return typeof row?.objective === 'string'
        ? normalizedText(row.objective).slice(0, 4_000)
        : ''
    } catch {
      try {
        this.goalDatabase?.close()
      } catch {
        // The read-only Codex goal database may disappear during an upgrade.
      }
      this.goalDatabase = null
      return ''
    }
  }

  private async findOpenSession(pid: number): Promise<string | null> {
    const descriptorDirectory = path.join(this.procRoot, String(pid), 'fd')
    let descriptors: string[]
    try {
      descriptors = await fs.readdir(descriptorDirectory)
    } catch {
      return null
    }

    const candidates: Array<{ path: string; modifiedAt: number }> = []
    await Promise.all(descriptors.map(async (descriptor) => {
      try {
        const descriptorPath = path.join(descriptorDirectory, descriptor)
        const target = await fs.readlink(descriptorPath)
        if (target.endsWith(' (deleted)')) return
        const candidate = path.resolve(path.isAbsolute(target) ? target : path.join(descriptorDirectory, target))
        if (path.extname(candidate) !== '.jsonl' || !this.sessionRoots.some((root) => isInside(candidate, root))) return
        const stats = await fs.stat(candidate)
        if (stats.isFile()) candidates.push({ path: candidate, modifiedAt: stats.mtimeMs })
      } catch {
        // File descriptors may close while a process scan is running.
      }
    }))
    return candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.path ?? null
  }
}
