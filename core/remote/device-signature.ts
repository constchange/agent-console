import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto'
import {
  REMOTE_MAX_BODY_BYTES,
  REMOTE_REQUEST_CLOCK_SKEW_SECONDS,
  requireRecord,
  requireString,
  type RemoteDispatchEnvelope,
  validateRemoteDispatchEnvelope,
} from '../../shared/remote-validation'

export interface P256PublicJwk extends JsonWebKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  ext: true
  key_ops: ['verify']
}

export interface VerifiedDeviceRequest {
  envelope: RemoteDispatchEnvelope
  body: Buffer
  canonicalRequest: string
  nonceHash: string
  operationHash: string
  timestampSeconds: number
  publicKeyFingerprint: string
}

function base64UrlSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url')
}

function strictBase64UrlBytes(value: unknown, label: string, expectedBytes: number): string {
  const encoded = requireString(value, label, {
    min: Math.ceil(expectedBytes * 4 / 3) - 1,
    max: Math.ceil(expectedBytes * 4 / 3),
    pattern: /^[A-Za-z0-9_-]+$/,
  })
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.length !== expectedBytes || bytes.toString('base64url') !== encoded) {
    throw new Error(`${label} is not canonical base64url.`)
  }
  return encoded
}

export function validateP256PublicJwk(value: unknown): P256PublicJwk {
  const jwk = requireRecord(value, 'P-256 public JWK')
  const allowed = new Set(['kty', 'crv', 'x', 'y', 'ext', 'key_ops', 'alg'])
  if (Object.keys(jwk).some((key) => !allowed.has(key)) || 'd' in jwk) {
    throw new Error('P-256 public JWK contains unsupported or private fields.')
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('Only P-256 EC public keys are accepted.')
  if (jwk.alg !== undefined && jwk.alg !== 'ES256') throw new Error('P-256 public JWK algorithm must be ES256.')
  if (jwk.ext !== undefined && jwk.ext !== true) throw new Error('P-256 public JWK must be extractable as a public key.')
  if (jwk.key_ops !== undefined
    && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify')) {
    throw new Error('P-256 public JWK may only be used for verification.')
  }
  const normalized: P256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: strictBase64UrlBytes(jwk.x, 'P-256 x coordinate', 32),
    y: strictBase64UrlBytes(jwk.y, 'P-256 y coordinate', 32),
    ext: true,
    key_ops: ['verify'],
  }
  // Importing rejects points which are not on P-256 before the key is stored.
  createPublicKey({ key: normalized, format: 'jwk' })
  return normalized
}

export function p256PublicKeyFingerprint(value: unknown): string {
  const jwk = validateP256PublicJwk(value)
  return base64UrlSha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
}

export function importP256PublicKey(value: unknown): { jwk: P256PublicJwk; key: KeyObject; fingerprint: string } {
  const jwk = validateP256PublicJwk(value)
  return {
    jwk,
    key: createPublicKey({ key: jwk, format: 'jwk' }),
    fingerprint: p256PublicKeyFingerprint(jwk),
  }
}

function decodeCanonicalBody(bodyBase64: string): Buffer {
  if (!bodyBase64) return Buffer.alloc(0)
  const body = Buffer.from(bodyBase64, 'base64')
  if (body.length > REMOTE_MAX_BODY_BYTES || body.toString('base64') !== bodyBase64) {
    throw new Error('Remote request body is not canonical base64 or is too large.')
  }
  return body
}

export function canonicalRemoteRequest(envelopeInput: unknown): {
  envelope: RemoteDispatchEnvelope
  body: Buffer
  canonical: string
  operationHash: string
  nonceHash: string
  timestampSeconds: number
} {
  const envelope = validateRemoteDispatchEnvelope(envelopeInput)
  const body = decodeCanonicalBody(envelope.bodyBase64)
  const actualBodyHash = base64UrlSha256(body)
  if (actualBodyHash !== envelope.headers.bodySha256) throw new Error('Remote request body hash does not match.')
  const timestampSeconds = Number(envelope.headers.timestamp)
  const canonical = [
    'AC1',
    envelope.method,
    envelope.target,
    envelope.headers.workstationId,
    envelope.headers.deviceId,
    envelope.headers.requestId,
    envelope.headers.timestamp,
    envelope.headers.nonce,
    envelope.headers.bodySha256,
    // Bind the bearer credential without embedding it in logs or receipts.
    // A captured device signature cannot then be paired with an attacker-
    // chosen unknown-kid JWT to force provider network lookups.
    base64UrlSha256(envelope.headers.authorization),
  ].join('\n')
  const operationHash = base64UrlSha256([
    'AC1-OPERATION',
    envelope.method,
    envelope.target,
    envelope.headers.workstationId,
    envelope.headers.deviceId,
    envelope.headers.bodySha256,
  ].join('\n'))
  const nonceBytes = Buffer.from(envelope.headers.nonce, 'base64url')
  if (nonceBytes.length < 16 || nonceBytes.length > 32 || nonceBytes.toString('base64url') !== envelope.headers.nonce) {
    throw new Error('Remote request nonce is not canonical or has an unsafe length.')
  }
  return {
    envelope,
    body,
    canonical,
    operationHash,
    nonceHash: base64UrlSha256(nonceBytes),
    timestampSeconds,
  }
}

export function verifyDeviceRequest(
  envelopeInput: unknown,
  publicJwkInput: unknown,
  options: { now?: number; maxClockSkewSeconds?: number } = {},
): VerifiedDeviceRequest {
  const parsed = canonicalRemoteRequest(envelopeInput)
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1_000)
  const maxClockSkew = options.maxClockSkewSeconds ?? REMOTE_REQUEST_CLOCK_SKEW_SECONDS
  if (!Number.isSafeInteger(parsed.timestampSeconds)
    || Math.abs(nowSeconds - parsed.timestampSeconds) > maxClockSkew) {
    throw new Error('Remote request timestamp is outside the accepted window.')
  }
  const imported = importP256PublicKey(publicJwkInput)
  const signature = Buffer.from(parsed.envelope.headers.signature, 'base64url')
  if (signature.length !== 64 || signature.toString('base64url') !== parsed.envelope.headers.signature) {
    throw new Error('Device signature is not canonical ES256 P1363 data.')
  }
  const valid = verifySignature(
    'sha256',
    Buffer.from(parsed.canonical, 'utf8'),
    { key: imported.key, dsaEncoding: 'ieee-p1363' },
    signature,
  )
  if (!valid) throw new Error('Device signature is invalid.')
  return {
    envelope: parsed.envelope,
    body: parsed.body,
    canonicalRequest: parsed.canonical,
    nonceHash: parsed.nonceHash,
    operationHash: parsed.operationHash,
    timestampSeconds: parsed.timestampSeconds,
    publicKeyFingerprint: imported.fingerprint,
  }
}

export function extractBearerToken(authorization: string): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,8192})$/.exec(authorization)
  if (!match) throw new Error('Authorization bearer token is invalid.')
  return match[1]
}
