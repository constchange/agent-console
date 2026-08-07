import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreTaskRuntimeDependencies, StructuredCodexControl } from '../core/adapters/core-task-runtime'
import type { CodexAppServerCallbacks, StartCodexTaskOptions } from '../core/adapters/codex-app-server'
import { ConsoleCore } from '../core/console-core'
import { createDefaultState, StateStore } from '../core/services/state-store'
import type { ActionResult, CoreTaskRecord } from '../shared/types'

const directories: string[] = []
const context = {
  connectionId: 'desktop-test',
  channel: 'desktop' as const,
  client: { name: 'test', version: '0.5.0' },
}

class FakeStructured implements StructuredCodexControl {
  stoppedAll = false

  constructor(private readonly callbacks: CodexAppServerCallbacks) {}

  async startTask(options: StartCodexTaskOptions): Promise<unknown> {
    this.callbacks.onEvent?.({
      taskId: options.taskId!, type: 'task.started', status: 'running',
      summary: 'Structured task started.', createdAt: new Date().toISOString(),
    })
    return {}
  }

  async message(): Promise<ActionResult> {
    return { ok: true, action: 'message', message: 'ok' }
  }

  async interrupt(): Promise<ActionResult> {
    return { ok: true, action: 'interrupt', message: 'ok' }
  }

  decideApproval(): ActionResult {
    return { ok: true, action: 'approval', message: 'ok' }
  }

  stop(): void {}
  stopAll(): void { this.stoppedAll = true }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('ConsoleCore structured runtime wiring', () => {
  it('routes desktop task methods to the injected app-server runtime and stops it with Core', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-runtime-'))
    directories.push(directory)
    const state = createDefaultState()
    state.agents = [{ ...state.agents[0], cwd: '/tmp/project', tmuxSession: '', command: '' }]
    const store = new StateStore(directory)
    await store.load()
    await store.save(state)
    await store.flush()

    let structured!: FakeStructured
    const dependencies: CoreTaskRuntimeDependencies = {
      tmuxControl: {
        inspect: vi.fn(async () => { throw new Error('not configured') }),
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
      },
      createStructuredCodex: (callbacks) => {
        structured = new FakeStructured(callbacks)
        return structured
      },
    }
    const core = new ConsoleCore(directory, '0.5.0', { runtime: dependencies })
    await core.start()
    try {
      const task = await core.handle('task.start', {
        agentId: state.agents[0].id,
        prompt: 'Run the focused tests',
      }, context) as CoreTaskRecord
      expect(task).toMatchObject({ adapter: 'codex-structured', status: 'running', active: true })
      await expect(core.handle('task.message', { taskId: task.id, message: 'Continue' }, context))
        .resolves.toMatchObject({ ok: true })
      const listed = await core.handle('task.list', undefined, context) as CoreTaskRecord[]
      expect(listed.find((item) => item.id === task.id)).toMatchObject({ summary: 'Codex received additional input.' })
    } finally {
      await core.stop()
    }
    expect(structured.stoppedAll).toBe(true)
  })
})
