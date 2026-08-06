import { describe, expect, it, vi } from 'vitest'
import { drainForShutdown } from '../electron/services/shutdown-drain'

describe('desktop shutdown drain', () => {
  it('completes the normal save and flush path without aborting it', async () => {
    const abort = vi.fn()
    const result = await drainForShutdown({
      drain: async () => undefined,
      abort,
      timeoutMs: 100,
    })

    expect(result).toEqual({ status: 'completed' })
    expect(abort).not.toHaveBeenCalled()
  })

  it('uses one deadline and aborts a stuck Core request', async () => {
    let rejectDrain: ((error: Error) => void) | null = null
    const stuck = new Promise<void>((_resolve, reject) => {
      rejectDrain = reject
    })
    const abort = vi.fn(() => rejectDrain?.(new Error('disconnected')))
    const started = Date.now()

    const result = await drainForShutdown({
      drain: () => stuck,
      abort,
      timeoutMs: 15,
    })

    expect(result).toEqual({ status: 'timed-out' })
    expect(abort).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('stops waiting after one abort-settle turn when the drain cannot reject', async () => {
    const abort = vi.fn()
    const started = Date.now()
    const result = await drainForShutdown({
      drain: () => new Promise<void>(() => undefined),
      abort,
      timeoutMs: 10,
    })

    expect(result).toEqual({ status: 'timed-out' })
    expect(abort).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('lets the serialized operations behind an active request fail after disconnect', async () => {
    let rejectActive: ((error: Error) => void) | null = null
    const active = new Promise<void>((_resolve, reject) => {
      rejectActive = reject
    })
    let queue = active.then(() => undefined, () => undefined)
    let remainingAttempts = 0
    for (let index = 0; index < 3; index += 1) {
      const operation = queue.then(async () => {
        remainingAttempts += 1
        throw new Error('Core disconnected')
      })
      queue = operation.then(() => undefined, () => undefined)
    }

    const result = await drainForShutdown({
      drain: () => queue,
      abort: () => rejectActive?.(new Error('active Core request disconnected')),
      timeoutMs: 10,
    })

    expect(result).toEqual({ status: 'timed-out' })
    expect(remainingAttempts).toBe(3)
  })

  it('reports an ordinary drain failure without waiting for the deadline', async () => {
    const error = new Error('flush failed')
    const abort = vi.fn()
    const result = await drainForShutdown({
      drain: async () => { throw error },
      abort,
      timeoutMs: 100,
    })

    expect(result).toEqual({ status: 'failed', error })
    expect(abort).not.toHaveBeenCalled()
  })
})
