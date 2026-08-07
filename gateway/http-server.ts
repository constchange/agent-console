import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import {
  REMOTE_MAX_BODY_BYTES,
  REMOTE_MAX_HEADER_BYTES,
  REMOTE_PROTOCOL_VERSION,
  type GatewayEvent,
  type RemoteDispatchEnvelope,
  type RemoteDispatchResponse,
  validateGatewayEvent,
  validateRemoteDispatchEnvelope,
} from '../shared/remote-validation'
import { RemoteSecurityError } from '../core/remote/authorization-service'

const SENSITIVE_REQUEST_HEADERS = [
  'authorization',
  'content-length',
  'content-type',
  'transfer-encoding',
  'x-ac-protocol',
  'x-ac-workstation-id',
  'x-ac-device-id',
  'x-ac-request-id',
  'x-ac-timestamp',
  'x-ac-nonce',
  'x-ac-body-sha256',
  'x-ac-signature',
] as const

const SSE_MAX_DURATION_MS = 5 * 60 * 1_000
const SSE_KEEPALIVE_MS = 15_000

export interface GatewayDispatchContext {
  signal: AbortSignal
}

export interface GatewayRequestDispatcher {
  /** A minimal Core reachability probe used only by the public health route. */
  health(): Promise<boolean>
  dispatch(envelope: RemoteDispatchEnvelope, context: GatewayDispatchContext): Promise<RemoteDispatchResponse>
  openEvents(envelope: RemoteDispatchEnvelope, context: GatewayDispatchContext): Promise<AsyncIterable<GatewayEvent>>
}

export interface GatewayHttpServerOptions {
  port: number
  dispatcher: GatewayRequestDispatcher
  host?: '127.0.0.1'
  maxBodyBytes?: number
  maxConcurrentRequests?: number
  requestTimeoutMs?: number
}

interface RateWindow {
  startedAt: number
  count: number
  lastSeenAt: number
}

interface RouteInfo {
  kind: 'health' | 'read' | 'write' | 'approval' | 'pairing' | 'events'
}

function hasOnlyEventQuery(url: URL): boolean {
  const allowed = new Set(['afterSeq', 'limit', 'taskId', 'streamId'])
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return false
  }
  return true
}

class FixedWindowLimiter {
  private readonly windows = new Map<string, RateWindow>()

  take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (this.windows.size > 2_048) {
      for (const [candidate, state] of this.windows) {
        if (now - state.lastSeenAt > 2 * windowMs) this.windows.delete(candidate)
      }
      if (this.windows.size > 2_048) return false
    }
    const existing = this.windows.get(key)
    if (!existing || now - existing.startedAt >= windowMs) {
      this.windows.set(key, { startedAt: now, count: 1, lastSeenAt: now })
      return true
    }
    existing.lastSeenAt = now
    existing.count += 1
    return existing.count <= limit
  }
}

function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1])
  }
  return values
}

function singleHeader(request: IncomingMessage, name: string): string {
  const values = headerValues(request, name)
  if (values.length !== 1) throw new RemoteSecurityError(400, 'INVALID_HEADERS', 'Request headers are invalid.')
  return values[0]
}

function rejectDuplicateSensitiveHeaders(request: IncomingMessage): void {
  const headerBytes = request.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value, 'utf8') + 2, 0)
  if (headerBytes > REMOTE_MAX_HEADER_BYTES) {
    throw new RemoteSecurityError(431, 'HEADERS_TOO_LARGE', 'Request headers are too large.')
  }
  for (const name of SENSITIVE_REQUEST_HEADERS) {
    if (headerValues(request, name).length > 1) {
      throw new RemoteSecurityError(400, 'DUPLICATE_HEADER', 'Request contains duplicate security headers.')
    }
  }
}

function routeInfo(method: string, target: string): RouteInfo | null {
  let url: URL
  try {
    url = new URL(target, 'http://127.0.0.1')
  } catch {
    return null
  }
  const path = url.pathname
  if (method === 'GET' && path === '/healthz' && !url.search) return { kind: 'health' }
  if (method === 'POST' && /^\/v1\/pairings\/[0-9a-f-]{36}\/claim$/i.test(path) && !url.search) return { kind: 'pairing' }
  if (method === 'GET' && path === '/v1/events/stream' && hasOnlyEventQuery(url)) return { kind: 'events' }
  if (method === 'GET' && (path === '/v1/dashboard'
    || /^\/v1\/agents\/[a-zA-Z0-9_.:-]{1,160}$/.test(path)
    || /^\/v1\/tasks\/[a-zA-Z0-9_.:-]{1,160}$/.test(path)) && !url.search) return { kind: 'read' }
  if (method === 'GET' && path === '/v1/events' && hasOnlyEventQuery(url)) return { kind: 'read' }
  if (method === 'POST' && /^\/v1\/tasks\/[a-zA-Z0-9_.:-]{1,160}\/(?:messages|interrupt)$/.test(path) && !url.search) return { kind: 'write' }
  if (method === 'POST' && /^\/v1\/approvals\/[a-zA-Z0-9_.:-]{1,160}\/decision$/.test(path) && !url.search) return { kind: 'approval' }
  return null
}

function statusBody(status: number, code: string, message: string): RemoteDispatchResponse {
  return { status, body: { error: { code, message } } }
}

async function readBody(request: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const contentLength = request.headers['content-length']
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) throw new RemoteSecurityError(400, 'INVALID_CONTENT_LENGTH', 'Content length is invalid.')
    if (Number(contentLength) > limit) throw new RemoteSecurityError(413, 'BODY_TOO_LARGE', 'Request body is too large.')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    if (signal.aborted) throw new RemoteSecurityError(499, 'CLIENT_CLOSED', 'Client closed the request.')
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limit) throw new RemoteSecurityError(413, 'BODY_TOO_LARGE', 'Request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes)
}

function signedEnvelope(request: IncomingMessage, body: Buffer): RemoteDispatchEnvelope {
  const envelope: RemoteDispatchEnvelope = {
    method: request.method ?? '',
    target: request.url ?? '',
    headers: {
      authorization: singleHeader(request, 'authorization'),
      protocol: singleHeader(request, 'x-ac-protocol'),
      workstationId: singleHeader(request, 'x-ac-workstation-id'),
      deviceId: singleHeader(request, 'x-ac-device-id'),
      requestId: singleHeader(request, 'x-ac-request-id'),
      timestamp: singleHeader(request, 'x-ac-timestamp'),
      nonce: singleHeader(request, 'x-ac-nonce'),
      bodySha256: singleHeader(request, 'x-ac-body-sha256'),
      signature: singleHeader(request, 'x-ac-signature'),
    },
    bodyBase64: body.toString('base64'),
  }
  return validateRemoteDispatchEnvelope(envelope)
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      response.off('drain', done)
      response.off('close', done)
      response.off('error', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    response.once('drain', done)
    response.once('close', done)
    response.once('error', done)
    signal.addEventListener('abort', done, { once: true })
  })
}

function sendJson(response: ServerResponse, value: RemoteDispatchResponse): void {
  if (response.headersSent || response.destroyed) return
  const status = Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : 500
  const body = Buffer.from(JSON.stringify(value.body ?? null), 'utf8')
  if (body.length > 1024 * 1024) {
    sendJson(response, statusBody(500, 'RESPONSE_TOO_LARGE', 'Gateway response is too large.'))
    return
  }
  response.statusCode = status
  setSecurityHeaders(response)
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', String(body.length))
  if (value.headers?.['retry-after'] && /^\d{1,5}$/.test(value.headers['retry-after'])) {
    response.setHeader('Retry-After', value.headers['retry-after'])
  }
  response.end(body)
}

function publicError(error: unknown): RemoteDispatchResponse {
  if (error instanceof RemoteSecurityError) return statusBody(error.status, error.code, error.message)
  return statusBody(500, 'GATEWAY_ERROR', 'Gateway could not complete the request safely.')
}

export class GatewayHttpServer {
  private readonly server: http.Server
  private readonly dispatcher: GatewayRequestDispatcher
  private readonly host: '127.0.0.1'
  private readonly port: number
  private readonly maxBodyBytes: number
  private readonly maxConcurrentRequests: number
  private readonly limiter = new FixedWindowLimiter()
  private readonly sockets = new Set<net.Socket>()
  private readonly activeControllers = new Set<AbortController>()
  private activeDispatches = 0
  private activeStreams = 0
  private activeBodyReads = 0
  private activeHealthProbes = 0
  private closing = false

  constructor(options: GatewayHttpServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('Gateway port is invalid.')
    if (options.host && options.host !== '127.0.0.1') throw new Error('Gateway may only bind to 127.0.0.1.')
    this.port = options.port
    this.host = '127.0.0.1'
    this.dispatcher = options.dispatcher
    this.maxBodyBytes = Math.max(1_024, Math.min(REMOTE_MAX_BODY_BYTES, options.maxBodyBytes ?? REMOTE_MAX_BODY_BYTES))
    this.maxConcurrentRequests = Math.max(1, Math.min(128, options.maxConcurrentRequests ?? 32))
    this.server = http.createServer({
      maxHeaderSize: REMOTE_MAX_HEADER_BYTES,
      requireHostHeader: true,
      requestTimeout: Math.max(1_000, options.requestTimeoutMs ?? 15_000),
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
    }, (request, response) => {
      void this.handle(request, response)
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    this.server.maxConnections = 128
    this.server.maxRequestsPerSocket = 100
  }

  get address(): { host: '127.0.0.1'; port: number } | null {
    const address = this.server.address()
    return address && typeof address === 'object'
      ? { host: '127.0.0.1', port: address.port }
      : null
  }

  async start(): Promise<{ host: '127.0.0.1'; port: number }> {
    if (this.server.listening) return this.address!
    if (this.closing) throw new Error('Gateway server is closing.')
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
      this.server.listen(this.port, this.host)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string' || address.address !== this.host) {
      await this.close()
      throw new Error('Gateway did not bind to the required IPv4 loopback address.')
    }
    return { host: this.host, port: address.port }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const controller of this.activeControllers) controller.abort()
    if (this.server.listening) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of this.sockets) socket.destroy()
          resolve()
        }, 2_000)
        timer.unref()
        this.server.close(() => {
          clearTimeout(timer)
          resolve()
        })
        this.server.closeIdleConnections()
      })
    }
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    this.activeControllers.add(controller)
    let hasDispatchSlot = false
    let hasStreamSlot = false
    let hasBodyReadSlot = false
    try {
      if (this.closing) throw new RemoteSecurityError(503, 'GATEWAY_CLOSING', 'Gateway is restarting.')
      rejectDuplicateSensitiveHeaders(request)
      const method = request.method ?? ''
      const target = request.url ?? ''
      const route = routeInfo(method, target)
      if (!route) throw new RemoteSecurityError(404, 'NOT_FOUND', 'Gateway route was not found.')
      if (route.kind === 'health') {
        const hasBody = request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined
        if (hasBody) throw new RemoteSecurityError(400, 'UNEXPECTED_BODY', 'Health check does not accept a request body.')
        if (!this.limiter.take('health', 60, 60_000) || this.activeHealthProbes >= 4) {
          throw new RemoteSecurityError(429, 'TOO_MANY_REQUESTS', 'Health check limit was reached.')
        }
        this.activeHealthProbes += 1
        try {
          const healthy = await this.dispatcher.health()
          sendJson(response, healthy
            ? { status: 200, body: { ok: true, protocolVersion: REMOTE_PROTOCOL_VERSION } }
            : { status: 503, body: { ok: false, protocolVersion: REMOTE_PROTOCOL_VERSION } })
        } finally {
          this.activeHealthProbes = Math.max(0, this.activeHealthProbes - 1)
        }
        return
      }

      const isPost = method === 'POST'
      if (isPost) {
        const contentType = singleHeader(request, 'content-type').toLowerCase().replace(/\s/g, '')
        if (contentType !== 'application/json' && contentType !== 'application/json;charset=utf-8') {
          throw new RemoteSecurityError(415, 'CONTENT_TYPE_REQUIRED', 'POST requests require JSON.')
        }
        const maxBodyReads = Math.max(1, Math.min(8, Math.floor(this.maxConcurrentRequests / 2)))
        if (this.activeBodyReads >= maxBodyReads) {
          throw new RemoteSecurityError(429, 'TOO_MANY_REQUESTS', 'Too many request bodies are arriving.')
        }
        this.activeBodyReads += 1
        hasBodyReadSlot = true
      } else if (request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined) {
        throw new RemoteSecurityError(400, 'UNEXPECTED_BODY', 'GET request does not accept a body.')
      }
      const body = isPost ? await readBody(request, route.kind === 'pairing' ? 16 * 1024 : this.maxBodyBytes, controller.signal) : Buffer.alloc(0)
      if (hasBodyReadSlot) {
        this.activeBodyReads = Math.max(0, this.activeBodyReads - 1)
        hasBodyReadSlot = false
      }
      let envelope: RemoteDispatchEnvelope
      try {
        envelope = signedEnvelope(request, body)
      } catch {
        throw new RemoteSecurityError(400, 'INVALID_HEADERS', 'Signed request metadata is invalid.')
      }
      const maxDispatches = Math.max(1, Math.min(8, this.maxConcurrentRequests))
      if (this.activeDispatches >= maxDispatches) {
        throw new RemoteSecurityError(429, 'TOO_MANY_REQUESTS', 'Too many signed request candidates are awaiting Core authorization.')
      }
      this.activeDispatches += 1
      hasDispatchSlot = true
      if (route.kind === 'events') {
        if (this.activeStreams >= this.maxConcurrentRequests) {
          throw new RemoteSecurityError(429, 'TOO_MANY_REQUESTS', 'Too many authenticated event streams are active.')
        }
        this.activeStreams += 1
        hasStreamSlot = true
        const events = await this.dispatcher.openEvents(envelope, { signal: controller.signal })
        this.activeDispatches = Math.max(0, this.activeDispatches - 1)
        hasDispatchSlot = false
        await this.streamEvents(response, events, controller)
        return
      }
      sendJson(response, await this.dispatcher.dispatch(envelope, { signal: controller.signal }))
    } catch (error) {
      if (!response.headersSent) {
        const failure = publicError(error)
        if (failure.status === 429) failure.headers = { 'retry-after': '60' }
        sendJson(response, failure)
      } else if (!response.destroyed) {
        response.destroy()
      }
    } finally {
      request.off('aborted', abort)
      response.off('close', abort)
      this.activeControllers.delete(controller)
      if (hasBodyReadSlot) this.activeBodyReads = Math.max(0, this.activeBodyReads - 1)
      if (hasDispatchSlot) this.activeDispatches = Math.max(0, this.activeDispatches - 1)
      if (hasStreamSlot) this.activeStreams = Math.max(0, this.activeStreams - 1)
    }
  }

  private async streamEvents(
    response: ServerResponse,
    events: AsyncIterable<GatewayEvent>,
    controller: AbortController,
  ): Promise<void> {
    response.statusCode = 200
    setSecurityHeaders(response)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()
    const lifetime = setTimeout(() => controller.abort(), SSE_MAX_DURATION_MS)
    lifetime.unref()
    const keepalive = setInterval(() => {
      if (!controller.signal.aborted && !response.destroyed) response.write(': keepalive\n\n')
    }, SSE_KEEPALIVE_MS)
    keepalive.unref()
    try {
      for await (const eventValue of events) {
        if (controller.signal.aborted || response.destroyed) break
        const event = validateGatewayEvent(eventValue)
        const payload = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        if (Buffer.byteLength(payload, 'utf8') > 64 * 1024) throw new Error('Gateway event is too large.')
        if (!response.write(payload)) await waitForDrain(response, controller.signal)
      }
    } finally {
      clearTimeout(lifetime)
      clearInterval(keepalive)
      if (!response.destroyed) response.end()
    }
  }
}
