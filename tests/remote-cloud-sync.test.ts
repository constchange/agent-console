import { describe, expect, it } from 'vitest'
import type {
  AuthenticatedSupabaseDatabase,
  AuthenticatedSupabaseDatabaseProvider,
} from '../core/auth/supabase-auth-service'
import { RemoteCloudSyncService } from '../core/remote/cloud-sync-service'
import { p256PublicKeyFingerprint } from '../core/remote/device-signature'
import { grantOutboxEntityId } from '../core/remote/outbox-identity'
import { RemoteStore } from '../core/remote/remote-store'
import { SupabaseRemoteCloudAdapter } from '../core/remote/supabase-cloud-adapter'
import { p256Fixture } from './remote-test-helpers'

const workstationId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const ownerId = '33333333-3333-4333-8333-333333333333'

interface RecordedQuery {
  table: string
  operation: 'upsert' | 'update' | 'delete'
  value?: unknown
  filters: Array<[string, unknown]>
}

class FakeQuery implements PromiseLike<{ error: null }> {
  private current: RecordedQuery | null = null

  constructor(private readonly table: string, private readonly queries: RecordedQuery[]) {}

  upsert(value: unknown): Promise<{ error: null }> {
    this.queries.push({ table: this.table, operation: 'upsert', value, filters: [] })
    return Promise.resolve({ error: null })
  }

  update(value: unknown): this {
    this.current = { table: this.table, operation: 'update', value, filters: [] }
    this.queries.push(this.current)
    return this
  }

  delete(): this {
    this.current = { table: this.table, operation: 'delete', filters: [] }
    this.queries.push(this.current)
    return this
  }

  eq(column: string, value: unknown): this {
    this.current?.filters.push([column, value])
    return this
  }

  then<TResult1 = { error: null }, TResult2 = never>(
    onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ error: null }).then(onfulfilled, onrejected)
  }
}

class FakeProvider implements AuthenticatedSupabaseDatabaseProvider {
  readonly queries: RecordedQuery[] = []

  async withAuthenticatedDatabase<T>(
    operation: (database: AuthenticatedSupabaseDatabase, userId: string) => Promise<T>,
  ): Promise<T> {
    const database = {
      from: (table: string) => new FakeQuery(table, this.queries),
    } as unknown as AuthenticatedSupabaseDatabase
    return operation(database, ownerId)
  }
}

describe('Supabase remote metadata outbox', () => {
  it('drains the fixed RLS table operations and only activates a device after cloud success', async () => {
    const key = p256Fixture()
    const store = new RemoteStore(':memory:')
    const workstation = store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    const device = store.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
      state: 'pending_sync',
    })
    const grant = store.setGrant({
      deviceId,
      agentId: 'agent-1',
      canView: true,
      canMessage: true,
      canInterrupt: false,
      canApprove: false,
    })
    store.enqueueOutbox({
      operation: 'workstation.upsert',
      entityType: 'workstation',
      entityId: workstation.id,
      payload: {
        workstationId: workstation.id,
        displayName: workstation.name,
        remoteEnabled: workstation.remoteEnabled,
        updatedAt: workstation.updatedAt,
      },
    })
    store.enqueueOutbox({
      operation: 'device.upsert',
      entityType: 'device',
      entityId: device.id,
      payload: {
        workstationId,
        deviceId,
        ownerUserId: ownerId,
        displayName: device.name,
        publicJwk: device.publicJwk,
        fingerprint: device.fingerprint,
        state: device.state,
        pairedAt: device.pairedAt,
      },
    })
    store.enqueueOutbox({
      operation: 'grant.upsert',
      entityType: 'grant',
      entityId: grantOutboxEntityId(grant.deviceId, grant.agentId),
      payload: { workstationId, ...grant },
    })

    const provider = new FakeProvider()
    const sync = new RemoteCloudSyncService(store, new SupabaseRemoteCloudAdapter(provider))
    sync.start()
    await sync.trigger()

    expect(store.outboxCount()).toBe(0)
    expect(store.getDevice(deviceId)?.state).toBe('active')
    expect(provider.queries.map((query) => `${query.table}:${query.operation}`)).toEqual([
      'agent_console_workstations:upsert',
      'agent_console_devices:upsert',
      'agent_console_workstation_devices:upsert',
      'agent_console_agent_grants:upsert',
    ])
    await sync.stop()
    store.close()
  })
})
