import { describe, expect, it } from 'vitest'
import {
  p256PublicKeyFingerprint,
  validateP256PublicJwk,
  verifyDeviceRequest,
} from '../core/remote/device-signature'
import { p256Fixture, signedEnvelope } from './remote-test-helpers'

describe('P-256 device signatures', () => {
  it('verifies the exact method, target, body, ids, timestamp and nonce', () => {
    const key = p256Fixture()
    const now = Date.now()
    const envelope = signedEnvelope({
      privateKey: key.privateKey,
      method: 'POST',
      target: '/v1/tasks/task-1/messages',
      body: Buffer.from('{"message":"hello"}'),
      timestampSeconds: Math.floor(now / 1_000),
    })
    const verified = verifyDeviceRequest(envelope, key.publicJwk, { now })
    expect(verified.body.toString()).toBe('{"message":"hello"}')
    expect(verified.publicKeyFingerprint).toBe(p256PublicKeyFingerprint(key.publicJwk))
    expect(verified.nonceHash).toHaveLength(43)
    expect(verified.operationHash).toHaveLength(43)

    expect(() => verifyDeviceRequest({ ...envelope, target: '/v1/tasks/task-2/messages' }, key.publicJwk, { now }))
      .toThrow('signature is invalid')
    expect(() => verifyDeviceRequest({
      ...envelope,
      headers: { ...envelope.headers, authorization: 'Bearer attacker.header.signature' },
    }, key.publicJwk, { now })).toThrow('signature is invalid')
    const changedBody = { ...envelope, bodyBase64: Buffer.from('{"message":"changed"}').toString('base64') }
    expect(() => verifyDeviceRequest(changedBody, key.publicJwk, { now })).toThrow('body hash')
  })

  it('rejects private fields, other curves, old requests and noncanonical signatures', () => {
    const key = p256Fixture()
    expect(() => validateP256PublicJwk({ ...key.publicJwk, d: 'A'.repeat(43) })).toThrow('private')
    expect(() => validateP256PublicJwk({ ...key.publicJwk, crv: 'P-384' })).toThrow('P-256')
    const old = signedEnvelope({ privateKey: key.privateKey, timestampSeconds: Math.floor(Date.now() / 1_000) - 301 })
    expect(() => verifyDeviceRequest(old, key.publicJwk)).toThrow('timestamp')
    expect(() => verifyDeviceRequest({
      ...old,
      headers: { ...old.headers, signature: 'A'.repeat(86) },
    }, key.publicJwk, { maxClockSkewSeconds: 1_000 })).toThrow('signature')
  })
})
