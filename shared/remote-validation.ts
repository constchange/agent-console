export const REMOTE_PROTOCOL_VERSION = 1
export const REMOTE_MAX_BODY_BYTES = 64 * 1024
export const REMOTE_MAX_MESSAGE_BYTES = 8 * 1024
export const REMOTE_MAX_HEADER_BYTES = 16 * 1024
export const REMOTE_REQUEST_CLOCK_SKEW_SECONDS = 5 * 60

export type RemotePermission = 'view' | 'message' | 'interrupt' | 'approve'

export interface RemotePublicAuthState {
  phase: 'unconfigured' | 'signed_out' | 'signed_in' | 'degraded' | 'locked' | 'recovery'
  userId: string | null
  email: string | null
  emailConfirmed: boolean
  sessionExpiresAt: string | null
  remoteAllowed: boolean
  message: string
}

export interface RemoteSignedHeaders {
  authorization: string
  protocol: string
  workstationId: string
  deviceId: string
  requestId: string
  timestamp: string
  nonce: string
  bodySha256: string
  signature: string
}

export interface RemoteDispatchEnvelope {
  method: string
  target: string
  headers: RemoteSignedHeaders
  bodyBase64: string
}

export interface RemoteDispatchResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}

export interface GatewayEvent {
  seq: number
  type: string
  payload: unknown
  createdAt: string
}

export interface RemoteEventStreamOpenResult {
  streamId: string
  currentSeq: number
  events: GatewayEvent[]
  expiresAt: string
}

export interface RemoteEventStreamPollResult {
  closed: boolean
  currentSeq: number
  events: GatewayEvent[]
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,160}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  return value
}

export function requireString(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const min = options.min ?? 1
  const max = options.max ?? 1_000
  if (value.length < min || value.length > max || options.pattern && !options.pattern.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function requireUuid(value: unknown, label: string): string {
  return requireString(value, label, { max: 36, pattern: UUID_PATTERN }).toLowerCase()
}

export function requireOpaqueId(value: unknown, label: string): string {
  return requireString(value, label, { max: 160, pattern: OPAQUE_ID_PATTERN })
}

export function requireBase64Url(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; exact?: number } = {},
): string {
  const exact = options.exact
  return requireString(value, label, {
    min: exact ?? options.min ?? 1,
    max: exact ?? options.max ?? 1_024,
    pattern: BASE64URL_PATTERN,
  })
}

export function requireHttpMethod(value: unknown): string {
  const method = requireString(value, 'method', { max: 10, pattern: /^[A-Z]+$/ })
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error('HTTP method is not allowed.')
  }
  return method
}

/**
 * The exact origin-form request target is signed. Fragments, absolute URLs,
 * control characters and backslashes are rejected so a proxy cannot create a
 * second interpretation of the same signed request.
 */
export function requireRequestTarget(value: unknown): string {
  const target = requireString(value, 'target', { max: 2_048 })
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#') || target.includes('\\')) {
    throw new Error('Request target is invalid.')
  }
  for (let index = 0; index < target.length; index += 1) {
    const code = target.charCodeAt(index)
    if (code <= 0x20 || code === 0x7f) throw new Error('Request target is invalid.')
  }
  return target
}

export function validateSignedHeaders(value: unknown): RemoteSignedHeaders {
  const headers = requireRecord(value, 'headers')
  const keys = Object.keys(headers).sort()
  const expected = [
    'authorization',
    'bodySha256',
    'deviceId',
    'nonce',
    'protocol',
    'requestId',
    'signature',
    'timestamp',
    'workstationId',
  ].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Signed headers contain unknown or missing fields.')
  }
  const authorization = requireString(headers.authorization, 'authorization', { max: 8_192 })
  if (!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)) throw new Error('Authorization is invalid.')
  const timestamp = requireString(headers.timestamp, 'timestamp', { max: 16, pattern: /^\d{10}$/ })
  return {
    authorization,
    protocol: requireString(headers.protocol, 'protocol', { max: 3, pattern: /^1$/ }),
    workstationId: requireUuid(headers.workstationId, 'workstationId'),
    deviceId: requireUuid(headers.deviceId, 'deviceId'),
    requestId: requireUuid(headers.requestId, 'requestId'),
    timestamp,
    nonce: requireBase64Url(headers.nonce, 'nonce', { min: 22, max: 43 }),
    bodySha256: requireString(headers.bodySha256, 'bodySha256', { max: 43, pattern: SHA256_PATTERN }),
    signature: requireString(headers.signature, 'signature', { max: 86, pattern: SIGNATURE_PATTERN }),
  }
}

export function validateRemoteDispatchEnvelope(value: unknown): RemoteDispatchEnvelope {
  const envelope = requireRecord(value, 'envelope')
  const keys = Object.keys(envelope).sort()
  const expected = ['bodyBase64', 'headers', 'method', 'target'].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Remote envelope contains unknown or missing fields.')
  }
  const bodyBase64 = typeof envelope.bodyBase64 === 'string' ? envelope.bodyBase64 : ''
  if (bodyBase64 && (!/^[A-Za-z0-9+/]*={0,2}$/.test(bodyBase64) || bodyBase64.length > Math.ceil(REMOTE_MAX_BODY_BYTES / 3) * 4)) {
    throw new Error('Remote request body is invalid or too large.')
  }
  return {
    method: requireHttpMethod(envelope.method),
    target: requireRequestTarget(envelope.target),
    headers: validateSignedHeaders(envelope.headers),
    bodyBase64,
  }
}

export function validateGatewayEvent(value: unknown): GatewayEvent {
  const event = requireRecord(value, 'event')
  if (!Number.isSafeInteger(event.seq) || Number(event.seq) < 0) throw new Error('Event sequence is invalid.')
  const createdAt = requireString(event.createdAt, 'createdAt', { max: 40 })
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Event timestamp is invalid.')
  return {
    seq: Number(event.seq),
    type: requireString(event.type, 'event type', { max: 100, pattern: /^[a-z0-9._-]+$/ }),
    payload: event.payload,
    createdAt: new Date(createdAt).toISOString(),
  }
}

export function isRemotePermission(value: unknown): value is RemotePermission {
  return value === 'view' || value === 'message' || value === 'interrupt' || value === 'approve'
}
