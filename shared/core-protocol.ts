import type {
  ActionResult,
  AgentConfig,
  ConsoleState,
  CoreHealth,
  RemoteSafeSnapshot,
  RuntimeSnapshot,
} from './types'

export const CORE_PROTOCOL_VERSION = 1
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
} as const

export type CoreRpcErrorCode = typeof CORE_RPC_ERROR[keyof typeof CORE_RPC_ERROR]
export type CoreRpcId = string | number

export const CORE_HANDLER_METHODS = [
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
  'remote.snapshot',
] as const

export type CoreHandlerMethod = typeof CORE_HANDLER_METHODS[number]
export type CoreBuiltinMethod = 'initialize' | 'events.subscribe'
export type CoreRpcMethod = CoreBuiltinMethod | CoreHandlerMethod

const HANDLER_METHOD_SET = new Set<string>(CORE_HANDLER_METHODS)

export function isCoreHandlerMethod(value: unknown): value is CoreHandlerMethod {
  return typeof value === 'string' && HANDLER_METHOD_SET.has(value)
}

export interface CoreClientInfo {
  name: string
  version: string
}

export interface CoreInitializeParams {
  protocolVersion: number
  client: CoreClientInfo
}

export interface CoreInitializeResult {
  protocolVersion: number
  instanceId: string
  server: CoreClientInfo
  capabilities: {
    events: true
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

export interface CoreRemoteSnapshotResult {
  snapshot: RemoteSafeSnapshot
  gatewayEnabled: false
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
