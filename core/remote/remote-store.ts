import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requireOpaqueId, requireUuid } from '../../shared/remote-validation'

const SCHEMA_VERSION = 1
const MAX_NONCES = 8_192
const MAX_NONCES_PER_DEVICE = 1_024
const MAX_RECEIPTS_PER_DEVICE = 4_096
const MAX_RECEIPTS_TOTAL = 32_768
const MAX_OUTBOX = 4_096
const MAX_AUDIT_EVENTS = 10_000
const MAX_PUBLIC_JSON_BYTES = 64 * 1024

export type DeviceState = 'pending_sync' | 'active' | 'revoke_pending' | 'revoked'
export type ReceiptState = 'in_progress' | 'completed' | 'uncertain'

export interface WorkstationRecord {
  id: string
  ownerUserId: string
  name: string
  remoteEnabled: boolean
  authEpoch: number
  createdAt: string
  updatedAt: string
}

export interface PairedDeviceRecord {
  id: string
  ownerUserId: string
  publicJwk: Record<string, unknown>
  fingerprint: string
  name: string
  state: DeviceState
  pairedAt: string
  revokedAt: string | null
  syncError: string
  updatedAt: string
}

export interface DeviceAgentGrant {
  deviceId: string
  agentId: string
  canView: boolean
  canMessage: boolean
  canInterrupt: boolean
  canApprove: boolean
  revision: number
  updatedAt: string
}

export interface StoredRemoteResponse {
  status: number
  body: unknown
}

export type ClaimReceiptResult =
  | { outcome: 'claimed' }
  | { outcome: 'replay'; response: StoredRemoteResponse }
  | { outcome: 'in_progress' | 'uncertain' | 'conflict' | 'missing' }

export interface OutboxRecord {
  id: number
  operation: string
  entityType: string
  entityId: string
  payload: unknown
  attempts: number
  nextAttemptAt: string
  lastError: string
  createdAt: string
}

export interface AuditRecord {
  seq: number
  deviceId: string | null
  requestId: string | null
  action: string
  targetId: string
  outcome: string
  summary: string
  createdAt: string
}

interface WorkstationRow {
  workstation_id: string
  owner_user_id: string
  display_name: string
  remote_enabled: number
  auth_epoch: number | bigint
  created_at: string
  updated_at: string
}

interface DeviceRow {
  device_id: string
  owner_user_id: string
  public_jwk_json: string
  fingerprint: string
  display_name: string
  state: DeviceState
  paired_at: string
  revoked_at: string | null
  sync_error: string
  updated_at: string
}

interface GrantRow {
  device_id: string
  agent_id: string
  can_view: number
  can_message: number
  can_interrupt: number
  can_approve: number
  revision: number | bigint
  updated_at: string
}

interface ReceiptRow {
  operation_hash: string
  state: ReceiptState
  response_status: number | bigint | null
  response_json: string
}

interface OutboxRow {
  outbox_id: number | bigint
  operation: string
  entity_type: string
  entity_id: string
  payload_json: string
  attempts: number | bigint
  next_attempt_at: string
  last_error: string
  created_at: string
}

interface AuditRow {
  seq: number | bigint
  device_id: string | null
  request_id: string | null
  action: string
  target_id: string
  outcome: string
  public_summary: string
  created_at: string
}

function iso(value: string | number | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new Error('Timestamp is invalid.')
  return date.toISOString()
}

function publicText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === 'string' ? value : fallback
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)(?:~\/|\/)[^\s,;]+/g, '$1[private path]')
    .replace(/\b[a-zA-Z]:\\[^\s,;]+/g, '[private path]')
    .trim()
    .slice(0, max) || fallback
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Device key fingerprint is invalid.')
  }
  return value
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function assertPublicPayload(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error('Public payload is too deeply nested.')
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error('Public payload has too many items.')
    for (const item of value) assertPublicPayload(item, depth + 1)
    return
  }
  if (typeof value !== 'object') throw new Error('Public payload contains an unsupported value.')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 1_000) throw new Error('Public payload has too many fields.')
  for (const [key, item] of entries) {
    if (/(?:^|_)(?:authorization|cookie|password|secret|access_token|refresh_token|private_key|credential)(?:$|_)/i.test(key)) {
      throw new Error('Sensitive fields must not be persisted in public remote-control data.')
    }
    assertPublicPayload(item, depth + 1)
  }
}

function canonicalPublicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalPublicValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalPublicValue(item)]),
  )
}

function publicJson(value: unknown): string {
  assertPublicPayload(value)
  const json = JSON.stringify(canonicalPublicValue(value))
  if (Buffer.byteLength(json, 'utf8') > MAX_PUBLIC_JSON_BYTES) throw new Error('Public payload is too large.')
  return json
}

function isSafetyDenyOutbox(operation: string, payloadJson: string): boolean {
  if (operation === 'device.revoke') return true
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    if (operation === 'workstation.upsert') return payload.remoteEnabled === false
    if (operation === 'grant.upsert') {
      return ['canView', 'canMessage', 'canInterrupt', 'canApprove']
        .some((key) => payload[key] === false)
    }
    return false
  } catch {
    return false
  }
}

function parsePublicJson(value: string): unknown {
  const parsed = JSON.parse(value) as unknown
  assertPublicPayload(parsed)
  return parsed
}

function workstationFromRow(row: WorkstationRow): WorkstationRecord {
  return {
    id: row.workstation_id,
    ownerUserId: row.owner_user_id,
    name: row.display_name,
    remoteEnabled: row.remote_enabled === 1,
    authEpoch: Number(row.auth_epoch),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deviceFromRow(row: DeviceRow): PairedDeviceRecord {
  return {
    id: row.device_id,
    ownerUserId: row.owner_user_id,
    publicJwk: parsePublicJson(row.public_jwk_json) as Record<string, unknown>,
    fingerprint: row.fingerprint,
    name: row.display_name,
    state: row.state,
    pairedAt: row.paired_at,
    revokedAt: row.revoked_at,
    syncError: row.sync_error,
    updatedAt: row.updated_at,
  }
}

function grantFromRow(row: GrantRow): DeviceAgentGrant {
  return {
    deviceId: row.device_id,
    agentId: row.agent_id,
    canView: row.can_view === 1,
    canMessage: row.can_message === 1,
    canInterrupt: row.can_interrupt === 1,
    canApprove: row.can_approve === 1,
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  }
}

export class RemoteStore {
  private readonly database: DatabaseSync
  private closed = false
  private transactionDepth = 0

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      if (!path.isAbsolute(databasePath)) throw new Error('Remote-control database path must be absolute.')
      mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
      chmodSync(path.dirname(databasePath), 0o700)
    }
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `)
    this.initializeSchema()
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE remote_request_receipts
      SET state = 'uncertain', updated_at = ?
      WHERE state = 'in_progress'
    `).run(now)
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600)
  }

  /**
   * Commits a related set of local mutations, outbox entries and audit rows
   * together. Store methods may safely open nested savepoints inside it.
   */
  atomic<T>(operation: () => T): T {
    this.assertOpen()
    return this.transaction(operation)
  }

  bindWorkstation(input: { id: string; ownerUserId: string; name: string; now?: string }): WorkstationRecord {
    this.assertOpen()
    const id = requireUuid(input.id, 'Workstation ID')
    const owner = requireUuid(input.ownerUserId, 'Owner user ID')
    const name = publicText(input.name, 'My workstation', 100)
    const now = iso(input.now)
    const existing = this.getWorkstation()
    if (existing && (existing.id !== id || existing.ownerUserId !== owner)) {
      throw new Error('This workstation is already bound to a different account identity.')
    }
    this.database.prepare(`
      INSERT INTO workstation (
        singleton, workstation_id, owner_user_id, display_name,
        remote_enabled, auth_epoch, created_at, updated_at
      ) VALUES (1, ?, ?, ?, 0, 1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
      WHERE workstation.workstation_id = excluded.workstation_id
        AND workstation.owner_user_id = excluded.owner_user_id
    `).run(id, owner, name, now, now)
    return this.getWorkstation()!
  }

  getWorkstation(): WorkstationRecord | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT workstation_id, owner_user_id, display_name, remote_enabled,
             auth_epoch, created_at, updated_at
      FROM workstation WHERE singleton = 1
    `).get() as unknown as WorkstationRow | undefined
    return row ? workstationFromRow(row) : null
  }

  renameWorkstation(name: string, now?: string): WorkstationRecord {
    this.requireWorkstation()
    this.database.prepare('UPDATE workstation SET display_name = ?, updated_at = ? WHERE singleton = 1')
      .run(publicText(name, 'My workstation', 100), iso(now))
    return this.getWorkstation()!
  }

  setRemoteEnabled(enabled: boolean, now?: string): WorkstationRecord {
    const current = this.requireWorkstation()
    if (current.remoteEnabled === enabled) return current
    this.database.prepare(`
      UPDATE workstation
      SET remote_enabled = ?, auth_epoch = auth_epoch + 1, updated_at = ?
      WHERE singleton = 1
    `).run(enabled ? 1 : 0, iso(now))
    return this.getWorkstation()!
  }

  activateDevice(input: {
    id: string
    ownerUserId: string
    publicJwk: Record<string, unknown>
    fingerprint: string
    name: string
    now?: string
    state?: 'active' | 'pending_sync'
  }): PairedDeviceRecord {
    this.assertOpen()
    const workstation = this.requireWorkstation()
    const id = requireUuid(input.id, 'Device ID')
    const owner = requireUuid(input.ownerUserId, 'Device owner user ID')
    if (owner !== workstation.ownerUserId) throw new Error('Device owner does not match this workstation.')
    const keyJson = publicJson(input.publicJwk)
    const keyFingerprint = fingerprint(input.fingerprint)
    const name = publicText(input.name, 'Mobile device', 100)
    const now = iso(input.now)
    const existing = this.getDevice(id)
    if (existing && (existing.ownerUserId !== owner || existing.fingerprint !== keyFingerprint || publicJson(existing.publicJwk) !== keyJson)) {
      throw new Error('Device ID is already bound to a different public key.')
    }
    const state = input.state ?? 'active'
    this.database.prepare(`
      INSERT INTO paired_devices (
        device_id, owner_user_id, public_jwk_json, fingerprint, display_name,
        state, paired_at, revoked_at, sync_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '', ?)
      ON CONFLICT(device_id) DO UPDATE SET
        display_name = excluded.display_name,
        state = excluded.state,
        revoked_at = NULL,
        sync_error = '',
        updated_at = excluded.updated_at
      WHERE paired_devices.owner_user_id = excluded.owner_user_id
        AND paired_devices.fingerprint = excluded.fingerprint
        AND paired_devices.public_jwk_json = excluded.public_jwk_json
    `).run(id, owner, keyJson, keyFingerprint, name, state, now, now)
    const device = this.getDevice(id)
    if (!device || device.state !== state) throw new Error('Device could not be activated safely.')
    return device
  }

  getDevice(deviceId: string): PairedDeviceRecord | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT device_id, owner_user_id, public_jwk_json, fingerprint, display_name,
             state, paired_at, revoked_at, sync_error, updated_at
      FROM paired_devices WHERE device_id = ?
    `).get(requireUuid(deviceId, 'Device ID')) as unknown as DeviceRow | undefined
    return row ? deviceFromRow(row) : null
  }

  listDevices(): PairedDeviceRecord[] {
    this.assertOpen()
    return (this.database.prepare(`
      SELECT device_id, owner_user_id, public_jwk_json, fingerprint, display_name,
             state, paired_at, revoked_at, sync_error, updated_at
      FROM paired_devices ORDER BY paired_at, device_id
    `).all() as unknown as DeviceRow[]).map(deviceFromRow)
  }

  revokeDevice(deviceId: string, syncError = '', now?: string): PairedDeviceRecord {
    const id = requireUuid(deviceId, 'Device ID')
    const current = this.getDevice(id)
    if (!current) throw new Error('Device not found.')
    const timestamp = iso(now)
    this.transaction(() => {
      this.database.prepare(`
        UPDATE paired_devices
        SET state = 'revoke_pending', revoked_at = ?, sync_error = ?, updated_at = ?
        WHERE device_id = ?
      `).run(timestamp, publicText(syncError, '', 300), timestamp, id)
      this.database.prepare('DELETE FROM device_agent_grants WHERE device_id = ?').run(id)
    })
    return this.getDevice(id)!
  }

  markDeviceSyncResult(
    deviceId: string,
    operation: 'device.upsert' | 'device.revoke',
    success: boolean,
    error = '',
    now?: string,
  ): PairedDeviceRecord {
    const id = requireUuid(deviceId, 'Device ID')
    const device = this.getDevice(id)
    if (!device) throw new Error('Device not found.')
    const timestamp = iso(now)
    const nextState: DeviceState = !success
      ? device.state
      : operation === 'device.revoke'
        ? 'revoked'
        : device.state === 'pending_sync'
          ? 'active'
          : device.state
    this.database.prepare(`
      UPDATE paired_devices SET state = ?, sync_error = ?, updated_at = ? WHERE device_id = ?
    `).run(nextState, success ? '' : publicText(error, 'Cloud synchronization failed.', 300), timestamp, id)
    return this.getDevice(id)!
  }

  setGrant(input: {
    deviceId: string
    agentId: string
    canView: boolean
    canMessage: boolean
    canInterrupt: boolean
    canApprove: boolean
    expectedRevision?: number
    now?: string
  }): DeviceAgentGrant {
    this.assertOpen()
    const deviceId = requireUuid(input.deviceId, 'Device ID')
    const agentId = requireOpaqueId(input.agentId, 'Agent ID')
    const device = this.getDevice(deviceId)
    if (!device || device.state === 'revoked' || device.state === 'revoke_pending') {
      throw new Error('Only a paired, non-revoked device can receive permissions.')
    }
    const existing = this.getGrant(deviceId, agentId)
    if (input.expectedRevision !== undefined && (existing?.revision ?? 0) !== input.expectedRevision) {
      throw new Error('Device permission revision is stale.')
    }
    const revision = (existing?.revision ?? 0) + 1
    const now = iso(input.now)
    this.database.prepare(`
      INSERT INTO device_agent_grants (
        device_id, agent_id, can_view, can_message, can_interrupt, can_approve, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, agent_id) DO UPDATE SET
        can_view = excluded.can_view,
        can_message = excluded.can_message,
        can_interrupt = excluded.can_interrupt,
        can_approve = excluded.can_approve,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      agentId,
      input.canView ? 1 : 0,
      input.canMessage ? 1 : 0,
      input.canInterrupt ? 1 : 0,
      input.canApprove ? 1 : 0,
      revision,
      now,
    )
    return this.getGrant(deviceId, agentId)!
  }

  getGrant(deviceId: string, agentId: string): DeviceAgentGrant | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT device_id, agent_id, can_view, can_message, can_interrupt, can_approve, revision, updated_at
      FROM device_agent_grants WHERE device_id = ? AND agent_id = ?
    `).get(
      requireUuid(deviceId, 'Device ID'),
      requireOpaqueId(agentId, 'Agent ID'),
    ) as unknown as GrantRow | undefined
    return row ? grantFromRow(row) : null
  }

  listGrants(deviceId: string): DeviceAgentGrant[] {
    this.assertOpen()
    return (this.database.prepare(`
      SELECT device_id, agent_id, can_view, can_message, can_interrupt, can_approve, revision, updated_at
      FROM device_agent_grants WHERE device_id = ? ORDER BY agent_id
    `).all(requireUuid(deviceId, 'Device ID')) as unknown as GrantRow[]).map(grantFromRow)
  }

  claimNonce(deviceId: string, nonceHash: string, expiresAt: string, now?: string): boolean {
    this.assertOpen()
    const id = requireUuid(deviceId, 'Device ID')
    const hash = sha256Value(nonceHash, 'Nonce hash')
    const current = iso(now)
    const expiry = iso(expiresAt)
    if (Date.parse(expiry) <= Date.parse(current)) throw new Error('Nonce expiry must be in the future.')
    return this.transaction(() => {
      this.database.prepare('DELETE FROM seen_nonces WHERE expires_at <= ?').run(current)
      const existing = this.database.prepare(
        'SELECT 1 AS found FROM seen_nonces WHERE device_id = ? AND nonce_hash = ?',
      ).get(id, hash)
      if (existing) return false
      const deviceCount = this.database.prepare(
        'SELECT COUNT(*) AS count FROM seen_nonces WHERE device_id = ?',
      ).get(id) as unknown as { count: number | bigint }
      if (Number(deviceCount.count) >= MAX_NONCES_PER_DEVICE) {
        throw new Error('Replay-protection storage is at per-device capacity.')
      }
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM seen_nonces').get() as unknown as { count: number | bigint }
      if (Number(count.count) >= MAX_NONCES) throw new Error('Replay-protection storage is at capacity.')
      this.database.prepare(`
        INSERT INTO seen_nonces (device_id, nonce_hash, seen_at, expires_at) VALUES (?, ?, ?, ?)
      `).run(id, hash, current, expiry)
      return true
    })
  }

  countSeenNonces(deviceId?: string): number {
    this.assertOpen()
    const row = deviceId
      ? this.database.prepare('SELECT COUNT(*) AS count FROM seen_nonces WHERE device_id = ?')
          .get(requireUuid(deviceId, 'Device ID'))
      : this.database.prepare('SELECT COUNT(*) AS count FROM seen_nonces').get()
    return Number((row as unknown as { count: number | bigint }).count)
  }

  claimRequest(input: {
    deviceId: string
    requestId: string
    operationHash: string
    now?: string
    expiresAt?: string
    /**
     * False is used only after the signature nonce was already seen. It lets
     * an exact transport retry read an existing receipt without ever creating
     * a new claim from a replayed nonce.
     */
    createIfMissing?: boolean
  }): ClaimReceiptResult {
    this.assertOpen()
    const deviceId = requireUuid(input.deviceId, 'Device ID')
    const requestId = requireUuid(input.requestId, 'Request ID')
    const operationHash = sha256Value(input.operationHash, 'Operation hash')
    const now = iso(input.now)
    const expiresAt = iso(input.expiresAt ?? new Date(Date.parse(now) + 24 * 60 * 60 * 1_000))
    return this.transaction(() => {
      this.database.prepare('DELETE FROM remote_request_receipts WHERE expires_at <= ?').run(now)
      const existing = this.database.prepare(`
        SELECT operation_hash, state, response_status, response_json
        FROM remote_request_receipts WHERE device_id = ? AND request_id = ?
      `).get(deviceId, requestId) as unknown as ReceiptRow | undefined
      if (existing) {
        if (existing.operation_hash !== operationHash) return { outcome: 'conflict' }
        if (existing.state === 'completed' && existing.response_status !== null) {
          return {
            outcome: 'replay',
            response: { status: Number(existing.response_status), body: parsePublicJson(existing.response_json) },
          }
        }
        if (existing.state === 'in_progress') return { outcome: 'in_progress' }
        return { outcome: 'uncertain' }
      }
      if (input.createIfMissing === false) return { outcome: 'missing' }
      const deviceCount = this.database.prepare(
        'SELECT COUNT(*) AS count FROM remote_request_receipts WHERE device_id = ?',
      ).get(deviceId) as unknown as { count: number | bigint }
      if (Number(deviceCount.count) >= MAX_RECEIPTS_PER_DEVICE) {
        throw new Error('This device request receipt storage is at capacity.')
      }
      const totalCount = this.database.prepare(
        'SELECT COUNT(*) AS count FROM remote_request_receipts',
      ).get() as unknown as { count: number | bigint }
      if (Number(totalCount.count) >= MAX_RECEIPTS_TOTAL) {
        throw new Error('Remote request receipt storage is at capacity.')
      }
      this.database.prepare(`
        INSERT INTO remote_request_receipts (
          device_id, request_id, operation_hash, state, response_status,
          response_json, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, 'in_progress', NULL, 'null', ?, ?, ?)
      `).run(deviceId, requestId, operationHash, now, now, expiresAt)
      return { outcome: 'claimed' }
    })
  }

  completeRequest(
    deviceId: string,
    requestId: string,
    response: StoredRemoteResponse,
    now?: string,
  ): StoredRemoteResponse {
    const id = requireUuid(deviceId, 'Device ID')
    const request = requireUuid(requestId, 'Request ID')
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new Error('Remote response status is invalid.')
    }
    const body = publicJson(response.body)
    const result = this.database.prepare(`
      UPDATE remote_request_receipts
      SET state = 'completed', response_status = ?, response_json = ?, updated_at = ?
      WHERE device_id = ? AND request_id = ? AND state = 'in_progress'
    `).run(response.status, body, iso(now), id, request)
    if (Number(result.changes) !== 1) throw new Error('Remote request was not in progress and cannot be completed.')
    return { status: response.status, body: parsePublicJson(body) }
  }

  markRequestUncertain(deviceId: string, requestId: string, now?: string): void {
    this.database.prepare(`
      UPDATE remote_request_receipts SET state = 'uncertain', updated_at = ?
      WHERE device_id = ? AND request_id = ? AND state = 'in_progress'
    `).run(iso(now), requireUuid(deviceId, 'Device ID'), requireUuid(requestId, 'Request ID'))
  }

  enqueueOutbox(input: {
    operation: string
    entityType: string
    entityId: string
    payload: unknown
    now?: string
  }): OutboxRecord {
    this.assertOpen()
    const operation = requireOpaqueId(input.operation, 'Outbox operation')
    const entityType = requireOpaqueId(input.entityType, 'Outbox entity type')
    const entityId = requireOpaqueId(input.entityId, 'Outbox entity ID')
    const payload = publicJson(input.payload)
    const now = iso(input.now)
    return this.transaction(() => {
      // Latest state supersedes older unsent state for the same local entity.
      // In particular, a revoke must never sit behind an obsolete upsert.
      if (operation === 'workstation.upsert') {
        this.database.prepare(`
          DELETE FROM cloud_outbox
          WHERE entity_type = ? AND entity_id = ? AND operation = 'workstation.upsert'
        `).run(entityType, entityId)
      } else if (operation === 'device.revoke') {
        this.database.prepare(`
          DELETE FROM cloud_outbox
          WHERE entity_type = ? AND entity_id = ?
            AND operation IN ('device.upsert', 'device.revoke')
        `).run(entityType, entityId)
      } else if (operation === 'device.upsert') {
        this.database.prepare(`
          DELETE FROM cloud_outbox
          WHERE entity_type = ? AND entity_id = ? AND operation = 'device.upsert'
        `).run(entityType, entityId)
      } else if (operation === 'grant.upsert') {
        this.database.prepare(`
          DELETE FROM cloud_outbox
          WHERE entity_type = ? AND entity_id = ? AND operation = 'grant.upsert'
        `).run(entityType, entityId)
      }

      let count = Number((this.database.prepare(
        'SELECT COUNT(*) AS count FROM cloud_outbox',
      ).get() as unknown as { count: number | bigint }).count)
      const safetyDeny = isSafetyDenyOutbox(operation, payload)
      if (count >= MAX_OUTBOX && safetyDeny) {
        const rows = this.database.prepare(`
          SELECT outbox_id, operation, payload_json
          FROM cloud_outbox ORDER BY outbox_id
        `).all() as unknown as Array<{ outbox_id: number | bigint; operation: string; payload_json: string }>
        // Prefer dropping an enabling/upsert item. If the queue consists only
        // of denies, replace the oldest deny: every local deny remains durable
        // in the authoritative SQLite state even if its cloud retry is evicted.
        const candidate = rows.find((row) => !isSafetyDenyOutbox(row.operation, row.payload_json)) ?? rows[0]
        if (candidate) {
          this.database.prepare('DELETE FROM cloud_outbox WHERE outbox_id = ?').run(candidate.outbox_id)
          count -= 1
        }
      }
      if (count >= MAX_OUTBOX) throw new Error('Cloud synchronization queue is at capacity.')
      const result = this.database.prepare(`
        INSERT INTO cloud_outbox (
          operation, entity_type, entity_id, payload_json, attempts,
          next_attempt_at, last_error, created_at
        ) VALUES (?, ?, ?, ?, 0, ?, '', ?)
      `).run(operation, entityType, entityId, payload, now, now)
      return this.getOutbox(Number(result.lastInsertRowid))!
    })
  }

  listDueOutbox(now = new Date().toISOString(), limit = 50): OutboxRecord[] {
    this.assertOpen()
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    return (this.database.prepare(`
      SELECT outbox_id, operation, entity_type, entity_id, payload_json,
             attempts, next_attempt_at, last_error, created_at
      FROM cloud_outbox AS candidate
      WHERE candidate.next_attempt_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM cloud_outbox AS earlier
          WHERE earlier.entity_type = candidate.entity_type
            AND earlier.entity_id = candidate.entity_id
            AND earlier.outbox_id < candidate.outbox_id
        )
      ORDER BY candidate.outbox_id LIMIT ?
    `).all(iso(now), safeLimit) as unknown as OutboxRow[]).map((row) => this.outboxFromRow(row))
  }

  outboxCount(): number {
    this.assertOpen()
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM cloud_outbox').get() as unknown as { count: number | bigint }
    return Number(row.count)
  }

  hasPendingOutbox(entityType: string, entityId: string): boolean {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT 1 AS found FROM cloud_outbox
      WHERE entity_type = ? AND entity_id = ? LIMIT 1
    `).get(
      requireOpaqueId(entityType, 'Outbox entity type'),
      requireOpaqueId(entityId, 'Outbox entity ID'),
    )
    return Boolean(row)
  }

  hasPendingGrantOutbox(agentId: string): boolean {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT 1 AS found FROM cloud_outbox
      WHERE operation = 'grant.upsert'
        AND json_extract(payload_json, '$.agentId') = ?
      LIMIT 1
    `).get(requireOpaqueId(agentId, 'Agent ID'))
    return Boolean(row)
  }

  completeOutbox(id: number): void {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Outbox ID is invalid.')
    this.database.prepare('DELETE FROM cloud_outbox WHERE outbox_id = ?').run(id)
  }

  failOutbox(id: number, error: string, nextAttemptAt: string): OutboxRecord {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Outbox ID is invalid.')
    this.database.prepare(`
      UPDATE cloud_outbox
      SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
      WHERE outbox_id = ?
    `).run(iso(nextAttemptAt), publicText(error, 'Cloud synchronization failed.', 300), id)
    const record = this.getOutbox(id)
    if (!record) throw new Error('Outbox item not found.')
    return record
  }

  appendAudit(input: {
    deviceId?: string | null
    requestId?: string | null
    action: string
    targetId?: string
    outcome: string
    summary: string
    now?: string
  }): AuditRecord {
    this.assertOpen()
    const deviceId = input.deviceId ? requireUuid(input.deviceId, 'Device ID') : null
    const requestId = input.requestId ? requireUuid(input.requestId, 'Request ID') : null
    const action = requireOpaqueId(input.action, 'Audit action')
    const targetId = input.targetId ? requireOpaqueId(input.targetId, 'Audit target') : ''
    const outcome = requireOpaqueId(input.outcome, 'Audit outcome')
    const summary = publicText(input.summary, 'Remote action recorded.', 500)
    const createdAt = iso(input.now)
    const result = this.transaction(() => {
      this.database.prepare(`
        DELETE FROM remote_audit_events
        WHERE seq IN (
          SELECT seq FROM remote_audit_events ORDER BY seq ASC
          LIMIT MAX(0, (SELECT COUNT(*) FROM remote_audit_events) - ? + 1)
        )
      `).run(MAX_AUDIT_EVENTS)
      return this.database.prepare(`
        INSERT INTO remote_audit_events (
          device_id, request_id, action, target_id, outcome, public_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(deviceId, requestId, action, targetId, outcome, summary, createdAt)
    })
    return this.getAudit(Number(result.lastInsertRowid))!
  }

  listAudit(limit = 100): AuditRecord[] {
    this.assertOpen()
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)))
    return (this.database.prepare(`
      SELECT seq, device_id, request_id, action, target_id, outcome, public_summary, created_at
      FROM remote_audit_events ORDER BY seq DESC LIMIT ?
    `).all(safeLimit) as unknown as AuditRow[]).map((row) => this.auditFromRow(row))
  }

  storageSettings(): { foreignKeys: boolean; journalMode: string; synchronous: number } {
    const foreignKeys = this.database.prepare('PRAGMA foreign_keys').get() as unknown as { foreign_keys: number }
    const journalMode = this.database.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string }
    const synchronous = this.database.prepare('PRAGMA synchronous').get() as unknown as { synchronous: number }
    return {
      foreignKeys: foreignKeys.foreign_keys === 1,
      journalMode: journalMode.journal_mode,
      synchronous: synchronous.synchronous,
    }
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS remote_schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workstation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        workstation_id TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        remote_enabled INTEGER NOT NULL CHECK (remote_enabled IN (0, 1)),
        auth_epoch INTEGER NOT NULL CHECK (auth_epoch >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS paired_devices (
        device_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        public_jwk_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        display_name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending_sync', 'active', 'revoke_pending', 'revoked')),
        paired_at TEXT NOT NULL,
        revoked_at TEXT,
        sync_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        UNIQUE(owner_user_id, fingerprint)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS device_agent_grants (
        device_id TEXT NOT NULL REFERENCES paired_devices(device_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        can_view INTEGER NOT NULL CHECK (can_view IN (0, 1)),
        can_message INTEGER NOT NULL CHECK (can_message IN (0, 1)),
        can_interrupt INTEGER NOT NULL CHECK (can_interrupt IN (0, 1)),
        can_approve INTEGER NOT NULL CHECK (can_approve IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(device_id, agent_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS seen_nonces (
        device_id TEXT NOT NULL REFERENCES paired_devices(device_id) ON DELETE CASCADE,
        nonce_hash TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(device_id, nonce_hash)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS remote_request_receipts (
        device_id TEXT NOT NULL REFERENCES paired_devices(device_id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed', 'uncertain')),
        response_status INTEGER,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(device_id, request_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cloud_outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS remote_audit_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        request_id TEXT,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        public_summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS seen_nonces_expiry_idx ON seen_nonces(expires_at);
      CREATE INDEX IF NOT EXISTS receipts_expiry_idx ON remote_request_receipts(expires_at);
      CREATE INDEX IF NOT EXISTS outbox_due_idx ON cloud_outbox(next_attempt_at, outbox_id);
      CREATE INDEX IF NOT EXISTS audit_created_idx ON remote_audit_events(created_at, seq);
    `)
    const existing = this.database.prepare(
      "SELECT value FROM remote_schema_meta WHERE key = 'schema_version'",
    ).get() as unknown as { value: string } | undefined
    if (existing && existing.value !== String(SCHEMA_VERSION)) {
      throw new Error(`Unsupported remote-control schema version: ${existing.value}`)
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO remote_schema_meta (key, value) VALUES ('schema_version', ?)
    `).run(String(SCHEMA_VERSION))
  }

  private getOutbox(id: number): OutboxRecord | null {
    const row = this.database.prepare(`
      SELECT outbox_id, operation, entity_type, entity_id, payload_json,
             attempts, next_attempt_at, last_error, created_at
      FROM cloud_outbox WHERE outbox_id = ?
    `).get(id) as unknown as OutboxRow | undefined
    return row ? this.outboxFromRow(row) : null
  }

  private outboxFromRow(row: OutboxRow): OutboxRecord {
    return {
      id: Number(row.outbox_id),
      operation: row.operation,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: parsePublicJson(row.payload_json),
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at,
    }
  }

  private getAudit(seq: number): AuditRecord | null {
    const row = this.database.prepare(`
      SELECT seq, device_id, request_id, action, target_id, outcome, public_summary, created_at
      FROM remote_audit_events WHERE seq = ?
    `).get(seq) as unknown as AuditRow | undefined
    return row ? this.auditFromRow(row) : null
  }

  private auditFromRow(row: AuditRow): AuditRecord {
    return {
      seq: Number(row.seq),
      deviceId: row.device_id,
      requestId: row.request_id,
      action: row.action,
      targetId: row.target_id,
      outcome: row.outcome,
      summary: row.public_summary,
      createdAt: row.created_at,
    }
  }

  private requireWorkstation(): WorkstationRecord {
    const workstation = this.getWorkstation()
    if (!workstation) throw new Error('Workstation identity has not been created.')
    return workstation
  }

  private transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth
    const savepoint = `remote_store_${depth}`
    this.database.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this.transactionDepth = depth + 1
    try {
      const value = operation()
      this.database.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return value
    } catch (error) {
      try {
        if (depth === 0) {
          this.database.exec('ROLLBACK')
        } else {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`)
        }
      } catch {
        // Preserve the original operation or commit error. A failed rollback
        // leaves this store unusable, and the caller will close the Core.
      }
      throw error
    } finally {
      this.transactionDepth = depth
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Remote-control store is closed.')
  }
}
