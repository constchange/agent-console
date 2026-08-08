import type {
  ActionResult,
  AgentConfig,
  ConsoleState,
  CoreHealth,
  RuntimeSnapshot,
} from './types'
import type {
  RemoteHealth,
} from './remote-protocol'
import type {
  RemoteAgentPermissionInput,
  RemoteCompletePasswordRecoveryInput,
  RemoteSettingsState,
  RemoteSignInInput,
  RemoteSignUpInput,
} from './remote-settings'
import type {
  RemoteDispatchEnvelope,
  RemoteDispatchResponse,
  RemoteEventStreamPollResult,
} from './remote-validation'

export const CORE_PROTOCOL_VERSION = 5
export const CORE_MAX_MESSAGE_BYTES = 1024 * 1024
export const CORE_EVENT_NOTIFICATION = 'core.event' as const

export const CORE_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32000,
  ALREADY_INITIALIZED: -32001,
  PROTOCOL_VERSION_MISMATCH: -32002,
  MESSAGE_TOO_LARGE: -32003,
  REQUEST_TIMEOUT: -32004,
  DISCONNECTED: -32005,
  CONFLICT: -32010,
  STALE_STATE: -32011,
  NOT_ACTIONABLE: -32012,
  AMBIGUOUS_TARGET: -32013,
  ADAPTER_UNAVAILABLE: -32014,
  UNSUPPORTED_VERSION: -32015,
  NOT_FOUND: -32016,
  TOO_MANY_REQUESTS: -32017,
  FORBIDDEN_CHANNEL: -32018,
  REQUEST_EXPIRED: -32019,
  STALE_TASK: -32020,
  REQUEST_IN_PROGRESS: -32021,
  REQUEST_OUTCOME_UNKNOWN: -32022,
} as const

export type CoreRpcErrorCode = typeof CORE_RPC_ERROR[keyof typeof CORE_RPC_ERROR]
export type CoreRpcId = string | number

export type CoreChannel = 'desktop' | 'gateway'

export const DESKTOP_CORE_METHODS = [
  'core.health',
  'core.bootstrap',
  'core.flush',
  'config.get',
  'config.commit',
  'runtime.get',
  'runtime.refresh',
  'terminal.open',
  'terminal.close',
  'project.restore',
  'task.list',
  'task.get',
  'task.start',
  'task.message',
  'task.interrupt',
  'approval.list',
  'approval.get',
  'approval.decide',
  'remote.settings.get',
  'remote.auth.signUp',
  'remote.auth.signIn',
  'remote.auth.signOut',
  'remote.auth.resendVerification',
  'remote.auth.requestPasswordReset',
  'remote.auth.completePasswordRecovery',
  'remote.auth.handleCallback',
  'remote.control.enable',
  'remote.control.disable',
  'remote.pairing.begin',
  'remote.pairing.cancel',
  'remote.pairing.decide',
  'remote.device.revoke',
  'remote.device.retrySync',
  'remote.agent.setPermission',
  'remote.workstation.rename',
  'remote.doctor',
] as const

export const GATEWAY_CORE_METHODS = [
  'remote.health',
  'remote.request',
  'remote.stream.open',
  'remote.stream.poll',
  'remote.stream.close',
] as const

export const CORE_HANDLER_METHODS = [
  ...DESKTOP_CORE_METHODS,
  ...GATEWAY_CORE_METHODS,
] as const

export type CoreHandlerMethod = typeof CORE_HANDLER_METHODS[number]
export type DesktopCoreMethod = typeof DESKTOP_CORE_METHODS[number]
export type GatewayCoreMethod = typeof GATEWAY_CORE_METHODS[number]
export type CoreBuiltinMethod = 'initialize' | 'events.subscribe'
export type CoreRpcMethod = CoreBuiltinMethod | CoreHandlerMethod

const HANDLER_METHOD_SET = new Set<string>(CORE_HANDLER_METHODS)
const DESKTOP_METHOD_SET = new Set<string>(DESKTOP_CORE_METHODS)
const GATEWAY_METHOD_SET = new Set<string>(GATEWAY_CORE_METHODS)

export function isCoreHandlerMethod(value: unknown): value is CoreHandlerMethod {
  return typeof value === 'string' && HANDLER_METHOD_SET.has(value)
}

export function isMethodAllowedForChannel(method: CoreHandlerMethod, channel: CoreChannel): boolean {
  return channel === 'desktop' ? DESKTOP_METHOD_SET.has(method) : GATEWAY_METHOD_SET.has(method)
}

export interface CoreClientInfo {
  name: string
  version: string
}

export interface CoreInitializeParams {
  protocolVersion: number
  expectedChannel: CoreChannel
  client: CoreClientInfo
}

export interface CoreInitializeResult {
  protocolVersion: number
  instanceId: string
  channel: CoreChannel
  server: CoreClientInfo
  capabilities: {
    events: boolean
  }
  currentEventSeq: number
}

export interface CoreEvent {
  seq: number
  type: string
  payload: unknown
}

export interface CoreEventSubscriptionParams {
  afterSeq: number
}

export interface CoreEventSubscriptionResult {
  subscribed: true
  currentSeq: number
  oldestAvailableSeq: number
  resetRequired: boolean
}

export interface CoreRpcRequest {
  jsonrpc: '2.0'
  id: CoreRpcId
  method: string
  params?: unknown
}

export interface CoreRpcSuccess {
  jsonrpc: '2.0'
  id: CoreRpcId
  result: unknown
}

export interface CoreRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface CoreRpcFailure {
  jsonrpc: '2.0'
  id: CoreRpcId | null
  error: CoreRpcErrorObject
}

export interface CoreRpcNotification {
  jsonrpc: '2.0'
  method: typeof CORE_EVENT_NOTIFICATION
  params: CoreEvent
}

export type CoreRpcMessage = CoreRpcRequest | CoreRpcSuccess | CoreRpcFailure | CoreRpcNotification

export interface CoreRequestContext {
  connectionId: string
  channel: CoreChannel
  client: CoreClientInfo
}

export interface CoreBootstrapResult {
  state: ConsoleState
  stateRevision: string
  snapshot: RuntimeSnapshot
  stateNotice: string | null
  health: CoreHealth
}

export interface CoreConfigResult {
  state: ConsoleState
  stateRevision: string
}

export interface CoreConfigCommitParams {
  expectedRevision: string
  state: ConsoleState
}

export interface CorePreparedAgent {
  agent: AgentConfig
  runtimePid: number | null
  preparation: ActionResult
}

export interface CorePreparedProject {
  agents: CorePreparedAgent[]
  preparationResults: ActionResult[]
}

export interface CoreRemoteMethodMap {
  'remote.health': { params: undefined; result: RemoteHealth }
  'remote.request': { params: { envelope: RemoteDispatchEnvelope }; result: RemoteDispatchResponse }
  'remote.stream.open': {
    params: { envelope: RemoteDispatchEnvelope }
    result: { streamId: string; expiresAt: string }
  }
  'remote.stream.poll': { params: { streamId: string }; result: RemoteEventStreamPollResult }
  'remote.stream.close': { params: { streamId: string }; result: { closed: boolean } }
  'remote.settings.get': { params: undefined; result: RemoteSettingsState }
  'remote.auth.signUp': {
    params: RemoteSignUpInput & { workstationName?: string }
    result: RemoteSettingsState
  }
  'remote.auth.signIn': {
    params: RemoteSignInInput & { workstationName?: string }
    result: RemoteSettingsState
  }
  'remote.auth.signOut': { params: undefined; result: RemoteSettingsState }
  'remote.auth.resendVerification': { params: undefined; result: RemoteSettingsState }
  'remote.auth.requestPasswordReset': { params: { email: string }; result: RemoteSettingsState }
  'remote.auth.completePasswordRecovery': {
    params: RemoteCompletePasswordRecoveryInput
    result: RemoteSettingsState
  }
  'remote.auth.handleCallback': {
    params: {
      callbackUrl: string
      purpose: 'email-confirmation' | 'recovery'
      workstationName?: string
    }
    result: RemoteSettingsState
  }
  'remote.control.enable': { params: undefined; result: RemoteSettingsState }
  'remote.control.disable': { params: undefined; result: RemoteSettingsState }
  'remote.pairing.begin': { params: undefined; result: RemoteSettingsState }
  'remote.pairing.cancel': { params: { pairingId: string }; result: RemoteSettingsState }
  'remote.pairing.decide': {
    params: { pairingId: string; approve: boolean }
    result: RemoteSettingsState
  }
  'remote.device.revoke': { params: { deviceId: string }; result: RemoteSettingsState }
  'remote.device.retrySync': { params: { deviceId: string }; result: RemoteSettingsState }
  'remote.agent.setPermission': { params: RemoteAgentPermissionInput; result: RemoteSettingsState }
  'remote.workstation.rename': { params: { displayName: string }; result: RemoteSettingsState }
  'remote.doctor': { params: undefined; result: RemoteSettingsState }
}

export type CoreRequestHandler = (
  method: CoreHandlerMethod,
  params: unknown,
  context: CoreRequestContext,
) => unknown | Promise<unknown>

export class CoreRpcException extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CoreRpcException'
    this.code = code
    this.data = data
  }
}
