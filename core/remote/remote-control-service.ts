import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import type { RemotePublicAuthState } from '../../shared/remote-validation'
import type { SupabaseAuthService } from '../auth/supabase-auth-service'
import type { PairingService, PendingPairingView } from './pairing-service'
import type { RemoteCloudSyncService } from './cloud-sync-service'
import { grantOutboxEntityId } from './outbox-identity'
import {
  RemoteStore,
  type DeviceAgentGrant,
  type DeviceState,
  type PairedDeviceRecord,
  type WorkstationRecord,
} from './remote-store'

export interface RemoteDeviceView {
  id: string
  name: string
  fingerprint: string
  state: DeviceState
  pairedAt: string
  revokedAt: string | null
  syncError: string
  pendingCloudSync: boolean
  grants: DeviceAgentGrant[]
}

export interface RemoteWorkstationView extends WorkstationRecord {
  pendingCloudSync: boolean
}

export interface RemoteControlStatus {
  auth: RemotePublicAuthState
  workstation: RemoteWorkstationView | null
  devices: RemoteDeviceView[]
  pendingPairings: PendingPairingDisplay[]
}

export interface PairingDisplay {
  pairingId: string
  workstationId: string
  expiresAt: string
  qrDataUrl: string
}

export interface PendingPairingDisplay extends PendingPairingView {
  /** Present only while the one-time Core-generated QR remains valid. */
  qrDataUrl: string | null
}

type RemoteControlListener = (status: RemoteControlStatus) => void

export interface RemoteGrantUpdateInput {
  deviceId: string
  agentId: string
  canView: boolean
  canMessage: boolean
  canInterrupt: boolean
  canApprove: boolean
  expectedRevision?: number
}

function deviceView(store: RemoteStore, device: PairedDeviceRecord): RemoteDeviceView {
  return {
    id: device.id,
    name: device.name,
    fingerprint: device.fingerprint,
    state: device.state,
    pairedAt: device.pairedAt,
    revokedAt: device.revokedAt,
    syncError: device.syncError,
    pendingCloudSync: store.hasPendingOutbox('device', device.id),
    grants: store.listGrants(device.id),
  }
}

/**
 * Desktop-facing composition root. Its return values contain no Supabase
 * access/refresh token, pairing secret, private key or raw public JWK.
 */
export class RemoteControlService {
  private readonly pairingDisplays = new Map<string, PairingDisplay>()
  private readonly listeners = new Set<RemoteControlListener>()
  private readonly unsubscribeAuth: () => void
  private readonly unsubscribePairing: () => void
  private readonly unsubscribeCloudSync: () => void

  constructor(
    private readonly auth: SupabaseAuthService,
    private readonly store: RemoteStore,
    private readonly pairing: PairingService,
    private readonly cloudSync: RemoteCloudSyncService,
  ) {
    this.unsubscribeAuth = this.auth.subscribe((state) => {
      // Pairing secrets are valid only while the verified owner is actively
      // signed in. Recovery, sign-out, expiry and keyring failures all destroy
      // pending QR state immediately.
      if (state.phase !== 'signed_in' || !state.remoteAllowed) this.pairing.close()
      this.emitChange()
    })
    this.unsubscribePairing = this.pairing.subscribe(() => this.emitChange())
    this.unsubscribeCloudSync = this.cloudSync.subscribe(() => this.emitChange())
  }

  subscribe(listener: RemoteControlListener): () => void {
    this.listeners.add(listener)
    listener(this.status())
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<RemoteControlStatus> {
    await this.auth.initialize()
    const state = this.auth.getPublicState()
    const workstation = this.store.getWorkstation()
    if (workstation && state.userId && workstation.ownerUserId !== state.userId && workstation.remoteEnabled) {
      this.store.setRemoteEnabled(false)
    }
    if (state.phase === 'signed_in') this.cloudSync.start()
    return this.publishStatus()
  }

  status(): RemoteControlStatus {
    const pending = this.pairing.listPending()
    const activePairings = new Set(pending.map((item) => item.pairingId))
    for (const pairingId of this.pairingDisplays.keys()) {
      if (!activePairings.has(pairingId)) this.pairingDisplays.delete(pairingId)
    }
    return {
      auth: this.auth.getPublicState(),
      workstation: this.workstationView(),
      devices: this.store.listDevices().map((device) => deviceView(this.store, device)),
      pendingPairings: pending.map((item) => ({
        ...item,
        qrDataUrl: this.pairingDisplays.get(item.pairingId)?.qrDataUrl ?? null,
      })),
    }
  }

  async signUp(input: {
    email: string
    password: string
    nickname?: string
    workstationName: string
  }): Promise<RemoteControlStatus> {
    const state = await this.auth.signUp(input.email, input.password, input.nickname)
    if (state.phase === 'signed_in' && state.userId) {
      this.ensureBound(state.userId, input.workstationName)
      this.cloudSync.start()
    }
    return this.publishStatus()
  }

  async resendSignupVerification(email: string): Promise<void> {
    await this.auth.resendSignupVerification(email)
  }

  async signIn(input: { email: string; password: string; workstationName: string }): Promise<RemoteControlStatus> {
    const state = await this.auth.signIn(input.email, input.password)
    if (!state.userId) throw new Error('Sign-in did not establish a verified user identity.')
    this.ensureBound(state.userId, input.workstationName)
    this.cloudSync.start()
    return this.publishStatus()
  }

  async signOut(): Promise<RemoteControlStatus> {
    const workstation = this.store.getWorkstation()
    if (workstation?.remoteEnabled) this.updateWorkstation(() => this.store.setRemoteEnabled(false))
    this.pairing.close()
    await this.cloudSync.trigger().catch(() => undefined)
    await this.cloudSync.stop()
    await this.auth.signOut()
    return this.publishStatus()
  }

  async requestPasswordRecovery(email: string): Promise<RemoteControlStatus> {
    const workstation = this.store.getWorkstation()
    if (workstation?.remoteEnabled) {
      this.updateWorkstation(() => this.store.setRemoteEnabled(false))
      await this.cloudSync.trigger().catch(() => undefined)
    }
    this.pairing.close()
    await this.cloudSync.stop()
    await this.auth.requestPasswordRecovery(email)
    return this.publishStatus()
  }

  async handleAuthCallback(
    callbackUrl: string,
    purpose: 'email-confirmation' | 'recovery',
    workstationName: string,
  ): Promise<RemoteControlStatus> {
    const state = await this.auth.handleCallback(callbackUrl, purpose)
    if (state.userId) this.ensureBound(state.userId, workstationName)
    if (state.phase === 'recovery') {
      this.pairing.close()
      const workstation = this.store.getWorkstation()
      if (workstation?.remoteEnabled) this.updateWorkstation(() => this.store.setRemoteEnabled(false))
    } else {
      this.cloudSync.start()
    }
    return this.publishStatus()
  }

  async completePasswordRecovery(newPassword: string): Promise<RemoteControlStatus> {
    await this.auth.completePasswordRecovery(newPassword)
    this.cloudSync.start()
    return this.publishStatus()
  }

  enableRemote(): RemoteControlStatus {
    const auth = this.auth.getPublicState()
    const workstation = this.store.getWorkstation()
    if (!workstation || auth.phase !== 'signed_in' || !auth.remoteAllowed || auth.userId !== workstation.ownerUserId) {
      throw new Error('Sign in as the verified workstation owner before enabling remote control.')
    }
    this.updateWorkstation(() => this.store.setRemoteEnabled(true))
    this.triggerSync()
    return this.publishStatus()
  }

  disableRemote(): RemoteControlStatus {
    const workstation = this.store.getWorkstation()
    if (workstation?.remoteEnabled) this.updateWorkstation(() => this.store.setRemoteEnabled(false))
    this.pairing.close()
    this.triggerSync()
    return this.publishStatus()
  }

  async beginPairing(gatewayBaseUrl: string): Promise<PairingDisplay> {
    const pairing = this.pairing.createPairing(gatewayBaseUrl)
    try {
      const display: PairingDisplay = {
        pairingId: pairing.pairingId,
        workstationId: pairing.workstationId,
        expiresAt: pairing.expiresAt,
        qrDataUrl: await QRCode.toDataURL(pairing.uri, {
          type: 'image/png',
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320,
        }),
      }
      this.pairingDisplays.set(display.pairingId, display)
      this.emitChange()
      return display
    } catch (error) {
      this.pairing.cancel(pairing.pairingId)
      throw error
    }
  }

  cancelPairing(pairingId: string): RemoteControlStatus {
    this.pairing.cancel(pairingId)
    return this.publishStatus()
  }

  confirmPairing(pairingId: string, displayedSas: string): RemoteControlStatus {
    this.pairing.confirm(pairingId, displayedSas)
    this.triggerSync()
    return this.publishStatus()
  }

  revokeDevice(deviceId: string): RemoteControlStatus {
    const workstation = this.requireWorkstation()
    this.store.atomic(() => {
      const revoked = this.store.revokeDevice(deviceId)
      this.store.enqueueOutbox({
        operation: 'device.revoke',
        entityType: 'device',
        entityId: revoked.id,
        payload: {
          deviceId: revoked.id,
          workstationId: workstation.id,
          revokedAt: revoked.revokedAt,
          state: revoked.state,
        },
      })
      this.store.appendAudit({
        deviceId: revoked.id,
        action: 'device.revoked',
        targetId: revoked.id,
        outcome: 'local_blocked',
        summary: 'A mobile device was revoked locally; cloud synchronization is pending.',
      })
      return revoked
    })
    this.triggerSync()
    return this.publishStatus()
  }

  retryDeviceSync(deviceId: string): RemoteControlStatus {
    const device = this.store.getDevice(deviceId)
    if (!device) throw new Error('Device not found.')
    const workstation = this.requireWorkstation()
    const revoking = device.state === 'revoke_pending' || device.state === 'revoked'
    this.store.enqueueOutbox({
      operation: revoking ? 'device.revoke' : 'device.upsert',
      entityType: 'device',
      entityId: device.id,
      payload: revoking
        ? {
            deviceId: device.id,
            workstationId: workstation.id,
            state: device.state,
            revokedAt: device.revokedAt,
          }
        : {
            deviceId: device.id,
            workstationId: workstation.id,
            displayName: device.name,
            fingerprint: device.fingerprint,
            publicJwk: device.publicJwk,
            state: device.state,
            pairedAt: device.pairedAt,
            revokedAt: device.revokedAt,
          },
    })
    this.triggerSync()
    return this.publishStatus()
  }

  setGrant(input: RemoteGrantUpdateInput): RemoteControlStatus {
    return this.setGrants([input])
  }

  setGrants(inputs: RemoteGrantUpdateInput[]): RemoteControlStatus {
    if (inputs.length < 1 || inputs.length > 256) throw new Error('Between 1 and 256 device permissions are required.')
    const workstation = this.requireWorkstation()
    this.store.atomic(() => {
      for (const input of inputs) {
        const grant = this.store.setGrant(input)
        this.store.enqueueOutbox({
          operation: 'grant.upsert',
          entityType: 'grant',
          entityId: grantOutboxEntityId(grant.deviceId, grant.agentId),
          payload: { workstationId: workstation.id, ...grant },
        })
        this.store.appendAudit({
          deviceId: grant.deviceId,
          action: 'grant.updated',
          targetId: grant.agentId,
          outcome: 'saved',
          summary: 'Remote Agent permissions were updated.',
        })
      }
    })
    this.triggerSync()
    return this.publishStatus()
  }

  doctor(): {
    authPhase: RemotePublicAuthState['phase']
    signedIn: boolean
    ownerMatches: boolean
    remoteEnabled: boolean
    activeDevices: number
    pendingDeviceSync: number
    pendingOutboxItems: number
  } {
    const auth = this.auth.getPublicState()
    const workstation = this.store.getWorkstation()
    const devices = this.store.listDevices()
    return {
      authPhase: auth.phase,
      signedIn: auth.phase === 'signed_in',
      ownerMatches: Boolean(workstation && auth.userId === workstation.ownerUserId),
      remoteEnabled: Boolean(workstation?.remoteEnabled),
      activeDevices: devices.filter((device) => device.state === 'active').length,
      pendingDeviceSync: devices.filter((device) => device.state === 'pending_sync' || device.state === 'revoke_pending').length,
      pendingOutboxItems: this.store.outboxCount(),
    }
  }

  async close(): Promise<void> {
    this.unsubscribeAuth()
    this.unsubscribePairing()
    this.unsubscribeCloudSync()
    this.listeners.clear()
    this.pairingDisplays.clear()
    this.pairing.close()
    await this.cloudSync.stop()
    await this.auth.dispose()
    this.store.close()
  }

  private ensureBound(userId: string, workstationName: string): WorkstationRecord {
    const existing = this.store.getWorkstation()
    if (existing && existing.ownerUserId !== userId) {
      // The newly authenticated account cannot update the previous owner's
      // cloud row through RLS. Fail closed locally without creating an outbox
      // item that can never be authorized under the new session.
      if (existing.remoteEnabled) this.store.setRemoteEnabled(false)
      throw new Error('This workstation belongs to another account. Remove that workstation binding before switching accounts.')
    }
    return this.store.atomic(() => {
      const workstation = existing ?? this.store.bindWorkstation({ id: randomUUID(), ownerUserId: userId, name: workstationName })
      this.enqueueWorkstation(workstation)
      return workstation
    })
  }

  renameWorkstation(name: string): RemoteControlStatus {
    this.updateWorkstation(() => this.store.renameWorkstation(name))
    this.triggerSync()
    return this.publishStatus()
  }

  private workstationView(): RemoteWorkstationView | null {
    const workstation = this.store.getWorkstation()
    return workstation
      ? { ...workstation, pendingCloudSync: this.store.hasPendingOutbox('workstation', workstation.id) }
      : null
  }

  private requireWorkstation(): WorkstationRecord {
    const workstation = this.store.getWorkstation()
    if (!workstation) throw new Error('Workstation is not registered.')
    return workstation
  }

  private enqueueWorkstation(workstation: WorkstationRecord): void {
    this.store.enqueueOutbox({
      operation: 'workstation.upsert',
      entityType: 'workstation',
      entityId: workstation.id,
      payload: {
        workstationId: workstation.id,
        displayName: workstation.name,
        remoteEnabled: workstation.remoteEnabled,
        updatedAt: workstation.updatedAt,
      },
    })
  }

  private updateWorkstation(operation: () => WorkstationRecord): WorkstationRecord {
    return this.store.atomic(() => {
      const workstation = operation()
      this.enqueueWorkstation(workstation)
      return workstation
    })
  }

  private triggerSync(): void {
    void this.cloudSync.trigger().catch(() => undefined)
  }

  private publishStatus(): RemoteControlStatus {
    const status = this.status()
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch {
        // Desktop listeners are observers and cannot affect Core state.
      }
    }
    return status
  }

  private emitChange(): void {
    if (this.listeners.size > 0) this.publishStatus()
  }
}
