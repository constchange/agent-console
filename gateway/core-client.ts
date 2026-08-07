import type {
  GatewayEvent,
  RemoteDispatchEnvelope,
  RemoteDispatchResponse,
  RemoteEventStreamPollResult,
} from '../shared/remote-validation'
import { RemoteSecurityError } from '../core/remote/authorization-service'
import type { CoreRemoteStreamOpenResult } from '../core/remote/request-router'
import type { GatewayDispatchContext, GatewayRequestDispatcher } from './http-server'

export const GATEWAY_BRIDGE_METHODS = [
  'remote.request',
  'remote.stream.open',
  'remote.stream.poll',
  'remote.stream.close',
] as const

export type GatewayBridgeMethod = typeof GATEWAY_BRIDGE_METHODS[number]

/**
 * Implemented by the existing Unix JSON-RPC client after the four bridge
 * methods are added to the gateway-only Core allowlist. All calls for a stream
 * must stay on the same Core connection; Core binds the opaque streamId to its
 * connectionId and rejects use from another Gateway process.
 */
export interface GatewayBridgeTransport {
  connect(): Promise<void>
  request<T>(method: GatewayBridgeMethod | 'remote.health', params: unknown, timeoutMs?: number): Promise<T>
  disconnect(): void
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    timer.unref()
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * The localhost Gateway owns no Supabase client, refresh token, RemoteStore or
 * device key. It only forwards a bounded signed envelope to the Core bridge.
 */
export class GatewayCoreClient implements GatewayRequestDispatcher {
  constructor(private readonly transport: GatewayBridgeTransport) {}

  async connect(): Promise<void> {
    await this.transport.connect()
  }

  async health(): Promise<boolean> {
    try {
      const result = await this.transport.request<{ online?: unknown }>('remote.health', undefined, 3_000)
      return result.online === true
    } catch {
      return false
    }
  }

  async dispatch(envelope: RemoteDispatchEnvelope, context: GatewayDispatchContext): Promise<RemoteDispatchResponse> {
    if (context.signal.aborted) throw new RemoteSecurityError(499, 'CLIENT_CLOSED', 'Client closed the request.')
    try {
      return await this.transport.request<RemoteDispatchResponse>('remote.request', { envelope }, 20_000)
    } catch {
      throw new RemoteSecurityError(503, 'CORE_UNAVAILABLE', 'Local Core is unavailable.')
    }
  }

  async openEvents(
    envelope: RemoteDispatchEnvelope,
    context: GatewayDispatchContext,
  ): Promise<AsyncIterable<GatewayEvent>> {
    if (context.signal.aborted) throw new RemoteSecurityError(499, 'CLIENT_CLOSED', 'Client closed the request.')
    let opened: CoreRemoteStreamOpenResult
    try {
      opened = await this.transport.request<CoreRemoteStreamOpenResult>('remote.stream.open', { envelope }, 20_000)
    } catch {
      // The HTTP server has not flushed SSE headers yet, so authorization and
      // Core availability failures still produce an ordinary JSON response.
      throw new RemoteSecurityError(403, 'STREAM_NOT_AUTHORIZED', 'Event stream is not authorized.')
    }
    const transport = this.transport
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<GatewayEvent> {
        try {
          while (!context.signal.aborted && Date.parse(opened.expiresAt) > Date.now()) {
            const result = await transport.request<RemoteEventStreamPollResult>(
              'remote.stream.poll',
              { streamId: opened.streamId },
              20_000,
            )
            if (result.closed) break
            for (const event of result.events) yield event
            if (result.events.length === 0) await wait(1_000, context.signal)
          }
        } finally {
          await transport.request('remote.stream.close', { streamId: opened.streamId }, 5_000).catch(() => undefined)
        }
      },
    }
  }

  close(): void {
    this.transport.disconnect()
  }
}
