import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import type { JsonWebKey, KeyObject } from 'node:crypto'
import { canonicalRemoteRequest, validateP256PublicJwk, type P256PublicJwk } from '../core/remote/device-signature'
import type { RemoteDispatchEnvelope } from '../shared/remote-validation'

export interface P256Fixture {
  privateKey: KeyObject
  publicJwk: P256PublicJwk
}

export function p256Fixture(): P256Fixture {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, publicJwk: validateP256PublicJwk(publicKey.export({ format: 'jwk' }) as JsonWebKey) }
}

export function signedEnvelope(input: {
  privateKey: KeyObject
  method?: string
  target?: string
  body?: Buffer
  workstationId?: string
  deviceId?: string
  requestId?: string
  timestampSeconds?: number
  nonce?: string
  authorization?: string
}): RemoteDispatchEnvelope {
  const body = input.body ?? Buffer.alloc(0)
  const envelope: RemoteDispatchEnvelope = {
    method: input.method ?? 'GET',
    target: input.target ?? '/v1/dashboard',
    headers: {
      authorization: input.authorization ?? 'Bearer header.payload.signature',
      protocol: '1',
      workstationId: input.workstationId ?? '11111111-1111-4111-8111-111111111111',
      deviceId: input.deviceId ?? '22222222-2222-4222-8222-222222222222',
      requestId: input.requestId ?? randomUUID(),
      timestamp: String(input.timestampSeconds ?? Math.floor(Date.now() / 1_000)),
      nonce: input.nonce ?? randomBytes(16).toString('base64url'),
      bodySha256: createHash('sha256').update(body).digest('base64url'),
      signature: 'A'.repeat(86),
    },
    bodyBase64: body.toString('base64'),
  }
  const canonical = canonicalRemoteRequest(envelope).canonical
  envelope.headers.signature = sign(
    'sha256',
    Buffer.from(canonical, 'utf8'),
    { key: input.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url')
  return envelope
}
