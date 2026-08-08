import net from 'node:net'
import {
  CORE_EVENT_NOTIFICATION,
  CORE_MAX_MESSAGE_BYTES,
  CORE_PROTOCOL_VERSION,
  CORE_RPC_ERROR,
  isCoreHandlerMethod,
  isMethodAllowedForChannel,
  type CoreChannel,
  type CoreEvent,
  type CoreEventSubscriptionResult,
  type CoreHandlerMethod,
  type CoreInitializeResult,
  type CoreRpcFailure,
  type CoreRpcId,
  type CoreRpcRequest,
} from '../../shared/core-protocol'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface CoreClientOptions {
  socketPath: string
  channel: CoreChannel
  clientVersion: string
  clientName?: string
  protocolVersion?: number
  requestTimeoutMs?: number
}

export class CoreRemoteError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CoreRemoteError'
    this.code = code
    this.data = data
  }
}

export class CoreClientTimeoutError extends CoreRemoteError {
  constructor(method: string, timeoutMs: number) {
    super(CORE_RPC_ERROR.REQUEST_TIMEOUT, `Core request ${method} timed out after ${timeoutMs} ms.`)
    this.name = 'CoreClientTimeoutError'
  }
}

export class CoreClientDisconnectedError extends CoreRemoteError {
  constructor(message = 'The Core connection closed before the request completed.') {
    super(CORE_RPC_ERROR.DISCONNECTED, message)
    this.name = 'CoreClientDisconnectedError'
  }
}

export class CoreClientMessageTooLargeError extends CoreRemoteError {
  constructor(direction: 'request' | 'response') {
    super(CORE_RPC_ERROR.MESSAGE_TOO_LARGE, `Core ${direction} exceeds the 1 MiB message limit.`)
    this.name = 'CoreClientMessageTooLargeError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export interface CoreProtocolMismatch {
  supportedVersion: number | null
}

export function readCoreProtocolMismatch(error: unknown): CoreProtocolMismatch | null {
  if (!(error instanceof CoreRemoteError) || error.code !== CORE_RPC_ERROR.PROTOCOL_VERSION_MISMATCH) return null
  const supportedVersion = isRecord(error.data) && Number.isInteger(error.data.supportedVersion)
    ? Number(error.data.supportedVersion)
    : null
  return { supportedVersion }
}

export class CoreClient {
  private readonly options: Required<Pick<CoreClientOptions, 'clientName' | 'protocolVersion' | 'requestTimeoutMs'>> & CoreClientOptions
  private socket: net.Socket | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private nextRequestId = 1
  private pending = new Map<CoreRpcId, PendingRequest>()
  private listeners = new Set<(event: CoreEvent) => void>()
  private connectionListeners = new Set<(connected: boolean) => void>()
  private connectPromise: Promise<CoreInitializeResult> | null = null
  private initialized = false
  private lastEventSeq = 0
  private subscription: CoreEventSubscriptionResult | null = null
  private serverInstanceId: string | null = null

  constructor(options: CoreClientOptions) {
    if (!options.socketPath) throw new Error('A Core socket path is required.')
    if (options.channel !== 'desktop' && options.channel !== 'gateway') throw new Error('A Core channel is required.')
    if (!options.clientVersion.trim()) throw new Error('A Core client version is required.')
    this.options = {
      ...options,
      clientName: options.clientName?.trim() || `agent-console-${options.channel}`,
      protocolVersion: options.protocolVersion ?? CORE_PROTOCOL_VERSION,
      requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? 5_000),
    }
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.initialized)
  }

  get lastEventSequence(): number {
    return this.lastEventSeq
  }

  get subscriptionState(): CoreEventSubscriptionResult | null {
    return this.subscription ? { ...this.subscription } : null
  }

  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  async connect(): Promise<CoreInitializeResult> {
    if (this.connected) {
      return {
        protocolVersion: this.options.protocolVersion,
        instanceId: this.serverInstanceId ?? 'connected',
        channel: this.options.channel,
        server: { name: 'agent-console-core', version: 'connected' },
        capabilities: { events: true },
        currentEventSeq: this.lastEventSeq,
      }
    }
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.establishConnection().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  async request<T = unknown>(method: CoreHandlerMethod, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!isCoreHandlerMethod(method)) {
      throw new CoreRemoteError(CORE_RPC_ERROR.METHOD_NOT_FOUND, `Unknown Core method: ${String(method)}`)
    }
    if (!isMethodAllowedForChannel(method, this.options.channel)) {
      throw new CoreRemoteError(
        CORE_RPC_ERROR.FORBIDDEN_CHANNEL,
        `Method ${method} is not available on the ${this.options.channel} Core channel.`,
      )
    }
    if (!this.connected) throw new CoreClientDisconnectedError('Connect to Core before sending a request.')
    return this.sendRequest(method, params, timeoutMs) as Promise<T>
  }

  disconnect(): void {
    const wasConnected = Boolean(this.socket)
    const socket = this.socket
    this.socket = null
    this.initialized = false
    this.subscription = null
    this.buffer = Buffer.alloc(0)
    this.rejectPending(new CoreClientDisconnectedError('The Core connection was closed by the client.'))
    socket?.destroy()
    if (wasConnected) this.emitConnection(false)
  }

  private async establishConnection(): Promise<CoreInitializeResult> {
    const socket = net.createConnection({ path: this.options.socketPath })
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.initialized = false
    socket.on('data', (chunk: Buffer) => this.consume(socket, chunk))
    socket.on('error', (error) => {
      if (this.socket === socket && !socket.destroyed) socket.destroy(error)
    })
    socket.on('close', () => this.handleDisconnect(socket))

    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off('error', onInitialError)
          resolve()
        }
        const onInitialError = (error: Error) => {
          socket.off('connect', onConnect)
          reject(error)
        }
        socket.once('connect', onConnect)
        socket.once('error', onInitialError)
      })
      const initialized = await this.sendRequest('initialize', {
        protocolVersion: this.options.protocolVersion,
        expectedChannel: this.options.channel,
        client: {
          name: this.options.clientName,
          version: this.options.clientVersion,
        },
      }) as CoreInitializeResult
      if (initialized.protocolVersion !== this.options.protocolVersion) {
        throw new CoreRemoteError(
          CORE_RPC_ERROR.PROTOCOL_VERSION_MISMATCH,
          `Core selected unexpected protocol version ${initialized.protocolVersion}.`,
        )
      }
      if (initialized.channel !== this.options.channel) {
        throw new CoreRemoteError(
          CORE_RPC_ERROR.FORBIDDEN_CHANNEL,
          `Connected to the ${initialized.channel} Core channel instead of ${this.options.channel}.`,
        )
      }
      if (typeof initialized.instanceId !== 'string' || !/^[a-f0-9-]{16,64}$/i.test(initialized.instanceId)) {
        throw new CoreRemoteError(CORE_RPC_ERROR.INVALID_REQUEST, 'Core returned an invalid server instance identifier.')
      }
      if (this.serverInstanceId && this.serverInstanceId !== initialized.instanceId) this.lastEventSeq = 0
      this.serverInstanceId = initialized.instanceId
      this.initialized = true
      if (initialized.capabilities.events) {
        this.subscription = await this.sendRequest('events.subscribe', { afterSeq: this.lastEventSeq }) as CoreEventSubscriptionResult
        if (this.subscription.resetRequired) this.lastEventSeq = this.subscription.currentSeq
      } else {
        this.subscription = null
      }
      this.emitConnection(true)
      return initialized
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null
        this.initialized = false
        this.subscription = null
      }
      socket.destroy()
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private sendRequest(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new CoreClientDisconnectedError())
    const id = this.nextRequestId++
    const request: CoreRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }
    const encoded = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')
    if (encoded.length - 1 > CORE_MAX_MESSAGE_BYTES) {
      return Promise.reject(new CoreClientMessageTooLargeError('request'))
    }

    return new Promise((resolve, reject) => {
      const effectiveTimeout = Math.max(1, timeoutMs)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CoreClientTimeoutError(method, effectiveTimeout))
      }, effectiveTimeout)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.write(encoded, (error) => {
          if (!error) return
          const pending = this.pending.get(id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(id)
          pending.reject(new CoreClientDisconnectedError(error.message))
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private consume(socket: net.Socket, chunk: Buffer): void {
    if (this.socket !== socket) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.socket === socket && !socket.destroyed) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline === -1) {
        if (this.buffer.length > CORE_MAX_MESSAGE_BYTES) {
          const error = new CoreClientMessageTooLargeError('response')
          this.rejectPending(error)
          socket.destroy(error)
        }
        return
      }
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > CORE_MAX_MESSAGE_BYTES) {
        const error = new CoreClientMessageTooLargeError('response')
        this.rejectPending(error)
        socket.destroy(error)
        return
      }
      this.handleLine(line)
    }
  }

  private handleLine(line: Buffer): void {
    let message: unknown
    try {
      message = JSON.parse(line.toString('utf8'))
    } catch {
      const error = new CoreRemoteError(CORE_RPC_ERROR.PARSE_ERROR, 'Core returned invalid JSON.')
      this.rejectPending(error)
      this.socket?.destroy(error)
      return
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') return

    if (message.method === CORE_EVENT_NOTIFICATION && isRecord(message.params)) {
      const seq = message.params.seq
      const type = message.params.type
      if (!Number.isSafeInteger(seq) || Number(seq) <= this.lastEventSeq || typeof type !== 'string') return
      const event: CoreEvent = { seq: Number(seq), type, payload: message.params.payload }
      this.lastEventSeq = event.seq
      for (const listener of this.listeners) listener(event)
      return
    }

    if (typeof message.id !== 'number' && typeof message.id !== 'string') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if ('error' in message && isRecord(message.error)) {
      const failure = message as unknown as CoreRpcFailure
      pending.reject(new CoreRemoteError(
        Number(failure.error.code),
        String(failure.error.message),
        failure.error.data,
      ))
      return
    }
    if ('result' in message) pending.resolve(message.result)
    else pending.reject(new CoreRemoteError(CORE_RPC_ERROR.INVALID_REQUEST, 'Core returned an invalid response.'))
  }

  private handleDisconnect(socket: net.Socket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.initialized = false
    this.subscription = null
    this.buffer = Buffer.alloc(0)
    this.rejectPending(new CoreClientDisconnectedError())
    this.emitConnection(false)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private emitConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected)
  }
}
