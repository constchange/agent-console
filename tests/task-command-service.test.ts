import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CORE_RPC_ERROR } from '../shared/core-protocol'
import { TaskCommandService, type TaskActionAdapter } from '../core/services/task-command-service'
import { TaskLedger } from '../core/services/task-ledger'

const directories: string[] = []

async function fixture(adapterOverrides: Partial<TaskActionAdapter> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-console-command-service-'))
  directories.push(directory)
  const ledger = new TaskLedger(path.join(directory, 'ledger.sqlite'))
  const task = ledger.createTask({
    agentId: 'agent-1', adapter: 'tmux-compatibility', status: 'running', summary: 'Agent is running.',
  }).task
  const adapter: TaskActionAdapter = {
    message: vi.fn(async () => ({ ok: true })),
    interrupt: vi.fn(async () => ({ ok: true })),
    decideApproval: vi.fn(async () => ({ ok: true })),
    ...adapterOverrides,
  }
  const service = new TaskCommandService(ledger, { 'tmux-compatibility': adapter })
  return { ledger, task, adapter, service }
}

function envelope(taskId: string, version = 1, requestId = 'request-1') {
  const now = Date.now()
  return {
    requestId,
    actor: { userId: 'user-1', deviceId: 'device-1' },
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    taskId,
    expectedTaskVersion: version,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('TaskCommandService', () => {
  it('executes a duplicate message once and returns the first durable result', async () => {
    const { ledger, task, adapter, service } = await fixture()
    const request = { ...envelope(task.id), message: 'Continue with the safe plan.' }
    const first = await service.message(request)
    const duplicate = await service.message(request)
    expect(first).toMatchObject({ ok: true, duplicate: false, taskVersion: 2 })
    expect(duplicate).toMatchObject({ ok: true, duplicate: true, taskVersion: 2 })
    expect(adapter.message).toHaveBeenCalledTimes(1)
    ledger.close()
  })

  it('rejects stale, expired and control-character messages before adapter effects', async () => {
    const { ledger, task, adapter, service } = await fixture()
    await expect(service.message({
      ...envelope(task.id, 2), message: 'stale',
    })).rejects.toMatchObject({ code: CORE_RPC_ERROR.STALE_TASK })
    expect(() => service.message({
      ...envelope(task.id), issuedAt: 'invalid', expiresAt: 'invalid', message: 'bad time',
    })).toThrow(expect.objectContaining({ code: CORE_RPC_ERROR.INVALID_PARAMS }))
    expect(() => service.message({
      ...envelope(task.id), message: 'bad\u0007message',
    })).toThrow(expect.objectContaining({ code: CORE_RPC_ERROR.INVALID_PARAMS }))
    expect(adapter.message).not.toHaveBeenCalled()
    ledger.close()
  })

  it('marks an uncertain adapter failure unknown and never repeats it', async () => {
    const failing = vi.fn(async () => { throw new Error('ambiguous transport failure') })
    const { ledger, task, service } = await fixture({ message: failing })
    const request = { ...envelope(task.id), message: 'Send once only.' }
    await expect(service.message(request)).rejects.toMatchObject({ code: CORE_RPC_ERROR.REQUEST_OUTCOME_UNKNOWN })
    await expect(service.message(request)).rejects.toMatchObject({ code: CORE_RPC_ERROR.REQUEST_OUTCOME_UNKNOWN })
    expect(failing).toHaveBeenCalledTimes(1)
    ledger.close()
  })

  it('rechecks expiry after waiting in the per-task queue', async () => {
    let releaseFirst!: () => void
    let markStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const message = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        markStarted()
        await firstBlocked
      }
      return { ok: true }
    })
    const { ledger, task, service } = await fixture({ message })
    const first = service.message({ ...envelope(task.id), message: 'First.' })
    await firstStarted
    const now = Date.now()
    const second = service.message({
      ...envelope(task.id, 2, 'request-2'),
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 20).toISOString(),
      message: 'Must expire while queued.',
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    releaseFirst()
    await first
    await expect(second).rejects.toMatchObject({ code: CORE_RPC_ERROR.REQUEST_EXPIRED })
    expect(message).toHaveBeenCalledTimes(1)
    ledger.close()
  })

  it('runs the live authorization guard before creating a receipt or adapter effect', async () => {
    const { ledger, task, adapter, service } = await fixture()
    const request = { ...envelope(task.id), message: 'Do not run after revocation.' }
    const revoked = () => { throw new Error('device revoked') }
    await expect(service.message(request, revoked)).rejects.toThrow('device revoked')
    expect(adapter.message).not.toHaveBeenCalled()
    await expect(service.message(request)).resolves.toMatchObject({ ok: true, duplicate: false })
    expect(adapter.message).toHaveBeenCalledOnce()
    ledger.close()
  })
})
