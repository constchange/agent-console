import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AccessTokenVerifier } from '../auth/supabase-auth-service'
import { requireRecord, requireString, requireUuid } from '../../shared/remote-validation'
import {
  canonicalRemoteRequest,
  extractBearerToken,
  p256PublicKeyFingerprint,
  validateP256PublicJwk,
  verifyDeviceRequest,
  type P256PublicJwk,
} from './device-signature'
import { RemoteSecurityError } from './authorization-service'
import { RemoteStore, type PairedDeviceRecord } from './remote-store'

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1_000
const MAX_PAIRING_ATTEMPTS = 5

interface PairingCandidate {
  deviceId: string
  ownerUserId: string
  deviceName: string
  publicJwk: P256PublicJwk
  fingerprint: string
  sas: string
}

interface PendingPairing {
  id: string
  workstationId: string
  secret: Buffer
  expiresAtMs: number
  attempts: number
  seenNonces: Set<string>
  candidate: PairingCandidate | null
  expiryTimer: NodeJS.Timeout
}

export interface PairingQrPayload {
  version: 1
  pairingId: string
  workstationId: string
  secret: string
  gatewayBaseUrl: string
  expiresAt: string
  uri: string
}

export interface PendingPairingView {
  pairingId: string
  expiresAt: string
  claimed: boolean
  deviceId: string | null
  deviceName: string | null
  fingerprint: string | null
  sas: string | null
}

export interface PairingClaimResult {
  pairingId: string
  status: 'waiting_for_desktop_confirmation'
  expiresAt: string
  sas: string
  fingerprint: string
}

type PairingListener = () => void

function parsePairingBody(body: Buffer): {
  pairingId: string
  secret: string
  deviceName: string
  publicJwk: P256PublicJwk
} {
  if (body.length < 2 || body.length > 16 * 1024) throw new RemoteSecurityError(400, 'PAIRING_BODY_INVALID', 'Pairing request is invalid.')
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new RemoteSecurityError(400, 'PAIRING_BODY_INVALID', 'Pairing request is invalid.')
  }
  const record = requireRecord(parsed, 'Pairing request')
  const expected = ['deviceName', 'pairingId', 'publicJwk', 'secret'].sort()
  const keys = Object.keys(record).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new RemoteSecurityError(400, 'PAIRING_BODY_INVALID', 'Pairing request is invalid.')
  }
  return {
    pairingId: requireUuid(record.pairingId, 'Pairing ID'),
    secret: requireString(record.secret, 'Pairing secret', { min: 43, max: 43, pattern: /^[A-Za-z0-9_-]{43}$/ }),
    deviceName: requireString(record.deviceName, 'Device name', { max: 100 }),
    publicJwk: validateP256PublicJwk(record.publicJwk),
  }
}

function safeDeviceName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) throw new Error('Device name is required.')
  return cleaned.slice(0, 100)
}

function computeSas(secret: Buffer, transcript: string): string {
  const digest = createHmac('sha256', secret).update(transcript, 'utf8').digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

function validateGatewayBaseUrl(value: string): string {
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Pairing Gateway URL must use HTTPS.')
  }
  if (url.username || url.password || url.hash || url.search) throw new Error('Pairing Gateway URL is invalid.')
  return url.toString().replace(/\/$/, '')
}

export class PairingService {
  private readonly pairings = new Map<string, PendingPairing>()
  private readonly listeners = new Set<PairingListener>()

  constructor(
    private readonly store: RemoteStore,
    private readonly tokenVerifier: AccessTokenVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: PairingListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  createPairing(gatewayBaseUrl: string, ttlMs = DEFAULT_PAIRING_TTL_MS): PairingQrPayload {
    this.sweep()
    const workstation = this.store.getWorkstation()
    const authState = this.tokenVerifier.getPublicState()
    if (!workstation
      || !workstation.remoteEnabled
      || authState.phase !== 'signed_in'
      || !authState.remoteAllowed
      || authState.userId !== workstation.ownerUserId) {
      throw new Error('Sign in as the workstation owner before creating a pairing code.')
    }
    const safeTtl = Math.max(60_000, Math.min(DEFAULT_PAIRING_TTL_MS, Math.trunc(ttlMs)))
    const id = randomUUID()
    const secret = randomBytes(32)
    const expiresAtMs = this.now() + safeTtl
    const baseUrl = validateGatewayBaseUrl(gatewayBaseUrl)
    const expiryTimer = setTimeout(() => this.cancel(id), safeTtl)
    expiryTimer.unref()
    this.pairings.set(id, {
      id,
      workstationId: workstation.id,
      secret,
      expiresAtMs,
      attempts: 0,
      seenNonces: new Set(),
      candidate: null,
      expiryTimer,
    })
    this.emitChange()
    const secretText = secret.toString('base64url')
    const query = new URLSearchParams({
      v: '1',
      w: workstation.id,
      p: id,
      s: secretText,
      g: baseUrl,
    })
    return {
      version: 1,
      pairingId: id,
      workstationId: workstation.id,
      secret: secretText,
      gatewayBaseUrl: baseUrl,
      expiresAt: new Date(expiresAtMs).toISOString(),
      uri: `agent-console://pair?${query.toString()}`,
    }
  }

  async claim(envelopeInput: unknown): Promise<PairingClaimResult> {
    this.sweep()
    let preliminarilyVerified
    try {
      const record = envelopeInput as { headers?: { deviceId?: unknown; authorization?: unknown }; target?: unknown }
      if (typeof record?.headers?.authorization !== 'string') throw new Error('Missing authorization.')
      // The body contains the candidate public key, so parse its hash-bound
      // bytes before using that key to verify the signature.
      const unsigned = canonicalRemoteRequest(envelopeInput)
      const body = parsePairingBody(unsigned.body)
      if (unsigned.envelope.target !== `/v1/pairings/${body.pairingId}/claim`) throw new Error('Pairing target mismatch.')
      const pairing = this.requirePairing(body.pairingId)
      pairing.attempts += 1
      if (pairing.attempts > MAX_PAIRING_ATTEMPTS) {
        this.cancel(pairing.id)
        throw new Error('Pairing attempts exceeded.')
      }
      const suppliedSecret = Buffer.from(body.secret, 'base64url')
      if (suppliedSecret.length !== pairing.secret.length || !timingSafeEqual(suppliedSecret, pairing.secret)) {
        throw new Error('Pairing secret mismatch.')
      }
      preliminarilyVerified = {
        pairing,
        body,
        verified: verifyDeviceRequest(envelopeInput, body.publicJwk, { now: this.now() }),
        token: extractBearerToken(record.headers.authorization),
      }
    } catch (error) {
      if (error instanceof RemoteSecurityError) throw error
      throw new RemoteSecurityError(403, 'PAIRING_DENIED', 'Pairing request is not authorized.')
    }

    const { pairing, body, verified, token } = preliminarilyVerified
    if (pairing.seenNonces.has(verified.nonceHash)) {
      throw new RemoteSecurityError(409, 'PAIRING_REPLAYED', 'Pairing request was already received.')
    }
    pairing.seenNonces.add(verified.nonceHash)
    const workstation = this.store.getWorkstation()
    const authState = this.tokenVerifier.getPublicState()
    if (!workstation
      || !workstation.remoteEnabled
      || pairing.workstationId !== workstation.id
      || verified.envelope.headers.workstationId !== workstation.id
      || authState.phase !== 'signed_in'
      || !authState.remoteAllowed
      || authState.userId !== workstation.ownerUserId) {
      throw new RemoteSecurityError(403, 'PAIRING_DENIED', 'Pairing request is not authorized.')
    }
    const claims = await this.tokenVerifier.verifyAccessToken(token).catch(() => null)
    if (!claims || claims.userId !== workstation.ownerUserId) {
      throw new RemoteSecurityError(403, 'PAIRING_DENIED', 'Pairing request is not authorized.')
    }
    const fingerprint = p256PublicKeyFingerprint(body.publicJwk)
    const transcript = [
      'AC1-PAIR',
      workstation.id,
      pairing.id,
      verified.envelope.headers.deviceId,
      claims.userId,
      fingerprint,
    ].join('\n')
    const candidate: PairingCandidate = {
      deviceId: verified.envelope.headers.deviceId,
      ownerUserId: claims.userId,
      deviceName: safeDeviceName(body.deviceName),
      publicJwk: body.publicJwk,
      fingerprint,
      sas: computeSas(pairing.secret, transcript),
    }
    if (pairing.candidate) {
      const same = pairing.candidate.deviceId === candidate.deviceId
        && pairing.candidate.ownerUserId === candidate.ownerUserId
        && pairing.candidate.fingerprint === candidate.fingerprint
      if (!same) throw new RemoteSecurityError(409, 'PAIRING_ALREADY_CLAIMED', 'Pairing code was already claimed.')
    } else {
      pairing.candidate = candidate
    }
    this.emitChange()
    return {
      pairingId: pairing.id,
      status: 'waiting_for_desktop_confirmation',
      expiresAt: new Date(pairing.expiresAtMs).toISOString(),
      sas: pairing.candidate.sas,
      fingerprint: pairing.candidate.fingerprint,
    }
  }

  listPending(): PendingPairingView[] {
    this.sweep()
    return [...this.pairings.values()].map((pairing) => ({
      pairingId: pairing.id,
      expiresAt: new Date(pairing.expiresAtMs).toISOString(),
      claimed: Boolean(pairing.candidate),
      deviceId: pairing.candidate?.deviceId ?? null,
      deviceName: pairing.candidate?.deviceName ?? null,
      fingerprint: pairing.candidate?.fingerprint ?? null,
      sas: pairing.candidate?.sas ?? null,
    }))
  }

  confirm(pairingId: string, displayedSas: string): PairedDeviceRecord {
    this.sweep()
    const pairing = this.requirePairing(requireUuid(pairingId, 'Pairing ID'))
    const candidate = pairing.candidate
    if (!candidate || !/^\d{6}$/.test(displayedSas) || displayedSas !== candidate.sas) {
      throw new Error('Pairing confirmation code does not match the claimed device.')
    }
    const workstation = this.store.getWorkstation()
    const authState = this.tokenVerifier.getPublicState()
    if (!workstation
      || !workstation.remoteEnabled
      || workstation.id !== pairing.workstationId
      || workstation.ownerUserId !== candidate.ownerUserId
      || authState.phase !== 'signed_in'
      || !authState.remoteAllowed
      || authState.userId !== workstation.ownerUserId) {
      this.cancel(pairing.id)
      throw new Error('Pairing is no longer authorized.')
    }
    const device = this.store.atomic(() => {
      const activated = this.store.activateDevice({
        id: candidate.deviceId,
        ownerUserId: candidate.ownerUserId,
        publicJwk: candidate.publicJwk,
        fingerprint: candidate.fingerprint,
        name: candidate.deviceName,
        state: 'pending_sync',
      })
      this.store.enqueueOutbox({
        operation: 'device.upsert',
        entityType: 'device',
        entityId: activated.id,
        payload: {
          deviceId: activated.id,
          workstationId: pairing.workstationId,
          ownerUserId: activated.ownerUserId,
          displayName: activated.name,
          publicJwk: activated.publicJwk,
          fingerprint: activated.fingerprint,
          state: activated.state,
          pairedAt: activated.pairedAt,
        },
      })
      this.store.appendAudit({
        deviceId: activated.id,
        action: 'device.paired',
        targetId: activated.id,
        outcome: 'confirmed',
        summary: 'A mobile device was paired after local confirmation.',
      })
      return activated
    })
    this.cancel(pairing.id)
    return device
  }

  cancel(pairingId: string): boolean {
    const pairing = this.pairings.get(pairingId)
    if (!pairing) return false
    pairing.secret.fill(0)
    clearTimeout(pairing.expiryTimer)
    this.pairings.delete(pairingId)
    this.emitChange()
    return true
  }

  close(): void {
    for (const pairing of this.pairings.values()) {
      pairing.secret.fill(0)
      clearTimeout(pairing.expiryTimer)
    }
    const changed = this.pairings.size > 0
    this.pairings.clear()
    if (changed) this.emitChange()
  }

  private sweep(): void {
    const now = this.now()
    for (const pairing of this.pairings.values()) {
      if (pairing.expiresAtMs <= now) this.cancel(pairing.id)
    }
  }

  private requirePairing(id: string): PendingPairing {
    const pairing = this.pairings.get(id)
    if (!pairing || pairing.expiresAtMs <= this.now()) {
      if (pairing) this.cancel(id)
      throw new Error('Pairing code is missing or expired.')
    }
    return pairing
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A desktop observer must never interrupt pairing security state.
      }
    }
  }
}
