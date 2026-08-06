export type ShutdownDrainResult =
  | { status: 'completed' }
  | { status: 'failed'; error: unknown }
  | { status: 'timed-out' }

export interface ShutdownDrainOptions {
  drain: () => Promise<void>
  abort: () => void
  timeoutMs: number
}

function deadline(milliseconds: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(1, milliseconds))
  })
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * Gives the normal save/flush path one shared deadline. If it expires, abort
 * rejects the active Core request so the already-queued operations can settle
 * without multiplying their individual RPC timeouts during application exit.
 */
export async function drainForShutdown(options: ShutdownDrainOptions): Promise<ShutdownDrainResult> {
  const timeout = deadline(options.timeoutMs)
  const completion: Promise<ShutdownDrainResult> = Promise.resolve()
    .then(options.drain)
    .then(
      () => ({ status: 'completed' } as const),
      (error: unknown) => ({ status: 'failed', error } as const),
    )

  const result = await Promise.race([
    completion,
    timeout.promise.then<ShutdownDrainResult>(() => ({ status: 'timed-out' })),
  ])
  timeout.cancel()

  if (result.status !== 'timed-out') return result

  try {
    options.abort()
  } catch {
    // Application exit must continue even if the transport was already gone.
  }

  // CoreClient.disconnect() rejects active requests synchronously. One event-loop
  // turn lets those rejections drain the remaining promise queue without adding
  // a second shutdown deadline if an unrelated operation cannot settle.
  await Promise.race([
    completion.then(() => undefined),
    new Promise<void>((resolve) => setImmediate(resolve)),
  ])
  return result
}
