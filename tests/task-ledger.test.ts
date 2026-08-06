import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  }
}

function snapshot(status: AgentStatus = 'running', capturedAt = '2026-08-06T20:00:00.000Z'): RuntimeSnapshot {
  return {
    capturedAt,
    agents: [runtimeAgent(status)],
    discovered: [],
    capabilities: {
      platform: 'linux',
      terminals: [],
      tmux: true,
      wmctrl: false,
      xdotool: false,
      docker: false,
      homeDirectory: '/home/user',
    },
    scanError: null,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('TaskLedger', () => {
  it('persists a bounded public task record across restarts without private runtime fields', async () => {
    const databasePath = await ledgerPath()
    const first = new TaskLedger(databasePath)
    expect(first.storageSettings()).toEqual({
      foreignKeys: true,
      journalMode: 'wal',
      synchronous: 2,
    })
    first.updateFromSnapshot(snapshot())
    expect(first.getTask('agent-alpha')).toMatchObject({
      id: 'agent-alpha',
      displayName: 'Product Agent',
      status: 'running',
      summary: 'Product Agent is running.',
      present: true,
    })
    first.close()

    const second = new TaskLedger(databasePath)
    expect(second.getTask('agent-alpha')).toMatchObject({
      id: 'agent-alpha',
      displayName: 'Product Agent',
      status: 'running',
      summary: 'Product Agent is running.',
    })
    second.close()

    const databaseBytes = await readFile(databasePath)
    const databaseText = databaseBytes.toString('utf8')
    expect(databaseText).not.toContain('/home/user/private-project')
    expect(databaseText).not.toContain('super-secret')
    expect(databaseText).not.toContain('Reasoning about')
    expect(databaseText).not.toContain('private-session')
  })

  it('assigns increasing event sequence numbers and replays strictly after a cursor', async () => {
    const databasePath = await ledgerPath()
    const ledger = new TaskLedger(databasePath)
    ledger.updateFromSnapshot(snapshot('running', '2026-08-06T20:00:00.000Z'))
    ledger.updateFromSnapshot(snapshot('waiting', '2026-08-06T20:00:01.000Z'))
    const manual = ledger.appendEvent({
      taskId: 'agent-alpha',
      type: 'task.note',
      status: 'waiting',
      summary: 'A short user-visible note.',
      createdAt: '2026-08-06T20:00:02.000Z',
    })

    expect(manual.seq).toBe(3)
    expect(ledger.replayEvents(0).map((event) => event.seq)).toEqual([1, 2, 3])
    expect(ledger.replayEvents(1).map((event) => event.seq)).toEqual([2, 3])
    expect(ledger.replayEvents(3)).toEqual([])
    ledger.close()

    const reopened = new TaskLedger(databasePath)
    const afterRestart = reopened.appendEvent({ type: 'core.restarted', summary: 'Core restarted.' })
    expect(afterRestart.seq).toBe(4)
    reopened.close()
  })

  it('returns the first stored response for a duplicate request, including after restart', async () => {
    const databasePath = await ledgerPath()
    const first = new TaskLedger(databasePath)
    const initial = first.rememberRequest('request-001', 'agent.open', {
      ok: true,
      action: 'opened',
      message: 'Agent opened.',
    })
    const duplicate = first.rememberRequest('request-001', 'agent.open', {
      ok: false,
      action: 'should-not-replace',
      message: 'This response must not replace the first one.',
    })
    expect(initial.duplicate).toBe(false)
    expect(duplicate).toEqual({
      duplicate: true,
      response: { ok: true, action: 'opened', message: 'Agent opened.' },
    })
    first.close()

    const second = new TaskLedger(databasePath)
    expect(second.findRequest('request-001', 'agent.open')).toEqual({
      ok: true,
      action: 'opened',
      message: 'Agent opened.',
    })
    expect(() => second.findRequest('request-001', 'project.restore')).toThrow(
      'Request ID was already used for a different operation.',
    )
    second.close()
  })
})
