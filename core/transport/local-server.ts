import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  CORE_EVENT_NOTIFICATION,
  CORE_HANDLER_METHODS,
  CORE_MAX_MESSAGE_BYTES,
  CORE_PROTOCOL_VERSION,
  CORE_RPC_ERROR,
  CoreRpcException,
  isCoreHandlerMethod,
  type CoreClientInfo,
  type CoreEvent,
  type CoreEventSubscriptionResult,
  type CoreHandlerMethod,
  type CoreInitializeResult,
  type CoreRequestContext,
  type CoreRequestHandler,
  type CoreRpcFailure,
  type CoreRpcId,
  type CoreRpcNotification,
  type CoreRpcRequest,
  type CoreRpcSuccess,
} from '../../shared/core-protocol'

interface ConnectionState {
  id: string
  socket: net.Socket
  buffer: Buffer
  initialized: boolean
  subscribed: boolean
  client: CoreClientInfo | null
  activeRequests: number
  requestWindowStartedAt: number
  requestsInWindow: number
}

export interface LocalCoreServerOptions {
  socketPath: string
  serverVersion: string
  handler: CoreRequestHandler
  serverName?: string
  allowedMethods?: readonly CoreHandlerMethod[]
  maxEventHistory?: number
  onConnectionCount?: (count: number) => void
}

export interface CorePublishOptions {
  replayable?: boolean
}

const MAX_REPLAY_EVENTS_PER_SUBSCRIPTION = 100
const MAX_REPLAY_BYTES_PER_SUBSCRIPTION = 2 * 1024 * 1024
const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function validateClientInfo(value: unknown): CoreClientInfo {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'initialize.client must contain name and version strings.')
  }
  const name = value.name.trim()
  const version = value.version.trim()
  if (!name || !version || name.length > 100 || version.length > 100) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'Client name and version must be between 1 and 100 characters.')
  }
  return { name, version }
}

function parseRequest(value: unknown): CoreRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_REQUEST, 'A JSON-RPC 2.0 request is required.')
  }
  if (typeof value.id !== 'string' && typeof value.id !== 'number') {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_REQUEST, 'Every request must have a string or numeric id.')
  }
  if (typeof value.method !== 'string' || !value.method) {
    throw new CoreRpcException(CORE_RPC_ERROR.INVALID_REQUEST, 'Every request must have a method.')
  }
  return {
    jsonrpc: '2.0',
    id: value.id,
    method: value.method,
    ...('params' in value ? { params: value.params } : {}),
  }
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection({ path: socketPath })
    const timer = setTimeout(() => {
      probe.destroy()
      reject(new Error(`Timed out while checking existing socket ${socketPath}.`))
    }, 250)
    timer.unref()
    probe.once('connect', () => {
      clearTimeout(timer)
      probe.destroy()
      resolve(true)
    })
    probe.once('error', (error) => {
      clearTimeout(timer)
      const code = errorCode(error)
      if (code === 'ECONNREFUSED' || code === 'ENOENT') resolve(false)
      else reject(error)
    })
  })
}

export class LocalCoreServer {
  private readonly instanceId = randomUUID()
  private readonly socketPath: string
  private readonly serverName: string
  private readonly serverVersion: string
  private readonly handler: CoreRequestHandler
  private readonly allowedMethods: ReadonlySet<CoreHandlerMethod>
  private readonly maxEventHistory: number
  private readonly onConnectionCount: (count: number) => void
  private readonly connections = new Set<ConnectionState>()
  private readonly server: net.Server
  private eventHistory: CoreEvent[] = []
  private eventSequence = 0
  private ownsSocket = false

  constructor(options: LocalCoreServerOptions) {
    if (!path.isAbsolute(options.socketPath)) throw new Error('The Core socket path must be absolute.')
    if (!options.serverVersion.trim()) throw new Error('A server version is required.')
    const requestedMethods = options.allowedMethods ?? CORE_HANDLER_METHODS
    if (requestedMethods.some((method) => !isCoreHandlerMethod(method))) {
      throw new Error('The Core server method allowlist contains an unknown method.')
    }
    this.socketPath = options.socketPath
    this.serverName = options.serverName?.trim() || 'agent-console-core'
    this.serverVersion = options.serverVersion.trim()
    this.handler = options.handler
    this.allowedMethods = new Set(requestedMethods)
    this.maxEventHistory = Math.max(1, Math.min(10_000, options.maxEventHistory ?? 1_000))
    this.onConnectionCount = options.onConnectionCount ?? (() => undefined)
    this.server = net.createServer((socket) => this.accept(socket))
  }

  get address(): string | null {
    const address = this.server.address()
    return typeof address === 'string' ? address : null
  }

  get currentEventSeq(): number {
    return this.eventSequence
  }

  async start(): Promise<void> {
    if (this.server.listening) return
    await this.prepareSocketDirectory()
    await this.removeStaleSocket()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.socketPath)
    })
    this.ownsSocket = true
    await fs.chmod(this.socketPath, 0o600)
  }

  publish(type: string, payload: unknown, options: CorePublishOptions = {}): CoreEvent {
    const normalizedType = type.trim()
    if (!normalizedType || normalizedType.length > 160) throw new Error('Core event type must be between 1 and 160 characters.')
    const event: CoreEvent = { seq: this.eventSequence + 1, type: normalizedType, payload }
    const notification: CoreRpcNotification = {
      jsonrpc: '2.0',
      method: CORE_EVENT_NOTIFICATION,
      params: event,
    }
    if (byteLength(notification) > CORE_MAX_MESSAGE_BYTES) {
      throw new CoreRpcException(CORE_RPC_ERROR.MESSAGE_TOO_LARGE, 'Core event exceeds the 1 MiB message limit.')
    }
    this.eventSequence = event.seq
    if (options.replayable !== false) {
      this.eventHistory.push(event)
      if (this.eventHistory.length > this.maxEventHistory) {
        this.eventHistory = this.eventHistory.slice(-this.maxEventHistory)
      }
    }
    for (const connection of this.connections) {
      if (connection.initialized && connection.subscribed) this.write(connection.socket, notification)
    }
    return event
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.destroy()
    this.connections.clear()
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve())
      })
    }
    if (this.ownsSocket) {
      await fs.unlink(this.socketPath).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error
      })
      this.ownsSocket = false
    }
  }

  private async prepareSocketDirectory(): Promise<void> {
    const directory = path.dirname(this.socketPath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Core socket directory must be a real directory: ${directory}`)
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`Core socket directory is not owned by the current user: ${directory}`)
    }
    await fs.chmod(directory, 0o700)
  }

  private async removeStaleSocket(): Promise<void> {
    let stat
    try {
      stat = await fs.lstat(this.socketPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path: ${this.socketPath}`)
    if (await socketIsLive(this.socketPath)) {
      const error = new Error(`Another Core server is already listening at ${this.socketPath}`) as NodeJS.ErrnoException
      error.code = 'EADDRINUSE'
      throw error
    }
    await fs.unlink(this.socketPath)
  }

  private accept(socket: net.Socket): void {
    const connection: ConnectionState = {
      id: randomUUID(),
      socket,
      buffer: Buffer.alloc(0),
      initialized: false,
      subscribed: false,
      client: null,
      activeRequests: 0,
      requestWindowStartedAt: Date.now(),
      requestsInWindow: 0,
    }
    this.connections.add(connection)
    this.onConnectionCount(this.connections.size)
    socket.on('data', (chunk: Buffer) => this.consume(connection, chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      this.connections.delete(connection)
      this.onConnectionCount(this.connections.size)
    })
  }

  private consume(connection: ConnectionState, chunk: Buffer): void {
    connection.buffer = connection.buffer.length
      ? Buffer.concat([connection.buffer, chunk])
      : chunk

    while (!connection.socket.destroyed) {
      const newline = connection.buffer.indexOf(0x0a)
      if (newline === -1) {
        if (connection.buffer.length > CORE_MAX_MESSAGE_BYTES) this.rejectOversized(connection)
        return
      }
      const line = connection.buffer.subarray(0, newline)
      connection.buffer = connection.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > CORE_MAX_MESSAGE_BYTES) {
        this.rejectOversized(connection)
        return
      }
      void this.handleLine(connection, line)
    }
  }

  private async handleLine(connection: ConnectionState, line: Buffer): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8'))
    } catch {
      this.failure(connection.socket, null, CORE_RPC_ERROR.PARSE_ERROR, 'Invalid JSON.')
      return
    }

    let request: CoreRpcRequest
    try {
      request = parseRequest(parsed)
    } catch (error) {
      const exception = error instanceof CoreRpcException
        ? error
        : new CoreRpcException(CORE_RPC_ERROR.INVALID_REQUEST, 'Invalid JSON-RPC request.')
      this.failure(connection.socket, null, exception.code, exception.message, exception.data)
      return
    }

    let reservedRequestSlot = false
    try {
      this.checkRequestBudget(connection)
      connection.activeRequests += 1
      reservedRequestSlot = true
      let result: unknown
      if (request.method === 'initialize') {
        result = this.initialize(connection, request.params)
      } else {
        if (!connection.initialized || !connection.client) {
          throw new CoreRpcException(CORE_RPC_ERROR.NOT_INITIALIZED, 'Call initialize before any other method.')
        }
        if (request.method === 'events.subscribe') {
          result = this.subscribe(connection, request.params)
        } else {
          if (!isCoreHandlerMethod(request.method) || !this.allowedMethods.has(request.method)) {
            throw new CoreRpcException(CORE_RPC_ERROR.METHOD_NOT_FOUND, `Method is not allowed: ${request.method}`)
          }
          const context: CoreRequestContext = {
            connectionId: connection.id,
            client: { ...connection.client },
          }
          result = await this.handler(request.method, request.params, context)
        }
      }
      const response: CoreRpcSuccess = { jsonrpc: '2.0', id: request.id, result: result ?? null }
      try {
        this.write(connection.socket, response)
      } catch (error) {
        if (error instanceof CoreRpcException && error.code === CORE_RPC_ERROR.MESSAGE_TOO_LARGE) {
          this.failure(connection.socket, request.id, error.code, error.message)
          return
        }
        throw error
      }
    } catch (error) {
      const exception = error instanceof CoreRpcException
        ? error
        : new CoreRpcException(CORE_RPC_ERROR.INTERNAL_ERROR, 'Core request failed.')
      this.failure(connection.socket, request.id, exception.code, exception.message, exception.data)
    } finally {
      if (reservedRequestSlot) connection.activeRequests = Math.max(0, connection.activeRequests - 1)
    }
  }

  private initialize(connection: ConnectionState, params: unknown): CoreInitializeResult {
    if (connection.initialized) {
      throw new CoreRpcException(CORE_RPC_ERROR.ALREADY_INITIALIZED, 'This connection is already initialized.')
    }
    if (!isRecord(params) || !Number.isInteger(params.protocolVersion)) {
      throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'initialize.protocolVersion must be an integer.')
    }
    if (params.protocolVersion !== CORE_PROTOCOL_VERSION) {
      throw new CoreRpcException(
        CORE_RPC_ERROR.PROTOCOL_VERSION_MISMATCH,
        `Unsupported Core protocol version ${String(params.protocolVersion)}.`,
        { supportedVersion: CORE_PROTOCOL_VERSION },
      )
    }
    connection.client = validateClientInfo(params.client)
    connection.initialized = true
    return {
      protocolVersion: CORE_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      server: { name: this.serverName, version: this.serverVersion },
      capabilities: { events: true },
      currentEventSeq: this.eventSequence,
    }
  }

  private subscribe(connection: ConnectionState, params: unknown): CoreEventSubscriptionResult {
    if (!isRecord(params) || !Number.isSafeInteger(params.afterSeq) || Number(params.afterSeq) < 0) {
      throw new CoreRpcException(CORE_RPC_ERROR.INVALID_PARAMS, 'events.subscribe.afterSeq must be a non-negative integer.')
    }
    const afterSeq = Number(params.afterSeq)
    const oldestAvailableSeq = this.eventHistory[0]?.seq ?? this.eventSequence + 1
    const replay = this.eventHistory.filter((event) => event.seq > afterSeq)
    const replayBytes = replay.reduce((total, event) => total + byteLength({
      jsonrpc: '2.0',
      method: CORE_EVENT_NOTIFICATION,
      params: event,
    }), 0)
    const resetRequired = afterSeq > this.eventSequence
      || afterSeq < oldestAvailableSeq - 1
      || replay.length > MAX_REPLAY_EVENTS_PER_SUBSCRIPTION
      || replayBytes > MAX_REPLAY_BYTES_PER_SUBSCRIPTION
    connection.subscribed = true
    if (!resetRequired) {
      for (const event of replay) {
        this.write(connection.socket, {
          jsonrpc: '2.0',
          method: CORE_EVENT_NOTIFICATION,
          params: event,
        } satisfies CoreRpcNotification)
      }
    }
    return {
      subscribed: true,
      currentSeq: this.eventSequence,
      oldestAvailableSeq,
      resetRequired,
    }
  }

  private write(socket: net.Socket, message: CoreRpcSuccess | CoreRpcFailure | CoreRpcNotification): void {
    const encoded = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
    if (encoded.length - 1 > CORE_MAX_MESSAGE_BYTES) {
      throw new CoreRpcException(CORE_RPC_ERROR.MESSAGE_TOO_LARGE, 'Core response exceeds the 1 MiB message limit.')
    }
    if (socket.destroyed) return
    if (socket.writableLength + encoded.length > MAX_SOCKET_BUFFER_BYTES) {
      socket.destroy(new Error('Core disconnected a slow local client before buffering more private data.'))
      return
    }
    socket.write(encoded)
  }

  private failure(socket: net.Socket, id: CoreRpcId | null, code: number, message: string, data?: unknown): void {
    const response: CoreRpcFailure = {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }
    try {
      this.write(socket, response)
    } catch {
      socket.destroy()
    }
  }

  private rejectOversized(connection: ConnectionState): void {
    connection.buffer = Buffer.alloc(0)
    this.failure(
      connection.socket,
      null,
      CORE_RPC_ERROR.MESSAGE_TOO_LARGE,
      'Core request exceeds the 1 MiB message limit.',
    )
    connection.socket.end()
  }

  private checkRequestBudget(connection: ConnectionState): void {
    const now = Date.now()
    if (now - connection.requestWindowStartedAt >= 10_000) {
      connection.requestWindowStartedAt = now
      connection.requestsInWindow = 0
    }
    connection.requestsInWindow += 1
    if (connection.requestsInWindow > 500 || connection.activeRequests >= 32) {
      throw new CoreRpcException(
        CORE_RPC_ERROR.TOO_MANY_REQUESTS,
        'This local Core client is sending too many concurrent requests.',
      )
    }
  }
}
