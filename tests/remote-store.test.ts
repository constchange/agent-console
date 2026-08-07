import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { p256PublicKeyFingerprint } from '../core/remote/device-signature'
import { RemoteAuthorizationService } from '../core/remote/authorization-service'
import { RemoteStore } from '../core/remote/remote-store'
import { p256Fixture } from './remote-test-helpers'

const directories: string[] = []
const workstationId = '11111111-1111-4111-8111-111111111111'
const ownerId = '33333333-3333-4333-8333-333333333333'
const deviceId = '22222222-2222-4222-8222-222222222222'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('RemoteStore', () => {
  it('stores workstation, device, grants, replay data and public outbox only', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-console-remote-store-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'remote-control.sqlite')
    const key = p256Fixture()
    const store = new RemoteStore(databasePath)
    expect(store.storageSettings()).toEqual({ foreignKeys: true, journalMode: 'wal', synchronous: 2 })
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.setRemoteEnabled(true)
    store.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
    })
    store.setGrant({
      deviceId,
      agentId: 'agent-1',
      canView: true,
      canMessage: true,
      canInterrupt: false,
      canApprove: false,
    })
    expect(store.getGrant(deviceId, 'agent-1')).toMatchObject({ canView: true, canMessage: true, revision: 1 })

    const now = new Date()
    expect(store.claimNonce(deviceId, hash('nonce'), new Date(now.valueOf() + 60_000).toISOString(), now.toISOString())).toBe(true)
    expect(store.claimNonce(deviceId, hash('nonce'), new Date(now.valueOf() + 60_000).toISOString(), now.toISOString())).toBe(false)

    const requestId = '44444444-4444-4444-8444-444444444444'
    expect(store.claimRequest({ deviceId, requestId, operationHash: hash('operation') })).toEqual({ outcome: 'claimed' })
    store.completeRequest(deviceId, requestId, { status: 200, body: { ok: true } })
    expect(store.claimRequest({ deviceId, requestId, operationHash: hash('operation') })).toEqual({
      outcome: 'replay',
      response: { status: 200, body: { ok: true } },
    })
    expect(store.claimRequest({ deviceId, requestId, operationHash: hash('changed') })).toEqual({ outcome: 'conflict' })
    expect(() => store.enqueueOutbox({
      operation: 'device.upsert',
      entityType: 'device',
      entityId: deviceId,
      payload: { refresh_token: 'must-not-persist' },
    })).toThrow('Sensitive fields')
    store.close()
    expect((await readFile(databasePath)).toString('utf8')).not.toContain('must-not-persist')
  })

  it('changes an interrupted in-progress receipt to uncertain after restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-console-receipt-restart-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'remote-control.sqlite')
    const key = p256Fixture()
    const first = new RemoteStore(databasePath)
    first.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    first.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
    })
    const requestId = '55555555-5555-4555-8555-555555555555'
    first.claimRequest({ deviceId, requestId, operationHash: hash('operation') })
    first.close()
    const second = new RemoteStore(databasePath)
    expect(second.claimRequest({ deviceId, requestId, operationHash: hash('operation') })).toEqual({ outcome: 'uncertain' })
    second.close()
  })

  it('caps replay nonces per device so one paired key cannot exhaust the global store', () => {
    const key = p256Fixture()
    const store = new RemoteStore(':memory:')
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
    })
    const now = '2026-08-07T12:00:00.000Z'
    const expiresAt = '2026-08-07T12:10:00.000Z'
    for (let index = 0; index < 1_024; index += 1) {
      expect(store.claimNonce(deviceId, hash(`nonce-${index}`), expiresAt, now)).toBe(true)
    }
    expect(store.countSeenNonces(deviceId)).toBe(1_024)
    expect(() => store.claimNonce(deviceId, hash('nonce-over-limit'), expiresAt, now))
      .toThrow('per-device capacity')
    store.close()
  })

  it('rolls back nested mutations and outbox rows as one atomic unit', () => {
    const key = p256Fixture()
    const store = new RemoteStore(':memory:')
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
    })

    expect(() => store.atomic(() => {
      const grant = store.setGrant({
        deviceId,
        agentId: 'agent-atomic',
        canView: true,
        canMessage: false,
        canInterrupt: false,
        canApprove: false,
      })
      store.enqueueOutbox({
        operation: 'grant.upsert',
        entityType: 'grant',
        entityId: grant.agentId,
        payload: { workstationId, ...grant },
      })
      store.setGrant({
        deviceId: '99999999-9999-4999-8999-999999999999',
        agentId: 'agent-fails',
        canView: true,
        canMessage: false,
        canInterrupt: false,
        canApprove: false,
      })
    })).toThrow('paired')

    expect(store.getGrant(deviceId, 'agent-atomic')).toBeNull()
    expect(store.outboxCount()).toBe(0)
    store.close()
  })

  it('coalesces superseded entity state instead of letting stale cloud mutations overtake', () => {
    const store = new RemoteStore(':memory:')
    const now = '2026-08-07T00:00:00.000Z'
    const first = store.enqueueOutbox({
      operation: 'device.upsert',
      entityType: 'device',
      entityId: deviceId,
      payload: { state: 'pending_sync' },
      now,
    })
    store.failOutbox(first.id, 'Cloud synchronization failed.', '2026-08-07T00:10:00.000Z')
    store.enqueueOutbox({
      operation: 'device.revoke',
      entityType: 'device',
      entityId: deviceId,
      payload: { state: 'revoke_pending' },
      now,
    })
    store.enqueueOutbox({
      operation: 'workstation.upsert',
      entityType: 'workstation',
      entityId: workstationId,
      payload: { remoteEnabled: false },
      now,
    })

    expect(store.listDueOutbox(now).map((item) => item.operation)).toEqual(['device.revoke', 'workstation.upsert'])
    expect(store.listDueOutbox('2026-08-07T00:11:00.000Z').map((item) => item.operation))
      .toEqual(['device.revoke', 'workstation.upsert'])
    store.close()
  })

  it('keeps a revoked device revoked across duplicate sync success and stale upserts', () => {
    const key = p256Fixture()
    const store = new RemoteStore(':memory:')
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
    })
    store.revokeDevice(deviceId)

    expect(store.markDeviceSyncResult(deviceId, 'device.revoke', true).state).toBe('revoked')
    expect(store.markDeviceSyncResult(deviceId, 'device.revoke', true).state).toBe('revoked')
    expect(store.markDeviceSyncResult(deviceId, 'device.upsert', true).state).toBe('revoked')
    expect(() => store.setGrant({
      deviceId,
      agentId: 'agent-revoked',
      canView: true,
      canMessage: true,
      canInterrupt: true,
      canApprove: true,
    })).toThrow('non-revoked')
    store.close()
  })

  it('keeps local disable and revoke writable when the cloud outbox is full', () => {
    const key = p256Fixture()
    const store = new RemoteStore(':memory:')
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.setRemoteEnabled(true)
    store.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
    })
    store.setGrant({
      deviceId,
      agentId: 'agent-critical',
      canView: true,
      canMessage: true,
      canInterrupt: true,
      canApprove: true,
    })
    for (let index = 0; index < 4_096; index += 1) {
      store.enqueueOutbox({
        operation: 'grant.upsert',
        entityType: 'grant',
        entityId: `agent-${index}`,
        payload: { workstationId, agentId: `agent-${index}`, canView: true },
      })
    }
    expect(store.outboxCount()).toBe(4_096)

    store.atomic(() => {
      const restricted = store.setGrant({
        deviceId,
        agentId: 'agent-critical',
        canView: true,
        canMessage: false,
        canInterrupt: false,
        canApprove: false,
      })
      store.enqueueOutbox({
        operation: 'grant.upsert',
        entityType: 'grant',
        entityId: `${deviceId}:agent-critical`,
        payload: { workstationId, ...restricted },
      })
    })
    const authorization = new RemoteAuthorizationService(store, {} as never)
    expect(() => authorization.requirePermission(
      { device: store.getDevice(deviceId) } as never,
      'message',
      'agent-critical',
    )).toThrow('not authorized')
    expect(store.outboxCount()).toBe(4_096)

    store.atomic(() => {
      const disabled = store.setRemoteEnabled(false)
      store.enqueueOutbox({
        operation: 'workstation.upsert',
        entityType: 'workstation',
        entityId: disabled.id,
        payload: { workstationId: disabled.id, remoteEnabled: false },
      })
    })
    expect(store.getWorkstation()?.remoteEnabled).toBe(false)
    expect(store.hasPendingOutbox('workstation', workstationId)).toBe(true)
    expect(store.outboxCount()).toBe(4_096)

    store.atomic(() => {
      const revoked = store.revokeDevice(deviceId)
      store.enqueueOutbox({
        operation: 'device.revoke',
        entityType: 'device',
        entityId: revoked.id,
        payload: { workstationId, deviceId: revoked.id, state: revoked.state },
      })
    })
    expect(store.getDevice(deviceId)?.state).toBe('revoke_pending')
    expect(store.hasPendingOutbox('device', deviceId)).toBe(true)
    expect(store.outboxCount()).toBe(4_096)
    store.close()
  })
})
