import { RemoteStore, type OutboxRecord } from './remote-store'

export interface RemoteCloudAdapter {
  apply(item: OutboxRecord): Promise<void>
}

export class RemoteCloudSyncService {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private stopped = true
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly store: RemoteStore,
    private readonly adapter: RemoteCloudAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.trigger().catch(() => undefined)
  }

  async trigger(): Promise<void> {
    if (this.stopped) return
    if (this.running) return this.running
    const operation = this.drain().finally(() => {
      this.running = null
      this.schedule()
    })
    this.running = operation
    return operation
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.running
  }

  private async drain(): Promise<void> {
    const items = this.store.listDueOutbox(new Date(this.now()).toISOString(), 20)
    for (const item of items) {
      if (this.stopped) return
      try {
        await this.adapter.apply(item)
        this.store.atomic(() => {
          if (item.entityType === 'device') {
            if (item.operation !== 'device.upsert' && item.operation !== 'device.revoke') {
              throw new Error('Device outbox operation is invalid.')
            }
            this.store.markDeviceSyncResult(item.entityId, item.operation, true)
          }
          this.store.completeOutbox(item.id)
        })
        this.emitChange()
      } catch {
        // Provider errors may contain URLs, query parameters, identifiers or
        // credential fragments. Persist only a fixed operational state; the
        // next retry time is sufficient for the desktop-facing diagnosis.
        const message = 'Cloud synchronization failed.'
        const delay = Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(12, item.attempts))
        const nextAttemptAt = new Date(this.now() + delay).toISOString()
        this.store.atomic(() => {
          this.store.failOutbox(item.id, message, nextAttemptAt)
          if (item.entityType === 'device'
            && (item.operation === 'device.upsert' || item.operation === 'device.revoke')) {
            this.store.markDeviceSyncResult(item.entityId, item.operation, false, message)
          }
        })
        this.emitChange()
      }
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.trigger().catch(() => undefined)
    }, 5_000)
    this.timer.unref()
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Synchronization must not be disrupted by a desktop observer.
      }
    }
  }
}
