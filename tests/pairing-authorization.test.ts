import { describe, expect, it } from 'vitest'
import type { AccessTokenVerifier, VerifiedSupabaseClaims } from '../core/auth/supabase-auth-service'
import { RemoteAuthorizationService, RemoteSecurityError } from '../core/remote/authorization-service'
import { p256PublicKeyFingerprint } from '../core/remote/device-signature'
import { PairingService } from '../core/remote/pairing-service'
import { RemoteStore } from '../core/remote/remote-store'
import type { RemotePublicAuthState } from '../shared/remote-validation'
import { p256Fixture, signedEnvelope } from './remote-test-helpers'

const workstationId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const ownerId = '33333333-3333-4333-8333-333333333333'

class FakeVerifier implements AccessTokenVerifier {
  verifyCalls = 0
  state: RemotePublicAuthState = {
    phase: 'signed_in',
    userId: ownerId,
    email: 'owner@example.com',
    emailConfirmed: true,
    sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    remoteAllowed: true,
    message: 'signed in',
  }

  getPublicState(): RemotePublicAuthState {
    return { ...this.state }
  }

  async verifyAccessToken(): Promise<VerifiedSupabaseClaims> {
    this.verifyCalls += 1
    return {
      userId: ownerId,
      email: 'owner@example.com',
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      issuedAt: Math.floor(Date.now() / 1_000),
      sessionId: '66666666-6666-4666-8666-666666666666',
    }
  }
}

describe('pairing and remote authorization', () => {
  it('keeps the pairing secret in memory and activates only after matching SAS confirmation', async () => {
    const store = new RemoteStore(':memory:')
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.setRemoteEnabled(true)
    const verifier = new FakeVerifier()
    const pairing = new PairingService(store, verifier)
    const qr = pairing.createPairing('https://remote.example.test')
    const key = p256Fixture()
    const body = Buffer.from(JSON.stringify({
      pairingId: qr.pairingId,
      secret: qr.secret,
      deviceName: 'My phone',
      publicJwk: key.publicJwk,
    }))
    const envelope = signedEnvelope({
      privateKey: key.privateKey,
      method: 'POST',
      target: `/v1/pairings/${qr.pairingId}/claim`,
      body,
      workstationId,
      deviceId,
    })
    const claimed = await pairing.claim(envelope)
    expect(claimed.sas).toMatch(/^\d{6}$/)
    expect(store.getDevice(deviceId)).toBeNull()
    expect(() => pairing.confirm(qr.pairingId, '000000')).toThrow('does not match')
    pairing.confirm(qr.pairingId, claimed.sas)
    expect(store.getDevice(deviceId)).toMatchObject({ state: 'pending_sync', name: 'My phone' })
    expect(pairing.listPending()).toEqual([])
    expect(store.listDueOutbox(new Date(Date.now() + 1_000).toISOString())[0].payload).not.toHaveProperty('secret')
    pairing.close()
    store.close()
  })

  it('invalidates an already claimed pairing when recovery disables authorization', async () => {
    const store = new RemoteStore(':memory:')
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.setRemoteEnabled(true)
    const verifier = new FakeVerifier()
    const pairing = new PairingService(store, verifier)
    const qr = pairing.createPairing('https://remote.example.test')
    const key = p256Fixture()
    const body = Buffer.from(JSON.stringify({
      pairingId: qr.pairingId,
      secret: qr.secret,
      deviceName: 'Recovery-window phone',
      publicJwk: key.publicJwk,
    }))
    const claimed = await pairing.claim(signedEnvelope({
      privateKey: key.privateKey,
      method: 'POST',
      target: `/v1/pairings/${qr.pairingId}/claim`,
      body,
      workstationId,
      deviceId,
    }))

    verifier.state = { ...verifier.state, phase: 'recovery', remoteAllowed: false }
    store.setRemoteEnabled(false)
    expect(() => pairing.confirm(qr.pairingId, claimed.sas)).toThrow('no longer authorized')
    expect(store.getDevice(deviceId)).toBeNull()
    expect(pairing.listPending()).toEqual([])
    pairing.close()
    store.close()
  })

  it('requires owner JWT, active device key, a fresh nonce and per-Agent permission', async () => {
    const store = new RemoteStore(':memory:')
    const verifier = new FakeVerifier()
    const key = p256Fixture()
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
      canMessage: false,
      canInterrupt: false,
      canApprove: false,
    })
    const service = new RemoteAuthorizationService(store, verifier)
    const forged = signedEnvelope({ privateKey: p256Fixture().privateKey, workstationId, deviceId })
    await expect(service.authorize({ envelope: forged })).rejects.toBeInstanceOf(RemoteSecurityError)
    expect(verifier.verifyCalls).toBe(0)

    const envelope = signedEnvelope({ privateKey: key.privateKey, workstationId, deviceId })
    await expect(service.authorize({ envelope, permission: 'view', agentId: 'agent-1' })).resolves.toMatchObject({
      workstation: { id: workstationId },
      device: { id: deviceId },
    })
    await expect(service.authorize({ envelope, permission: 'view', agentId: 'agent-1' })).rejects.toMatchObject({
      code: 'REPLAY_DETECTED',
    })

    const denied = signedEnvelope({ privateKey: key.privateKey, workstationId, deviceId })
    await expect(service.authorize({ envelope: denied, permission: 'message', agentId: 'agent-1' }))
      .rejects.toBeInstanceOf(RemoteSecurityError)

    const active = await service.authorize({
      envelope: signedEnvelope({ privateKey: key.privateKey, workstationId, deviceId }),
      permission: 'view',
      agentId: 'agent-1',
    })
    store.setRemoteEnabled(false)
    expect(() => service.assertStillAuthorized(active)).toThrow('not authorized')
    store.close()
  })
})
