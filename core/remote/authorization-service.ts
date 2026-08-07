import type { AccessTokenVerifier, VerifiedSupabaseClaims } from '../auth/supabase-auth-service'
import type { RemotePermission } from '../../shared/remote-validation'
import { verifyDeviceRequest, extractBearerToken, type VerifiedDeviceRequest } from './device-signature'
import {
  RemoteStore,
  type DeviceAgentGrant,
  type PairedDeviceRecord,
  type WorkstationRecord,
} from './remote-store'

export class RemoteSecurityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RemoteSecurityError'
  }
}

export interface AuthorizedRemoteRequest {
  workstation: WorkstationRecord
  device: PairedDeviceRecord
  claims: VerifiedSupabaseClaims
  verified: VerifiedDeviceRequest
  grant: DeviceAgentGrant | null
  /** False only for a signed transport retry of an idempotent write. */
  nonceFresh: boolean
}

export interface AuthorizeRemoteRequestInput {
  envelope: unknown
  permission?: RemotePermission
  agentId?: string
  now?: number
  /**
   * Allows a repeated signature nonce to proceed only as far as the durable
   * request-receipt lookup. The idempotency layer will refuse to create a new
   * claim when `nonceFresh` is false.
   */
  allowIdempotentReplay?: boolean
  /**
   * Runs after the active device's local P-256 signature is verified, but
   * before any provider network lookup or durable nonce write. The Core
   * router uses this boundary for authenticated capacity and rate limits.
   */
  beforeTokenVerification?: (request: {
    workstation: WorkstationRecord
    device: PairedDeviceRecord
    verified: VerifiedDeviceRequest
  }) => void
}

function denied(code = 'REMOTE_AUTHORIZATION_DENIED'): never {
  throw new RemoteSecurityError(403, code, 'Remote request is not authorized.')
}

export class RemoteAuthorizationService {
  constructor(
    private readonly store: RemoteStore,
    private readonly tokenVerifier: AccessTokenVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(input: AuthorizeRemoteRequestInput): Promise<AuthorizedRemoteRequest> {
    const authState = this.tokenVerifier.getPublicState()
    const workstation = this.store.getWorkstation()
    if (!workstation || !workstation.remoteEnabled || !authState.remoteAllowed || authState.phase !== 'signed_in') {
      denied('REMOTE_DISABLED')
    }

    let verified: VerifiedDeviceRequest
    let device: PairedDeviceRecord
    let claims: VerifiedSupabaseClaims
    try {
      const candidate = input.envelope as { headers?: { workstationId?: unknown; deviceId?: unknown; authorization?: unknown } }
      if (candidate?.headers?.workstationId !== workstation.id || typeof candidate?.headers?.deviceId !== 'string') denied()
      device = this.store.getDevice(candidate.headers.deviceId)!
      if (!device || device.state !== 'active' || device.ownerUserId !== workstation.ownerUserId) denied()
      if (authState.userId !== workstation.ownerUserId) denied('WORKSTATION_OWNER_MISMATCH')
      if (typeof candidate.headers.authorization !== 'string') denied()
      const token = extractBearerToken(candidate.headers.authorization)
      verified = verifyDeviceRequest(input.envelope, device.publicJwk, { now: input.now ?? this.now() })
      if (verified.publicKeyFingerprint !== device.fingerprint) denied()
      input.beforeTokenVerification?.({ workstation, device, verified })
      claims = await this.tokenVerifier.verifyAccessToken(token)
      if (claims.userId !== workstation.ownerUserId || claims.userId !== device.ownerUserId) denied()
    } catch (error) {
      if (error instanceof RemoteSecurityError) throw error
      denied()
    }

    const nonceExpiry = new Date((input.now ?? this.now()) + 10 * 60 * 1_000).toISOString()
    let fresh: boolean
    try {
      fresh = this.store.claimNonce(device.id, verified.nonceHash, nonceExpiry, new Date(input.now ?? this.now()).toISOString())
    } catch {
      throw new RemoteSecurityError(503, 'REPLAY_PROTECTION_UNAVAILABLE', 'Remote request cannot be accepted safely right now.')
    }
    if (!fresh && !input.allowIdempotentReplay) {
      throw new RemoteSecurityError(409, 'REPLAY_DETECTED', 'Remote request was already received.')
    }

    let grant: DeviceAgentGrant | null = null
    if (input.permission) {
      if (!input.agentId) denied('AGENT_PERMISSION_REQUIRED')
      grant = this.requirePermission({ workstation, device, claims, verified, grant: null, nonceFresh: fresh }, input.permission, input.agentId)
    }

    return { workstation, device, claims, verified, grant, nonceFresh: fresh }
  }

  requirePermission(
    authorized: AuthorizedRemoteRequest,
    permission: RemotePermission,
    agentId: string,
  ): DeviceAgentGrant {
    const grant = this.store.getGrant(authorized.device.id, agentId)
    const allowed = permission === 'view' && grant?.canView
      || permission === 'message' && grant?.canMessage
      || permission === 'interrupt' && grant?.canInterrupt
      || permission === 'approve' && grant?.canApprove
    if (!allowed) denied('AGENT_PERMISSION_DENIED')
    return grant
  }

  visibleAgentIds(authorized: AuthorizedRemoteRequest): Set<string> {
    return new Set(
      this.store.listGrants(authorized.device.id)
        .filter((grant) => grant.canView)
        .map((grant) => grant.agentId),
    )
  }

  grantFor(authorized: AuthorizedRemoteRequest, agentId: string): DeviceAgentGrant | null {
    return this.store.getGrant(authorized.device.id, agentId)
  }

  assertStillAuthorized(authorized: AuthorizedRemoteRequest): void {
    const workstation = this.store.getWorkstation()
    const device = this.store.getDevice(authorized.device.id)
    const authState = this.tokenVerifier.getPublicState()
    if (!workstation
      || !workstation.remoteEnabled
      || workstation.id !== authorized.workstation.id
      || workstation.authEpoch !== authorized.workstation.authEpoch
      || authState.phase !== 'signed_in'
      || !authState.remoteAllowed
      || authState.userId !== workstation.ownerUserId
      || !device
      || device.state !== 'active'
      || device.fingerprint !== authorized.device.fingerprint
      || authorized.claims.expiresAt <= Math.floor(this.now() / 1_000)) {
      denied('REMOTE_AUTHORIZATION_REVOKED')
    }
  }
}
