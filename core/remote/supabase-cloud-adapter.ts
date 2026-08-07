import type { AuthenticatedSupabaseDatabaseProvider } from '../auth/supabase-auth-service'
import {
  requireOpaqueId,
  requireRecord,
  requireString,
  requireUuid,
} from '../../shared/remote-validation'
import { p256PublicKeyFingerprint, validateP256PublicJwk } from './device-signature'
import { grantOutboxEntityId } from './outbox-identity'
import type { RemoteCloudAdapter } from './cloud-sync-service'
import type { OutboxRecord } from './remote-store'

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new Error('Remote metadata outbox item contains unsupported fields.')
  }
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`)
  return value
}

function timestamp(value: unknown, label: string): string {
  const text = requireString(value, label, { max: 40 })
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} is invalid.`)
  return new Date(text).toISOString()
}

function displayName(value: unknown): string {
  const text = requireString(value, 'Display name', { max: 100 })
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) throw new Error('Display name is invalid.')
  return text
}

function assertEntity(item: OutboxRecord, type: string, id: string): void {
  if (item.entityType !== type || item.entityId !== id) {
    throw new Error('Remote metadata outbox identity does not match its payload.')
  }
}

function cloudFailure(message: string): Error {
  // Do not persist a PostgREST error verbatim: it can contain query details.
  return new Error(message)
}

/**
 * Applies the public outbox through the signed-in user's Supabase RLS session.
 * It accepts a fixed operation union; arbitrary table names/queries cannot be
 * supplied by outbox data.
 */
export class SupabaseRemoteCloudAdapter implements RemoteCloudAdapter {
  constructor(private readonly provider: AuthenticatedSupabaseDatabaseProvider) {}

  async apply(item: OutboxRecord): Promise<void> {
    await this.provider.withAuthenticatedDatabase(async (database, userId) => {
      const payload = requireRecord(item.payload, 'Remote metadata outbox payload')
      switch (item.operation) {
        case 'workstation.upsert': {
          onlyKeys(payload, ['workstationId', 'displayName', 'remoteEnabled', 'updatedAt'])
          const workstationId = requireUuid(payload.workstationId, 'Workstation ID')
          assertEntity(item, 'workstation', workstationId)
          const result = await database.from('agent_console_workstations').upsert({
            id: workstationId,
            user_id: userId,
            display_name: displayName(payload.displayName),
            route_id: workstationId,
            protocol_version: 1,
            remote_enabled: booleanValue(payload.remoteEnabled, 'Remote enabled'),
            updated_at: timestamp(payload.updatedAt, 'Workstation update time'),
            last_seen_at: new Date().toISOString(),
          }, { onConflict: 'id' })
          if (result.error) throw cloudFailure('Cloud workstation synchronization failed.')
          return
        }
        case 'workstation.delete': {
          onlyKeys(payload, ['workstationId'])
          const workstationId = requireUuid(payload.workstationId, 'Workstation ID')
          assertEntity(item, 'workstation', workstationId)
          const result = await database.from('agent_console_workstations')
            .delete()
            .eq('id', workstationId)
            .eq('user_id', userId)
          if (result.error) throw cloudFailure('Cloud workstation removal failed.')
          return
        }
        case 'device.upsert': {
          onlyKeys(payload, [
            'deviceId', 'workstationId', 'ownerUserId', 'displayName', 'publicJwk',
            'fingerprint', 'state', 'pairedAt', 'revokedAt',
          ])
          const workstationId = requireUuid(payload.workstationId, 'Workstation ID')
          const deviceId = requireUuid(payload.deviceId, 'Device ID')
          assertEntity(item, 'device', deviceId)
          if (payload.ownerUserId !== undefined && requireUuid(payload.ownerUserId, 'Owner user ID') !== userId) {
            throw new Error('Remote metadata owner does not match the signed-in user.')
          }
          if (payload.state !== 'active' && payload.state !== 'pending_sync') {
            throw new Error('Device upsert state is invalid.')
          }
          const publicJwk = validateP256PublicJwk(payload.publicJwk)
          const fingerprint = requireString(payload.fingerprint, 'Device fingerprint', {
            max: 43,
            pattern: /^[A-Za-z0-9_-]{43}$/,
          })
          if (p256PublicKeyFingerprint(publicJwk) !== fingerprint) {
            throw new Error('Device fingerprint does not match its public key.')
          }
          const pairedAt = timestamp(payload.pairedAt, 'Device pairing time')
          const updatedAt = new Date().toISOString()
          const deviceResult = await database.from('agent_console_devices').upsert({
            id: deviceId,
            user_id: userId,
            display_name: displayName(payload.displayName),
            public_key_jwk: publicJwk,
            key_fingerprint: fingerprint,
            updated_at: updatedAt,
            last_seen_at: updatedAt,
          }, { onConflict: 'id' })
          if (deviceResult.error) throw cloudFailure('Cloud device synchronization failed.')
          const linkResult = await database.from('agent_console_workstation_devices').upsert({
            workstation_id: workstationId,
            device_id: deviceId,
            user_id: userId,
            status: 'active',
            paired_at: pairedAt,
            revoked_at: null,
            updated_at: updatedAt,
          }, { onConflict: 'workstation_id,device_id' })
          if (linkResult.error) throw cloudFailure('Cloud device link synchronization failed.')
          return
        }
        case 'device.revoke': {
          onlyKeys(payload, ['deviceId', 'workstationId', 'revokedAt', 'state'])
          const workstationId = requireUuid(payload.workstationId, 'Workstation ID')
          const deviceId = requireUuid(payload.deviceId, 'Device ID')
          assertEntity(item, 'device', deviceId)
          if (payload.state !== 'revoke_pending' && payload.state !== 'revoked') {
            throw new Error('Device revocation state is invalid.')
          }
          const result = await database.from('agent_console_workstation_devices')
            .update({
              status: 'revoked',
              revoked_at: timestamp(payload.revokedAt, 'Device revocation time'),
              updated_at: new Date().toISOString(),
            })
            .eq('workstation_id', workstationId)
            .eq('device_id', deviceId)
            .eq('user_id', userId)
          if (result.error) throw cloudFailure('Cloud device revocation failed.')
          return
        }
        case 'grant.upsert': {
          onlyKeys(payload, [
            'workstationId', 'deviceId', 'agentId', 'canView', 'canMessage',
            'canInterrupt', 'canApprove', 'revision', 'updatedAt',
          ])
          const workstationId = requireUuid(payload.workstationId, 'Workstation ID')
          const deviceId = requireUuid(payload.deviceId, 'Device ID')
          const agentId = requireOpaqueId(payload.agentId, 'Agent ID')
          assertEntity(item, 'grant', grantOutboxEntityId(deviceId, agentId))
          if (!Number.isSafeInteger(payload.revision) || Number(payload.revision) < 1) {
            throw new Error('Grant revision is invalid.')
          }
          const result = await database.from('agent_console_agent_grants').upsert({
            workstation_id: workstationId,
            device_id: deviceId,
            user_id: userId,
            agent_id: agentId,
            can_view: booleanValue(payload.canView, 'View permission'),
            can_message: booleanValue(payload.canMessage, 'Message permission'),
            can_interrupt: booleanValue(payload.canInterrupt, 'Interrupt permission'),
            can_approve: booleanValue(payload.canApprove, 'Approval permission'),
            revision: Number(payload.revision),
            updated_at: timestamp(payload.updatedAt, 'Grant update time'),
          }, { onConflict: 'workstation_id,device_id,agent_id' })
          if (result.error) throw cloudFailure('Cloud permission synchronization failed.')
          return
        }
        default:
          throw new Error('Remote metadata outbox operation is not supported.')
      }
    })
  }
}
