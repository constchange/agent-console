import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayHttpServer, type GatewayRequestDispatcher } from '../gateway/http-server'
import { RemoteSecurityError } from '../core/remote/authorization-service'
import type { RemoteDispatchEnvelope } from '../shared/remote-validation'

const servers: GatewayHttpServer[] = []

function headers(body = Buffer.alloc(0), deviceId = '22222222-2222-4222-8222-222222222222'): Record<string, string> {
  return {
    authorization: 'Bearer header.payload.signature',
    'x-ac-protocol': '1',
    'x-ac-workstation-id': '11111111-1111-4111-8111-111111111111',
    'x-ac-device-id': deviceId,
    'x-ac-request-id': randomUUID(),
    'x-ac-timestamp': String(Math.floor(Date.now() / 1_000)),
    'x-ac-nonce': randomBytes(16).toString('base64url'),
    'x-ac-body-sha256': createHash('sha256').update(body).digest('base64url'),
    'x-ac-signature': 'A'.repeat(86),
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('localhost HTTP Gateway', () => {
  it('binds only IPv4 loopback, exposes minimal healthz and forwards bounded signed envelopes', async () => {
    let received: RemoteDispatchEnvelope | null = null
    const dispatcher: GatewayRequestDispatcher = {
      health: async () => true,
      dispatch: async (envelope) => {
        received = envelope
        return { status: 200, body: { ok: true } }
      },
      openEvents: async () => ({ async *[Symbol.asyncIterator]() {} }),
    }
    const server = new GatewayHttpServer({ port: 0, dispatcher })
    servers.push(server)
    const address = await server.start()
    expect(address.host).toBe('127.0.0.1')

    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`)
    expect(await health.json()).toEqual({ ok: true, protocolVersion: 1 })
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect((await fetch(`http://127.0.0.1:${address.port}/v1/health`)).status).toBe(404)

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/dashboard`, { headers: headers() })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(received).toMatchObject({ method: 'GET', target: '/v1/dashboard' })

    expect((await fetch(`http://127.0.0.1:${address.port}/v1/dashboard?unused=1`, { headers: headers() })).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${address.port}/v1/events?unused=1`, { headers: headers() })).status).toBe(404)
  })

  it('returns JSON authorization failure before flushing SSE headers', async () => {
    const dispatcher: GatewayRequestDispatcher = {
      health: async () => true,
      dispatch: async () => ({ status: 200, body: {} }),
      openEvents: async () => {
        throw new RemoteSecurityError(403, 'DENIED', 'Event stream is not authorized.')
      },
    }
    const server = new GatewayHttpServer({ port: 0, dispatcher })
    servers.push(server)
    const address = await server.start()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events/stream?afterSeq=0`, { headers: headers() })
    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: { code: 'DENIED', message: 'Event stream is not authorized.' } })
  })

  it('reports the Gateway unhealthy when its private Core bridge is unavailable', async () => {
    const dispatcher: GatewayRequestDispatcher = {
      health: async () => false,
      dispatch: async () => ({ status: 503, body: {} }),
      openEvents: async () => ({ async *[Symbol.asyncIterator]() {} }),
    }
    const server = new GatewayHttpServer({ port: 0, dispatcher })
    servers.push(server)
    const address = await server.start()
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, protocolVersion: 1 })
  })

  it('rejects oversized JSON before dispatch and never enables CORS', async () => {
    let calls = 0
    const dispatcher: GatewayRequestDispatcher = {
      health: async () => true,
      dispatch: async () => {
        calls += 1
        return { status: 200, body: {} }
      },
      openEvents: async () => ({ async *[Symbol.asyncIterator]() {} }),
    }
    const server = new GatewayHttpServer({ port: 0, dispatcher, maxBodyBytes: 1_024 })
    servers.push(server)
    const address = await server.start()
    const body = Buffer.from(JSON.stringify({ message: 'x'.repeat(2_000), expectedTaskVersion: 1 }))
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/tasks/task-1/messages`, {
      method: 'POST',
      headers: { ...headers(body), 'content-type': 'application/json' },
      body,
    })
    expect(response.status).toBe(413)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(calls).toBe(0)
  })

  it('does not let unverified device IDs poison a persistent device rate bucket', async () => {
    const dispatcher: GatewayRequestDispatcher = {
      health: async () => true,
      dispatch: async () => ({ status: 200, body: { ok: true } }),
      openEvents: async () => ({ async *[Symbol.asyncIterator]() {} }),
    }
    const server = new GatewayHttpServer({ port: 0, dispatcher })
    servers.push(server)
    const address = await server.start()
    const deviceId = 'a2222222-2222-4222-8222-2222222222ab'
    const statuses: number[] = []
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/approvals/approval-1/decision`, {
        method: 'POST',
        headers: {
          ...headers(Buffer.alloc(0), index % 2 === 0 ? deviceId : deviceId.toUpperCase()),
          'content-type': 'application/json',
        },
        body: '',
      })
      statuses.push(response.status)
    }
    // Authenticated per-device limits live in Core after signature and device
    // verification; the transport layer must not trust or reserve a bucket for
    // attacker-controlled header casing.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200])
  })
})
