import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatus, RuntimeAgent, RuntimeSnapshot } from '../shared/types'
import { TaskLedger } from '../core/services/task-ledger'

const temporaryDirectories: string[] = []

async function ledgerPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-console-task-ledger-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'task-ledger.sqlite')
}

function runtimeAgent(status: AgentStatus = 'running'): RuntimeAgent {
  return {
    id: 'agent-alpha',
    projectId: 'product',
    name: 'Product Agent',
    emoji: '◆',
    color: '#55a6ff',
    kind: 'codex',
    terminalTitle: 'Secret terminal title',
    terminalApp: 'auto',
    tmuxSession: 'private-session',
    command: 'codex --token super-secret',
    cwd: '/home/user/private-project',
    note: 'private note',
    goal: 'private goal',
    matchPattern: 'secret-pattern',
    logPath: '/home/user/private.log',
    autoStart: true,
    order: 0,
    pid: 4_212,
    statusOverride: null,
    cpu: 3.4,
    memory: 1.2,
    runtimeSeconds: 90,
    status,
    lastUpdated: '2026-08-06T20:00:00.000Z',
    lastOutput: 'Reasoning about /home/user/private-project with super-secret',
    processName: 'codex',
    processState: 'S+',
    terminalOpen: true,
    codexSession: null,
  }
}

function snapshot(status: AgentStatus = 'running', capturedAt = '2026-08-06T20:00:00.000Z'): RuntimeSnapshot {
  return {
    capturedAt,
    agents: [runtimeAgent(status)],
    discovered: [],
    capabilities: {
      platform: 'linux', terminals: [], tmux: true, wmctrl: false,
      xdotool: false, docker: false, homeDirectory: '/home/user',
    },
    scanError: null,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('TaskLedger v2', () => {
  it('keeps a stable task UUID across Core restarts without persisting private runtime fields', async () => {
    const databasePath = await ledgerPath()
    const first = new TaskLedger(databasePath)
    expect(first.storageSettings()).toEqual({
      foreignKeys: true,
      journalMode: 'wal',
      synchronous: 2,
      schemaVersion: 2,
    })
    const initial = first.updateFromSnapshot(snapshot())
    expect(initial.tasks).toHaveLength(1)
    expect(initial.tasks[0]).toMatchObject({
      agentId: 'agent-alpha', adapter: 'process-monitor', status: 'running', active: true, version: 1,
    })
    expect(initial.tasks[0].id).not.toBe('agent-alpha')
    const taskId = initial.tasks[0].id
    first.close()

    const second = new TaskLedger(databasePath)
    second.updateFromSnapshot(snapshot('running', '2026-08-06T20:00:05.000Z'))
    expect(second.getActiveTaskForAgent('agent-alpha')?.id).toBe(taskId)
    second.close()

    const databaseText = (await readFile(databasePath)).toString('utf8')
    for (const secret of ['/home/user/private-project', 'super-secret', 'Reasoning about', 'private-session']) {
      expect(databaseText).not.toContain(secret)
    }
  })

  it('creates distinct sequential task runs for one Agent and preserves the event cursor', async () => {
    const databasePath = await ledgerPath()
    const ledger = new TaskLedger(databasePath)
    const first = ledger.updateFromSnapshot(snapshot('running', '2026-08-06T20:00:00.000Z')).tasks[0]
    ledger.updateFromSnapshot(snapshot('waiting', '2026-08-06T20:00:01.000Z'))
    ledger.updateFromSnapshot(snapshot('finished', '2026-08-06T20:00:02.000Z'))
    const second = ledger.updateFromSnapshot(snapshot('running', '2026-08-06T20:00:03.000Z'))
      .tasks.find((task) => task.active)!

    expect(second.id).not.toBe(first.id)
    expect(ledger.listTasks('agent-alpha')).toHaveLength(2)
    expect(ledger.listTasks('agent-alpha').filter((task) => task.active)).toHaveLength(1)
    const replay = ledger.events(0, 100)
    expect(replay.resetRequired).toBe(false)
    expect(replay.events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    const streamId = replay.streamId
    ledger.close()

    const reopened = new TaskLedger(databasePath)
    expect(reopened.latestEventSeq()).toBe(4)
    expect(reopened.streamId()).toBe(streamId)
    reopened.close()
  })

  it('migrates a v1 Agent snapshot without deleting legacy rows', async () => {
    const databasePath = await ledgerPath()
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
        display_name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
        present INTEGER NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        source_captured_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO tasks VALUES (
        'agent-old', 'agent-old', 'project-old', 'Old Agent', 'codex', 'running',
        'Old Agent is running.', 1, '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `)
    legacy.close()

    const migrated = new TaskLedger(databasePath)
    expect(migrated.storageSettings().schemaVersion).toBe(2)
    expect(migrated.listObservations()).toContainEqual(expect.objectContaining({
      agentId: 'agent-old', displayName: 'Old Agent', present: true,
    }))
    migrated.close()

    const inspected = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 })
    inspected.close()
  })

  it('claims before effects, returns durable duplicates and turns crash leftovers into unknown', async () => {
    const databasePath = await ledgerPath()
    const first = new TaskLedger(databasePath)
    const task = first.createTask({
      agentId: 'agent-alpha', adapter: 'tmux-compatibility', status: 'running', summary: 'Agent is running.',
    }).task
    const secretBody = { message: 'do not persist this secret message' }
    const requestHash = TaskLedger.requestHash(secretBody)
    const issuedAt = new Date(Date.now() - 1_000).toISOString()
    const expiresAt = new Date(Date.now() + 30_000).toISOString()
    const base = {
      operation: 'task.message', taskId: task.id, expectedTaskVersion: task.version,
      actorUserId: 'user-1', actorDeviceId: 'device-1', requestHash,
      issuedAt, expiresAt,
    }
    expect(first.claimRemoteRequest({ ...base, requestId: 'request-1' }).kind).toBe('claimed')
    const completed = first.completeRemoteRequest({
      requestId: 'request-1', ok: true, action: 'message_sent', message: 'Message accepted.',
      outcome: 'completed', nextStatus: 'running', active: true,
      summary: 'Agent received a remote message.', eventType: 'task.message_received',
    })
    expect(completed.response).toMatchObject({ duplicate: false, taskVersion: 2 })
    expect(first.claimRemoteRequest({ ...base, requestId: 'request-1' })).toMatchObject({
      kind: 'duplicate', response: { duplicate: true, taskVersion: 2 },
    })
    expect(() => first.claimRemoteRequest({
      ...base, requestId: 'request-1', requestHash: TaskLedger.requestHash({ message: 'different' }),
    })).toThrow('different request content')

    expect(first.claimRemoteRequest({
      ...base, requestId: 'request-crash', expectedTaskVersion: 2,
    }).kind).toBe('claimed')
    first.close()

    const reopened = new TaskLedger(databasePath)
    expect(reopened.claimRemoteRequest({
      ...base, requestId: 'request-crash', expectedTaskVersion: 2,
    }).kind).toBe('unknown')
    reopened.close()
    expect((await readFile(databasePath)).toString('utf8')).not.toContain(secretBody.message)
  })

  it('prunes expired inner request receipts before admitting new IDs', async () => {
    const databasePath = await ledgerPath()
    const ledger = new TaskLedger(databasePath)
    const task = ledger.createTask({
      agentId: 'agent-alpha', adapter: 'tmux-compatibility', status: 'running', summary: 'Agent is running.',
    }).task
    const base = {
      operation: 'task.message',
      taskId: task.id,
      expectedTaskVersion: task.version,
      actorUserId: 'user-1',
      actorDeviceId: 'device-1',
      requestHash: TaskLedger.requestHash({ message: 'redacted' }),
      issuedAt: new Date(Date.now() - 2_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }
    expect(ledger.claimRemoteRequest({ ...base, requestId: 'expired-id' }).kind).toBe('claimed')
    const live = {
      ...base,
      requestId: 'live-id',
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    }
    expect(ledger.claimRemoteRequest(live).kind).toBe('claimed')
    // The expired ID was removed, so it is no longer an in-progress replay.
    expect(ledger.claimRemoteRequest({
      ...base,
      requestId: 'expired-id',
      issuedAt: live.issuedAt,
      expiresAt: live.expiresAt,
    }).kind).toBe('claimed')
    ledger.close()
  })
})
