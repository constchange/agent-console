import path from 'node:path'
import {
  CORE_PROTOCOL_VERSION,
  CORE_RPC_ERROR,
  CoreRpcException,
  type CoreHandlerMethod,
  type CoreRequestContext,
} from '../../shared/core-protocol'
import type { RemoteHealth } from '../../shared/remote-protocol'
import type {
  RemoteAgentPermissionSet,
  RemoteCheckState,
  RemoteServiceCheck,
  RemoteSettingsPhase,
  RemoteSettingsState,
} from '../../shared/remote-settings'
import {
  requireOpaqueId,
  requireString,
  requireUuid,
  validateRemoteDispatchEnvelope,
  type RemoteDispatchEnvelope,
  type RemoteDispatchResponse,
  type RemoteEventStreamPollResult,
} from '../../shared/remote-validation'
import type { ConsoleState } from '../../shared/types'
import {
  SecureSessionStorage,
  type SafeStorageLike,
} from '../auth/secure-session-storage'
import { SupabaseAuthService } from '../auth/supabase-auth-service'
import { RemoteAuthorizationService } from './authorization-service'
import { RemoteCloudSyncService } from './cloud-sync-service'
import { RemoteIdempotencyService } from './idempotency-service'
import { PairingService } from './pairing-service'
import {
  RemoteControlService,
  type PairingDisplay,
  type RemoteControlStatus,
  type RemoteGrantUpdateInput,
} from './remote-control-service'
import {
  CoreRemoteRequestRouter,
  type CoreRemoteStreamOpenResult,
  type RemoteCoreActions,
} from './request-router'
import { RemoteStore } from './remote-store'
import {
  parseRemoteRuntimeConfig,
  type RemoteRuntimeConfig,
} from './runtime-config'
import { SupabaseRemoteCloudAdapter } from './supabase-cloud-adapter'

const REMOTE_SETTINGS_EVENT = 'remote.settings'

export interface CoreRemoteRuntimeOptions {
  environment?: NodeJS.ProcessEnv
  safeStorage?: SafeStorageLike | null
  workstationName?: string
  /** Test seam. Production callers should leave this undefined. */
  componentFactory?: CoreRemoteComponentFactory
}

interface RemoteControlPort {
  initialize(): Promise<RemoteControlStatus>
  status(): RemoteControlStatus
  subscribe(listener: (status: RemoteControlStatus) => void): () => void
  signUp(input: { email: string; password: string; nickname?: string; workstationName: string }): Promise<RemoteControlStatus>
  resendSignupVerification(email: string): Promise<void>
  signIn(input: { email: string; password: string; workstationName: string }): Promise<RemoteControlStatus>
  signOut(): Promise<RemoteControlStatus>
  requestPasswordRecovery(email: string): Promise<RemoteControlStatus>
  handleAuthCallback(
    callbackUrl: string,
    purpose: 'email-confirmation' | 'recovery',
    workstationName: string,
  ): Promise<RemoteControlStatus>
  completePasswordRecovery(newPassword: string): Promise<RemoteControlStatus>
  enableRemote(): RemoteControlStatus
  disableRemote(): RemoteControlStatus
  beginPairing(gatewayBaseUrl: string): Promise<PairingDisplay>
  cancelPairing(pairingId: string): RemoteControlStatus
  confirmPairing(pairingId: string, displayedSas: string): RemoteControlStatus
  revokeDevice(deviceId: string): RemoteControlStatus
  retryDeviceSync(deviceId: string): RemoteControlStatus
  setGrants(inputs: RemoteGrantUpdateInput[]): RemoteControlStatus
  renameWorkstation(name: string): RemoteControlStatus
  close(): Promise<void>
}

interface RemoteRouterPort {
  handle(envelope: RemoteDispatchEnvelope): Promise<RemoteDispatchResponse>
  openStream(envelope: RemoteDispatchEnvelope, connectionId: string): Promise<CoreRemoteStreamOpenResult>
  pollStream(streamId: string, connectionId: string): Promise<RemoteEventStreamPollResult>
  closeStream(streamId: string, connectionId: string): boolean
  closeConnectionStreams(connectionId: string): void
  close(): void
}

export interface CoreRemoteComponents {
  control: RemoteControlPort
  router: RemoteRouterPort
  hasPendingAgentSync(agentId: string): boolean
  close(): Promise<void>
}

export interface CoreRemoteComponentFactoryInput {
  config: RemoteRuntimeConfig
  userDataPath: string
  safeStorage: SafeStorageLike | null
  actions: RemoteCoreActions
}

export type CoreRemoteComponentFactory = (
  input: CoreRemoteComponentFactoryInput,
) => CoreRemoteComponents | Promise<CoreRemoteComponents>

export interface CoreRemoteManagerOptions extends CoreRemoteRuntimeOptions {
  userDataPath: string
  appVersion: string
  startedAt: string
  actions: RemoteCoreActions
  getConsoleState(): ConsoleState
  publishDesktop(type: typeof REMOTE_SETTINGS_EVENT, state: RemoteSettingsState): void
}

const unavailableSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => '',
  encryptString: () => { throw new Error('Secure storage is unavailable.') },
  decryptString: () => { throw new Error('Secure storage is unavailable.') },
}

function publicError(error: unknown, fallback: string): string {
  void error
  // Provider, keyring and proxy failures can contain identifiers, URLs or
  // credential fragments. Only fixed boundary text reaches the renderer.
  return fallback.slice(0, 300)
}

function noParams(value: unknown): void {
  if (value !== undefined && value !== null) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'This method does not accept parameters.')
  }
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'Request parameters must be an object.')
  }
  const record = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'Request parameters contain unknown or missing fields.')
  }
  return record
}

function requiredText(value: unknown, label: string, max = 1_024): string {
  try {
    return requireString(value, label, { max })
  } catch {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, `${label} is invalid.`)
  }
}

function uuid(value: unknown, label: string): string {
  try {
    return requireUuid(value, label)
  } catch {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, `${label} is invalid.`)
  }
}

function opaqueId(value: unknown, label: string): string {
  try {
    return requireOpaqueId(value, label)
  } catch {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, `${label} is invalid.`)
  }
}

function permissionSet(value: unknown): RemoteAgentPermissionSet {
  const values = exactRecord(value, ['viewStatus', 'viewEvents', 'message', 'approve', 'interrupt'])
  for (const key of Object.keys(values)) {
    if (typeof values[key] !== 'boolean') {
      throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, `permissions.${key} must be a boolean.`)
    }
  }
  if (values.viewStatus !== values.viewEvents) {
    throw new CoreRpcException(
      CORE_RPC_ERROR.INVALID_PARAMS,
      'viewStatus and viewEvents must match because v0.5 stores one conservative view grant.',
    )
  }
  return values as unknown as RemoteAgentPermissionSet
}

function defaultChecks(): RemoteServiceCheck[] {
  const definitions: Array<[RemoteServiceCheck['id'], string]> = [
    ['secure-storage', 'Secure storage'],
    ['core', 'Console Core'],
    ['gateway', 'Local Gateway'],
    ['tunnel', 'HTTPS tunnel'],
    ['https', 'Public HTTPS'],
  ]
  return definitions.map(([id, label]) => ({ id, label, state: 'not-run', detail: 'Not checked yet.', checkedAt: null }))
}

async function productionComponents(input: CoreRemoteComponentFactoryInput): Promise<CoreRemoteComponents> {
  const storage = new SecureSessionStorage(
    path.join(input.userDataPath, 'remote', 'supabase-session.enc.json'),
    input.safeStorage ?? unavailableSafeStorage,
  )
  const auth = new SupabaseAuthService({
    url: input.config.supabaseUrl,
    publishableKey: input.config.publishableKey,
    callbackUrl: 'agent-console://auth/callback',
  }, storage)
  const store = new RemoteStore(path.join(input.userDataPath, 'remote-control.sqlite'))
  const pairing = new PairingService(store, auth)
  const authorization = new RemoteAuthorizationService(store, auth)
  const idempotency = new RemoteIdempotencyService(store)
  const router = new CoreRemoteRequestRouter(input.actions, authorization, pairing, idempotency)
  const cloudSync = new RemoteCloudSyncService(store, new SupabaseRemoteCloudAdapter(auth))
  const control = new RemoteControlService(auth, store, pairing, cloudSync)
  return {
    control,
    router,
    hasPendingAgentSync: (agentId) => store.hasPendingGrantOutbox(agentId),
    close: async () => {
      router.close()
      await control.close()
    },
  }
}

export class CoreRemoteManager {
  private config: RemoteRuntimeConfig | null = null
  private components: CoreRemoteComponents | null = null
  private unsubscribeControl: (() => void) | null = null
  private unavailableMessage = 'Mobile Remote has not initialized.'
  private unavailablePhase: Extract<RemoteSettingsPhase, 'unconfigured' | 'degraded'> = 'unconfigured'
  private initialized = false
  private nickname = ''
  private checks = defaultChecks()

  constructor(private readonly options: CoreRemoteManagerOptions) {
    if (!path.isAbsolute(options.userDataPath)) throw new Error('Core user-data path must be absolute.')
  }

  async start(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.config = null
    this.unavailableMessage = 'Mobile Remote has not initialized.'
    this.unavailablePhase = 'unconfigured'
    this.nickname = ''
    this.checks = defaultChecks()
    let parsed
    try {
      parsed = parseRemoteRuntimeConfig(this.options.environment ?? process.env)
    } catch (error) {
      this.unavailableMessage = publicError(error, 'Remote configuration is invalid; Mobile Remote remains disabled.')
      this.unavailablePhase = 'degraded'
      this.publishSettings()
      return
    }
    if (!parsed.configured) {
      this.unavailableMessage = parsed.message
      this.publishSettings()
      return
    }
    this.config = parsed.config
    try {
      const factory = this.options.componentFactory ?? productionComponents
      this.components = await factory({
        config: parsed.config,
        userDataPath: this.options.userDataPath,
        safeStorage: this.options.safeStorage ?? null,
        actions: this.options.actions,
      })
      this.unsubscribeControl = this.components.control.subscribe(() => this.publishSettings())
      try {
        await this.components.control.initialize()
      } catch (error) {
        this.unavailableMessage = publicError(error, 'Remote authentication could not initialize safely.')
      }
      if (!parsed.config.armed) {
        try {
          this.components.control.disableRemote()
        } catch {
          // A disarmed configuration remains fail-closed even if status cannot be updated.
        }
      }
    } catch (error) {
      this.unavailableMessage = publicError(error, 'Remote components could not initialize safely.')
      this.unavailablePhase = 'degraded'
      await this.components?.close().catch(() => undefined)
      this.components = null
    }
    this.publishSettings()
  }

  async stop(): Promise<void> {
    this.unsubscribeControl?.()
    this.unsubscribeControl = null
    const components = this.components
    this.components = null
    await components?.close().catch(() => undefined)
    this.initialized = false
  }

  settings(): RemoteSettingsState {
    if (!this.config || !this.components) return this.unavailableSettings()
    const status = this.components.control.status()
    const auth = status.auth
    const secureStorageReady = auth.phase !== 'locked' && auth.phase !== 'unconfigured'
    const enabled = Boolean(this.config.armed
      && status.workstation?.remoteEnabled
      && auth.phase === 'signed_in'
      && auth.remoteAllowed)
    let phase: RemoteSettingsPhase
    let message = auth.message
    if (auth.phase === 'locked') phase = 'secure-storage-unavailable'
    else if (auth.phase === 'recovery') phase = 'password-recovery'
    else if (auth.phase === 'degraded') phase = auth.userId ? 'degraded' : 'signed-out'
    else if (auth.phase === 'signed_out') phase = auth.email && !auth.emailConfirmed ? 'verification-required' : 'signed-out'
    else if (auth.phase === 'signed_in' && !auth.emailConfirmed) phase = 'verification-required'
    else if (auth.phase === 'signed_in' && !enabled) phase = 'disabled'
    else if (auth.phase === 'signed_in') {
      phase = 'degraded'
      message = 'Remote authorization is enabled; run Doctor to verify the external Gateway and HTTPS tunnel.'
    } else phase = 'starting'
    if (!this.config.armed && phase !== 'secure-storage-unavailable' && phase !== 'password-recovery') {
      if (auth.phase === 'signed_in') phase = 'disabled'
      message = 'Mobile Remote is configured but disarmed. Deployment checks must pass before enabling it.'
    }

    const activeDevices = status.devices.filter((device) => device.state === 'active')
    const state = this.options.getConsoleState()
    return {
      phase,
      message,
      secureStorageReady,
      account: auth.userId || auth.email ? {
        userId: auth.userId,
        email: auth.email ?? '',
        nickname: this.nickname,
        emailVerified: auth.emailConfirmed,
      } : null,
      workstation: status.workstation ? {
        workstationId: status.workstation.id,
        displayName: status.workstation.name,
        pendingCloudSync: status.workstation.pendingCloudSync,
      } : null,
      gateway: {
        enabled,
        localAddress: `${this.config.gatewayHost}:${this.config.gatewayPort}`,
        publicBaseUrl: this.config.publicBaseUrl,
        gatewayPid: null,
        tunnelActive: false,
        lastReachableAt: null,
      },
      agents: state.agents.map((agent) => {
        const grants = activeDevices.map((device) => device.grants.find((grant) => grant.agentId === agent.id) ?? null)
        const every = (permission: 'canView' | 'canMessage' | 'canApprove' | 'canInterrupt') => (
          activeDevices.length > 0 && grants.every((grant) => Boolean(grant?.[permission]))
        )
        const canView = every('canView')
        return {
          agentId: agent.id,
          agentName: agent.name,
          projectName: state.projects.find((project) => project.id === agent.projectId)?.name ?? 'Unknown project',
          color: agent.color,
          permissions: {
            viewStatus: canView,
            viewEvents: canView,
            message: every('canMessage'),
            approve: every('canApprove'),
            interrupt: every('canInterrupt'),
          },
          pendingCloudSync: this.components?.hasPendingAgentSync(agent.id)
            || activeDevices.some((device) => device.pendingCloudSync),
        }
      }),
      devices: status.devices.map((device) => ({
        deviceId: device.id,
        displayName: device.name,
        platform: 'unknown',
        state: device.state === 'active'
          ? 'active'
          : device.state === 'revoked'
            ? 'revoked'
            : 'pending-cloud-sync',
        pairedAt: device.pairedAt,
        lastSeenAt: null,
      })),
      pairing: this.pairingView(status),
      checks: this.checks.map((check) => ({ ...check })),
      capabilities: {
        canRegister: secureStorageReady && (auth.phase === 'signed_out' || auth.phase === 'degraded'),
        canSignIn: secureStorageReady && (auth.phase === 'signed_out' || auth.phase === 'degraded'),
        canEnable: Boolean(this.config.armed
          && auth.phase === 'signed_in'
          && auth.remoteAllowed
          && status.workstation
          && status.workstation.ownerUserId === auth.userId
          && !status.workstation.remoteEnabled),
        canPair: Boolean(enabled && auth.phase === 'signed_in' && auth.remoteAllowed),
        canRunDoctor: true,
        canRemoveWorkstation: false,
      },
    }
  }

  async handle(method: CoreHandlerMethod, params: unknown, context: CoreRequestContext): Promise<unknown> {
    try {
      switch (method) {
        case 'remote.health':
          noParams(params)
          return this.health()
        case 'remote.request': {
          this.requireArmed()
          const values = exactRecord(params, ['envelope'])
          return await this.requireComponents().router.handle(validateRemoteDispatchEnvelope(values.envelope))
        }
        case 'remote.stream.open': {
          this.requireArmed()
          const values = exactRecord(params, ['envelope'])
          return await this.requireComponents().router.openStream(
            validateRemoteDispatchEnvelope(values.envelope),
            context.connectionId,
          )
        }
        case 'remote.stream.poll': {
          this.requireArmed()
          const values = exactRecord(params, ['streamId'])
          return await this.requireComponents().router.pollStream(opaqueId(values.streamId, 'streamId'), context.connectionId)
        }
        case 'remote.stream.close': {
          const values = exactRecord(params, ['streamId'])
          return { closed: this.requireComponents().router.closeStream(opaqueId(values.streamId, 'streamId'), context.connectionId) }
        }
        case 'remote.settings.get':
          noParams(params)
          return this.settings()
        case 'remote.auth.signUp': {
          const values = exactRecord(params, ['email', 'password', 'nickname'], ['workstationName'])
          this.nickname = requiredText(values.nickname, 'nickname', 80)
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
          if (!this.nickname) throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'nickname is invalid.')
          await this.requireComponents().control.signUp({
            email: requiredText(values.email, 'email', 320),
            password: requiredText(values.password, 'password'),
            nickname: this.nickname,
            workstationName: this.workstationName(values.workstationName),
          })
          return this.publishAndReturn()
        }
        case 'remote.auth.signIn': {
          const values = exactRecord(params, ['email', 'password'], ['workstationName'])
          await this.requireComponents().control.signIn({
            email: requiredText(values.email, 'email', 320),
            password: requiredText(values.password, 'password'),
            workstationName: this.workstationName(values.workstationName),
          })
          return this.publishAndReturn()
        }
        case 'remote.auth.signOut':
          noParams(params)
          await this.requireComponents().control.signOut()
          this.nickname = ''
          return this.publishAndReturn()
        case 'remote.auth.resendVerification': {
          noParams(params)
          const email = this.requireComponents().control.status().auth.email
          if (!email) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'No signup email is awaiting verification.')
          await this.requireComponents().control.resendSignupVerification(email)
          return this.publishAndReturn()
        }
        case 'remote.auth.requestPasswordReset': {
          const values = exactRecord(params, ['email'])
          await this.requireComponents().control.requestPasswordRecovery(requiredText(values.email, 'email', 320))
          return this.publishAndReturn()
        }
        case 'remote.auth.completePasswordRecovery': {
          const values = exactRecord(params, ['newPassword'])
          await this.requireComponents().control.completePasswordRecovery(requiredText(values.newPassword, 'newPassword'))
          return this.publishAndReturn()
        }
        case 'remote.auth.handleCallback': {
          const values = exactRecord(params, ['callbackUrl', 'purpose'], ['workstationName'])
          if (values.purpose !== 'email-confirmation' && values.purpose !== 'recovery') {
            throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'purpose is invalid.')
          }
          await this.requireComponents().control.handleAuthCallback(
            requiredText(values.callbackUrl, 'callbackUrl', 4_096),
            values.purpose,
            this.workstationName(values.workstationName),
          )
          return this.publishAndReturn()
        }
        case 'remote.control.enable':
          noParams(params)
          this.requireArmed()
          this.requireComponents().control.enableRemote()
          return this.publishAndReturn()
        case 'remote.control.disable':
          noParams(params)
          this.requireComponents().control.disableRemote()
          return this.publishAndReturn()
        case 'remote.pairing.begin':
          noParams(params)
          this.requireArmed()
          await this.beginPairing()
          return this.publishAndReturn()
        case 'remote.pairing.cancel': {
          const values = exactRecord(params, ['pairingId'])
          this.requireComponents().control.cancelPairing(uuid(values.pairingId, 'pairingId'))
          return this.publishAndReturn()
        }
        case 'remote.pairing.decide': {
          const values = exactRecord(params, ['pairingId', 'approve'])
          if (typeof values.approve !== 'boolean') {
            throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'approve must be a boolean.')
          }
          const pairingId = uuid(values.pairingId, 'pairingId')
          if (!values.approve) this.requireComponents().control.cancelPairing(pairingId)
          else {
            const pending = this.requireComponents().control.status().pendingPairings.find((item) => item.pairingId === pairingId)
            if (!pending?.claimed || !pending.sas) {
              throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'The pairing has not been claimed with a confirmation code.')
            }
            this.requireComponents().control.confirmPairing(pairingId, pending.sas)
          }
          return this.publishAndReturn()
        }
        case 'remote.device.revoke': {
          const values = exactRecord(params, ['deviceId'])
          this.requireComponents().control.revokeDevice(uuid(values.deviceId, 'deviceId'))
          return this.publishAndReturn()
        }
        case 'remote.device.retrySync': {
          const values = exactRecord(params, ['deviceId'])
          this.requireComponents().control.retryDeviceSync(uuid(values.deviceId, 'deviceId'))
          return this.publishAndReturn()
        }
        case 'remote.agent.setPermission': {
          const values = exactRecord(params, ['agentId', 'permissions'])
          this.setAgentPermission(opaqueId(values.agentId, 'agentId'), permissionSet(values.permissions))
          return this.publishAndReturn()
        }
        case 'remote.workstation.rename': {
          const values = exactRecord(params, ['displayName'])
          this.requireComponents().control.renameWorkstation(requiredText(values.displayName, 'displayName', 100))
          return this.publishAndReturn()
        }
        case 'remote.doctor':
          noParams(params)
          this.runDoctor()
          return this.publishAndReturn()
      }
      throw new CoreRpcException(CORE_RPC_ERROR.METHOD_NOT_FOUND, 'Remote method is not implemented.')
    } catch (error) {
      if (error instanceof CoreRpcException) throw error
      throw new CoreRpcException(
        CORE_RPC_ERROR.NOT_ACTIONABLE,
        publicError(error, 'Remote operation could not be completed safely.'),
      )
    }
  }

  closeConnection(connectionId: string): void {
    this.components?.router.closeConnectionStreams(connectionId)
  }

  notifyConsoleSettingsChanged(): void {
    this.publishSettings()
  }

  private health(): RemoteHealth {
    return {
      online: true,
      appVersion: this.options.appVersion,
      protocolVersion: CORE_PROTOCOL_VERSION,
      startedAt: this.options.startedAt,
    }
  }

  private unavailableSettings(): RemoteSettingsState {
    return {
      phase: this.unavailablePhase,
      message: this.unavailableMessage,
      secureStorageReady: false,
      account: null,
      workstation: null,
      gateway: {
        enabled: false,
        localAddress: null,
        publicBaseUrl: null,
        gatewayPid: null,
        tunnelActive: false,
        lastReachableAt: null,
      },
      agents: this.options.getConsoleState().agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        projectName: this.options.getConsoleState().projects.find((project) => project.id === agent.projectId)?.name ?? 'Unknown project',
        color: agent.color,
        permissions: { viewStatus: false, viewEvents: false, message: false, approve: false, interrupt: false },
        pendingCloudSync: false,
      })),
      devices: [],
      pairing: null,
      checks: this.checks.map((check) => ({ ...check })),
      capabilities: {
        canRegister: false,
        canSignIn: false,
        canEnable: false,
        canPair: false,
        canRunDoctor: true,
        canRemoveWorkstation: false,
      },
    }
  }

  private pairingView(status: RemoteControlStatus): RemoteSettingsState['pairing'] {
    const pending = status.pendingPairings.find((item) => Boolean(item.qrDataUrl))
    if (!pending?.qrDataUrl) return null
    return {
      pairingId: pending.pairingId,
      stage: pending.claimed ? 'awaiting-computer-confirmation' : 'showing-code',
      qrDataUrl: pending.qrDataUrl,
      sas: pending.sas ?? '',
      expiresAt: pending.expiresAt,
      candidateDeviceName: pending.deviceName,
    }
  }

  private requireComponents(): CoreRemoteComponents {
    if (!this.components) throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, this.unavailableMessage)
    return this.components
  }

  private requireArmed(): RemoteRuntimeConfig {
    if (!this.config?.armed) {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Mobile Remote is not armed in the private runtime configuration.')
    }
    return this.config
  }

  private workstationName(value: unknown): string {
    if (value !== undefined) return requiredText(value, 'workstationName', 100)
    const fallback = this.options.workstationName?.trim() || 'Agent Console workstation'
    return fallback.slice(0, 100)
  }

  private async beginPairing(): Promise<void> {
    const components = this.requireComponents()
    const status = components.control.status()
    if (!status.workstation?.remoteEnabled) {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Enable Mobile Remote before pairing a device.')
    }
    for (const pending of status.pendingPairings) components.control.cancelPairing(pending.pairingId)
    await components.control.beginPairing(this.requireArmed().publicBaseUrl)
  }

  private setAgentPermission(agentId: string, permissions: RemoteAgentPermissionSet): void {
    if (!this.options.getConsoleState().agents.some((agent) => agent.id === agentId)) {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_FOUND, 'Agent not found.')
    }
    const components = this.requireComponents()
    const activeDevices = components.control.status().devices.filter((device) => device.state === 'active')
    if (activeDevices.length === 0) {
      throw new CoreRpcException(CORE_RPC_ERROR.NOT_ACTIONABLE, 'Pair and synchronize at least one active device first.')
    }
    components.control.setGrants(activeDevices.map((device) => ({
      deviceId: device.id,
      agentId,
      canView: permissions.viewStatus,
      canMessage: permissions.message,
      canInterrupt: permissions.interrupt,
      canApprove: permissions.approve,
    })))
  }

  private runDoctor(): void {
    const checkedAt = new Date().toISOString()
    const status = this.components?.control.status()
    const authPhase = status?.auth.phase
    const check = (
      id: RemoteServiceCheck['id'],
      label: string,
      state: RemoteCheckState,
      detail: string,
    ): RemoteServiceCheck => ({ id, label, state, detail, checkedAt })
    this.checks = [
      check(
        'secure-storage',
        'Secure storage',
        authPhase === 'locked' || !this.components ? 'fail' : 'pass',
        authPhase === 'locked' || !this.components
          ? 'The operating-system keyring is unavailable; no session is stored.'
          : 'The Core initialized encrypted session storage without a plaintext fallback.',
      ),
      check('core', 'Console Core', 'pass', 'The Core is running on its local Unix socket.'),
      check(
        'gateway',
        'Local Gateway',
        this.config?.armed && status?.workstation?.remoteEnabled ? 'warning' : 'not-run',
        this.config?.armed && status?.workstation?.remoteEnabled
          ? 'Authorization is enabled; the desktop host must verify the separate localhost Gateway process.'
          : 'Enable and arm Mobile Remote before checking the Gateway.',
      ),
      check('tunnel', 'HTTPS tunnel', 'not-run', 'Tunnel process health is owned by the desktop deployment service.'),
      check('https', 'Public HTTPS', 'not-run', 'Public reachability must be verified outside the credential-holding Core.'),
    ]
  }

  private publishAndReturn(): RemoteSettingsState {
    const state = this.settings()
    try {
      this.options.publishDesktop(REMOTE_SETTINGS_EVENT, state)
    } catch {
      // The state is still available through remote.settings.get if a desktop
      // event subscriber disconnects or rejects an oversized notification.
    }
    return state
  }

  private publishSettings(): void {
    try {
      this.options.publishDesktop(REMOTE_SETTINGS_EVENT, this.settings())
    } catch {
      // Desktop event delivery is advisory; Core state remains authoritative.
    }
  }
}
