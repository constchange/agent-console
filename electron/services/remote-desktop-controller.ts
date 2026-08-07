import type {
  RemoteAgentPermissionInput,
  RemoteAgentPermissionSet,
  RemotePairingDecisionInput,
  RemoteSettingsState,
  RemoteSignInInput,
  RemoteSignUpInput,
} from '../../shared/remote-settings'
import type { RemoteServiceStatus } from './remote-service-manager'
import { validateAuthCallbackUrl } from './auth-callback'

const ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,160}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PHASES = new Set(['unconfigured', 'signed-out', 'verification-required', 'secure-storage-unavailable', 'disabled', 'starting', 'ready', 'degraded', 'password-recovery'])
const CHECK_STATES = new Set(['pass', 'warning', 'fail', 'pending', 'not-run'])

export interface RemoteCoreRequester {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
}

export interface RemoteServiceController {
  prepare?(): Promise<void>
  enable(): Promise<RemoteServiceStatus>
  disable(): Promise<RemoteServiceStatus>
  status(): Promise<RemoteServiceStatus>
}

export type RemotePublicHealthProbe = (publicBaseUrl: string) => Promise<boolean>

async function defaultPublicHealthProbe(publicBaseUrl: string): Promise<boolean> {
  const target = new URL('/healthz', publicBaseUrl)
  if (target.protocol !== 'https:') return false
  const response = await fetch(target, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok || !response.body) return false
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4_096) {
        await reader.cancel()
        return false
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const payload = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown
  return Boolean(payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && (payload as { ok?: unknown }).ok === true
    && (payload as { protocolVersion?: unknown }).protocolVersion === 1)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`)
  return value as Record<string, unknown>
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label)
  const actual = Object.keys(result).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported fields.`)
  }
  return result
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || !allowEmpty && !value.trim()) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function nullableText(value: unknown, label: string, max: number): string | null {
  return value === null ? null : text(value, label, max)
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid.`)
  return value
}

function identifier(value: unknown, label: string, uuid = false): string {
  const result = text(value, label, 160)
  if (!(uuid ? UUID_PATTERN : ID_PATTERN).test(result)) throw new Error(`${label} is invalid.`)
  return result
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 40)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} is invalid.`)
  return new Date(result).toISOString()
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label)
}

function permissions(value: unknown): RemoteAgentPermissionSet {
  const item = exactRecord(value, ['viewStatus', 'viewEvents', 'message', 'approve', 'interrupt'], 'Remote permissions')
  return {
    viewStatus: boolean(item.viewStatus, 'View-status permission'),
    viewEvents: boolean(item.viewEvents, 'View-events permission'),
    message: boolean(item.message, 'Message permission'),
    approve: boolean(item.approve, 'Approval permission'),
    interrupt: boolean(item.interrupt, 'Interrupt permission'),
  }
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} is invalid.`)
  return value
}

/** Rebuilds the public DTO so an accidental Core field can never reach renderer IPC. */
export function sanitizeRemoteSettingsState(value: unknown): RemoteSettingsState {
  const state = record(value, 'Remote settings state')
  if (typeof state.phase !== 'string' || !PHASES.has(state.phase)) throw new Error('Remote settings phase is invalid.')
  const accountValue = state.account === null ? null : record(state.account, 'Remote account')
  const workstationValue = state.workstation === null ? null : record(state.workstation, 'Remote workstation')
  const gateway = record(state.gateway, 'Remote Gateway state')
  const pairingValue = state.pairing === null ? null : record(state.pairing, 'Remote pairing')
  const capabilities = record(state.capabilities, 'Remote capabilities')
  return {
    phase: state.phase as RemoteSettingsState['phase'],
    message: text(state.message, 'Remote settings message', 500),
    secureStorageReady: boolean(state.secureStorageReady, 'Secure-storage state'),
    account: accountValue ? {
      userId: accountValue.userId === null ? null : identifier(accountValue.userId, 'Remote account ID', true),
      email: text(accountValue.email, 'Remote account email', 320),
      nickname: text(accountValue.nickname, 'Remote account nickname', 80, true),
      emailVerified: boolean(accountValue.emailVerified, 'Email verification state'),
    } : null,
    workstation: workstationValue ? {
      workstationId: identifier(workstationValue.workstationId, 'Workstation ID', true),
      displayName: text(workstationValue.displayName, 'Workstation name', 100),
      pendingCloudSync: boolean(workstationValue.pendingCloudSync, 'Workstation sync state'),
    } : null,
    gateway: {
      enabled: boolean(gateway.enabled, 'Gateway enabled state'),
      localAddress: nullableText(gateway.localAddress, 'Gateway local address', 100),
      publicBaseUrl: nullableText(gateway.publicBaseUrl, 'Gateway public URL', 2_048),
      gatewayPid: gateway.gatewayPid === null
        ? null
        : Number.isSafeInteger(gateway.gatewayPid) && Number(gateway.gatewayPid) > 0
          ? Number(gateway.gatewayPid)
          : (() => { throw new Error('Gateway PID is invalid.') })(),
      tunnelActive: boolean(gateway.tunnelActive, 'Tunnel state'),
      lastReachableAt: nullableTimestamp(gateway.lastReachableAt, 'Gateway reachability timestamp'),
    },
    agents: array(state.agents, 'Remote Agents', 1_000).map((candidate) => {
      const item = record(candidate, 'Remote Agent permission')
      return {
        agentId: identifier(item.agentId, 'Remote Agent ID'),
        agentName: text(item.agentName, 'Remote Agent name', 100),
        projectName: text(item.projectName, 'Remote Project name', 100),
        color: text(item.color, 'Remote Agent color', 32),
        permissions: permissions(item.permissions),
        pendingCloudSync: boolean(item.pendingCloudSync, 'Remote Agent sync state'),
      }
    }),
    devices: array(state.devices, 'Remote devices', 1_000).map((candidate) => {
      const item = record(candidate, 'Remote device')
      if (!['android', 'ios', 'unknown'].includes(String(item.platform))) throw new Error('Remote device platform is invalid.')
      if (!['active', 'pending-cloud-sync', 'revoked'].includes(String(item.state))) throw new Error('Remote device state is invalid.')
      return {
        deviceId: identifier(item.deviceId, 'Remote device ID', true),
        displayName: text(item.displayName, 'Remote device name', 100),
        platform: item.platform as 'android' | 'ios' | 'unknown',
        state: item.state as 'active' | 'pending-cloud-sync' | 'revoked',
        pairedAt: timestamp(item.pairedAt, 'Remote device pairing timestamp'),
        lastSeenAt: nullableTimestamp(item.lastSeenAt, 'Remote device activity timestamp'),
      }
    }),
    pairing: pairingValue ? {
      pairingId: identifier(pairingValue.pairingId, 'Pairing ID', true),
      stage: pairingValue.stage === 'showing-code' || pairingValue.stage === 'awaiting-computer-confirmation'
        ? pairingValue.stage
        : (() => { throw new Error('Pairing stage is invalid.') })(),
      qrDataUrl: (() => {
        const result = text(pairingValue.qrDataUrl, 'Pairing QR image', 256 * 1_024)
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result)) throw new Error('Pairing QR image is invalid.')
        return result
      })(),
      sas: text(pairingValue.sas, 'Pairing confirmation code', 6, true),
      expiresAt: timestamp(pairingValue.expiresAt, 'Pairing expiry'),
      candidateDeviceName: nullableText(pairingValue.candidateDeviceName, 'Pairing device name', 100),
    } : null,
    checks: array(state.checks, 'Remote checks', 16).map((candidate) => {
      const item = record(candidate, 'Remote check')
      if (!['secure-storage', 'core', 'gateway', 'tunnel', 'https'].includes(String(item.id))) throw new Error('Remote check ID is invalid.')
      if (typeof item.state !== 'string' || !CHECK_STATES.has(item.state)) throw new Error('Remote check state is invalid.')
      return {
        id: item.id as 'secure-storage' | 'core' | 'gateway' | 'tunnel' | 'https',
        label: text(item.label, 'Remote check label', 100),
        state: item.state as 'pass' | 'warning' | 'fail' | 'pending' | 'not-run',
        detail: text(item.detail, 'Remote check detail', 500),
        checkedAt: nullableTimestamp(item.checkedAt, 'Remote check timestamp'),
      }
    }),
    capabilities: {
      canRegister: boolean(capabilities.canRegister, 'Registration capability'),
      canSignIn: boolean(capabilities.canSignIn, 'Sign-in capability'),
      canEnable: boolean(capabilities.canEnable, 'Enable capability'),
      canPair: boolean(capabilities.canPair, 'Pairing capability'),
      canRunDoctor: boolean(capabilities.canRunDoctor, 'Doctor capability'),
      // Workstation removal is intentionally not implemented in v0.5.
      canRemoveWorkstation: false,
    },
  }
}

function email(value: unknown): string {
  const result = text(value, 'Email address', 320).trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new Error('Email address is invalid.')
  return result
}

function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 1_024) throw new Error('Password is invalid.')
  return value
}

function serviceProjection(
  state: RemoteSettingsState,
  status: RemoteServiceStatus,
  publicProbePassed = false,
  lastReachableAt: string | null = state.gateway.lastReachableAt,
): RemoteSettingsState {
  const localServicesActive = status.gateway === 'active' && status.tunnel === 'active'
  const ready = state.gateway.enabled && localServicesActive && publicProbePassed
  return {
    ...state,
    phase: ready ? 'ready' : state.phase === 'ready' ? 'degraded' : state.phase,
    message: ready
      ? 'Remote authorization, the local Gateway, the tunnel, and the public HTTPS health check are ready.'
      : state.message,
    gateway: {
      ...state.gateway,
      // This flag is the Core authorization switch. Keep it true when a
      // systemd service fails so the user can still turn authorization off.
      enabled: state.gateway.enabled,
      tunnelActive: status.tunnel === 'active',
      lastReachableAt,
    },
  }
}

function degradedServiceState(
  state: RemoteSettingsState,
  message: string,
  status?: RemoteServiceStatus | null,
): RemoteSettingsState {
  return {
    ...state,
    phase: 'degraded',
    message,
    gateway: {
      ...state.gateway,
      enabled: false,
      tunnelActive: status ? status.tunnel === 'active' : state.gateway.tunnelActive,
      gatewayPid: null,
    },
  }
}

export class RemoteDesktopController {
  private publicProbeUrl: string | null = null
  private publicProbePassed = false
  private lastReachableAt: string | null = null

  constructor(
    private readonly core: RemoteCoreRequester,
    private readonly services: RemoteServiceController | null,
    private readonly refreshCoreEnvironment?: () => Promise<void>,
    private readonly publicHealthProbe: RemotePublicHealthProbe = defaultPublicHealthProbe,
  ) {}

  async settings(): Promise<RemoteSettingsState> {
    return this.call('remote.settings.get')
  }

  async signUp(input: unknown): Promise<RemoteSettingsState> {
    const value = exactRecord(input, ['email', 'password', 'nickname'], 'Registration request')
    const params: RemoteSignUpInput = {
      email: email(value.email),
      password: password(value.password),
      nickname: text(value.nickname, 'Nickname', 80),
    }
    return this.call('remote.auth.signUp', params)
  }

  async signIn(input: unknown): Promise<RemoteSettingsState> {
    const value = exactRecord(input, ['email', 'password'], 'Sign-in request')
    const params: RemoteSignInInput = { email: email(value.email), password: password(value.password) }
    return this.call('remote.auth.signIn', params)
  }

  async signOut(): Promise<RemoteSettingsState> {
    return this.stopServicesAfterAuthorizationOff(await this.call('remote.auth.signOut'))
  }

  resendVerification(): Promise<RemoteSettingsState> { return this.call('remote.auth.resendVerification') }

  async requestPasswordReset(value: unknown): Promise<RemoteSettingsState> {
    return this.stopServicesAfterAuthorizationOff(
      await this.call('remote.auth.requestPasswordReset', { email: email(value) }),
    )
  }

  completePasswordRecovery(input: unknown): Promise<RemoteSettingsState> {
    const value = exactRecord(input, ['newPassword'], 'Password recovery request')
    return this.call('remote.auth.completePasswordRecovery', { newPassword: password(value.newPassword) })
  }

  async handleAuthCallback(input: unknown): Promise<RemoteSettingsState> {
    const callbackUrl = validateAuthCallbackUrl(input)
    const current = await this.settings()
    const purpose = current.phase === 'password-recovery'
      ? 'recovery'
      : current.phase === 'verification-required'
        ? 'email-confirmation'
        : null
    if (!purpose) throw new Error('No authentication callback is expected in the current local state.')
    const state = await this.call('remote.auth.handleCallback', { callbackUrl, purpose })
    return state.phase === 'password-recovery'
      ? this.stopServicesAfterAuthorizationOff(state)
      : state
  }

  async enable(): Promise<RemoteSettingsState> {
    if (!this.services) {
      throw new Error('Remote services are unavailable on this installation; enablement was rolled back.')
    }
    let coreEnabled = false
    try {
      await this.services.prepare?.()
      await this.refreshCoreEnvironment?.()
      const enabled = await this.call('remote.control.enable')
      coreEnabled = true
      const status = await this.services.enable()
      if (status.gateway !== 'active' || status.tunnel !== 'active') throw new Error('Remote services did not become active.')
      return serviceProjection(enabled, status)
    } catch {
      await this.services.disable().catch(() => undefined)
      if (coreEnabled) await this.call('remote.control.disable').catch(() => undefined)
      throw new Error('Remote services could not start; Core enablement was rolled back safely.')
    }
  }

  async disable(): Promise<RemoteSettingsState> {
    let disabled: RemoteSettingsState
    try {
      disabled = await this.call('remote.control.disable')
    } catch (error) {
      // If Core cannot confirm authorization is off, still collapse the public
      // route. The caller receives a fixed failure instead of a false disabled
      // state, while systemd stop failures remain best-effort here.
      await this.services?.disable().catch(() => undefined)
      throw new Error(
        'Remote authorization could not be confirmed off; a precautionary local service stop was attempted.',
        { cause: error },
      )
    }
    return this.stopServicesAfterAuthorizationOff(disabled)
  }

  private async stopServicesAfterAuthorizationOff(disabled: RemoteSettingsState): Promise<RemoteSettingsState> {
    if (!this.services) return disabled
    try {
      const status = await this.services.disable()
      if (status.gateway !== 'inactive' || status.tunnel !== 'inactive') {
        return degradedServiceState(
          disabled,
          'Remote authorization is off, but one or more local Remote services could not be confirmed stopped.',
          status,
        )
      }
      return serviceProjection(disabled, status)
    } catch {
      const status = await this.services.status().catch(() => null)
      return degradedServiceState(
        disabled,
        'Remote authorization is off, but stopping the local Remote services failed.',
        status,
      )
    }
  }

  beginPairing(): Promise<RemoteSettingsState> { return this.call('remote.pairing.begin') }

  cancelPairing(value: unknown): Promise<RemoteSettingsState> {
    return this.call('remote.pairing.cancel', { pairingId: identifier(value, 'Pairing ID', true) })
  }

  async decidePairing(input: unknown): Promise<RemoteSettingsState> {
    const value = exactRecord(input, ['pairingId', 'approve'], 'Pairing decision')
    const params: RemotePairingDecisionInput = {
      pairingId: identifier(value.pairingId, 'Pairing ID', true),
      approve: boolean(value.approve, 'Pairing decision'),
    }
    return this.call('remote.pairing.decide', params)
  }

  revokeDevice(value: unknown): Promise<RemoteSettingsState> {
    return this.call('remote.device.revoke', { deviceId: identifier(value, 'Device ID', true) })
  }

  retryDeviceSync(value: unknown): Promise<RemoteSettingsState> {
    return this.call('remote.device.retrySync', { deviceId: identifier(value, 'Device ID', true) })
  }

  setAgentPermission(input: unknown): Promise<RemoteSettingsState> {
    const value = exactRecord(input, ['agentId', 'permissions'], 'Agent permission request')
    const params: RemoteAgentPermissionInput = {
      agentId: identifier(value.agentId, 'Agent ID'),
      permissions: permissions(value.permissions),
    }
    return this.call('remote.agent.setPermission', params)
  }

  renameWorkstation(value: unknown): Promise<RemoteSettingsState> {
    return this.call('remote.workstation.rename', { displayName: text(value, 'Workstation name', 100).trim() })
  }

  async doctor(): Promise<RemoteSettingsState> {
    const state = await this.call('remote.doctor')
    if (!this.services) return state
    let status: RemoteServiceStatus
    try {
      status = await this.services.status()
    } catch {
      return state
    }
    const checkedAt = new Date().toISOString()
    let checks = state.checks.map((check) => {
      const serviceState = check.id === 'gateway'
        ? status.gateway
        : check.id === 'tunnel'
          ? status.tunnel
          : null
      if (!serviceState) return check
      if (serviceState === 'active') {
        return { ...check, state: 'pass' as const, detail: `${check.label} service is active.`, checkedAt }
      }
      if (serviceState === 'failed') {
        return { ...check, state: 'fail' as const, detail: `${check.label} service is in the failed state.`, checkedAt }
      }
      return {
        ...check,
        state: state.gateway.enabled ? 'warning' as const : 'not-run' as const,
        detail: state.gateway.enabled
          ? `${check.label} service is not active.`
          : `${check.label} service is disabled.`,
        checkedAt,
      }
    })
    const canProbe = state.gateway.enabled
      && status.gateway === 'active'
      && status.tunnel === 'active'
      && state.gateway.publicBaseUrl !== null
    let publicPassed = false
    if (canProbe) {
      publicPassed = await this.publicHealthProbe(state.gateway.publicBaseUrl!).catch(() => false)
      this.publicProbeUrl = state.gateway.publicBaseUrl
      this.publicProbePassed = publicPassed
      if (publicPassed) this.lastReachableAt = checkedAt
      const httpsCheck = {
        id: 'https' as const,
        label: 'Public HTTPS',
        state: publicPassed ? 'pass' as const : 'fail' as const,
        detail: publicPassed
          ? 'The public HTTPS endpoint reached this Gateway and its private Core health bridge.'
          : 'The public HTTPS health check did not reach a healthy Gateway and Core.',
        checkedAt,
      }
      checks = checks.some((check) => check.id === 'https')
        ? checks.map((check) => check.id === 'https' ? httpsCheck : check)
        : [...checks, httpsCheck]
    } else {
      this.publicProbePassed = false
    }
    return serviceProjection({ ...state, checks }, status, publicPassed, this.lastReachableAt)
  }

  sanitizeEvent(value: unknown): RemoteSettingsState { return sanitizeRemoteSettingsState(value) }

  async projectEvent(value: unknown): Promise<RemoteSettingsState> {
    return this.projectServices(sanitizeRemoteSettingsState(value))
  }

  private async call(method: string, params?: unknown): Promise<RemoteSettingsState> {
    return this.projectServices(sanitizeRemoteSettingsState(await this.core.request<unknown>(method, params, 30_000)))
  }

  private async projectServices(state: RemoteSettingsState): Promise<RemoteSettingsState> {
    if (!this.services) return state
    const status = await this.services.status().catch(() => null)
    if (!status) return state
    const sameEndpoint = state.gateway.publicBaseUrl !== null && state.gateway.publicBaseUrl === this.publicProbeUrl
    const serviceReady = status.gateway === 'active' && status.tunnel === 'active'
    if (!state.gateway.enabled || !serviceReady || !sameEndpoint) this.publicProbePassed = false
    return serviceProjection(
      state,
      status,
      this.publicProbePassed && sameEndpoint,
      sameEndpoint ? this.lastReachableAt : null,
    )
  }
}
