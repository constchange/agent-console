import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalCoreServer } from '../core/transport/local-server'
import {
  CoreClient,
  CoreClientDisconnectedError,
  CoreClientMessageTooLargeError,
  CoreClientTimeoutError,
  CoreRemoteError,
} from '../electron/services/core-client'
import {
  CORE_MAX_MESSAGE_BYTES,
  CORE_PROTOCOL_VERSION,
  CORE_RPC_ERROR,
  CoreRpcException,
  type CoreEvent,
  type CoreHandlerMethod,
  type CoreRequestHandler,
} from '../shared/core-protocol'

interface Fixture {
  directory: string
  socketPath: string
  server: LocalCoreServer
}

const fixtures: Fixture[] = []
const clients: CoreClient[] = []
let unixSocketSupport: Promise<boolean> | null = null

function supportsUnixSockets(): Promise<boolean> {
  if (unixSocketSupport) return unixSocketSupport
  unixSocketSupport = (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-socket-probe-'))
    const socketPath = path.join(directory, 'probe.sock')
    const probe = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(socketPath, resolve)
      })
      await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
      return true
    } catch (error) {
      if (probe.listening) probe.close()
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
        if (process.env.CI) throw new Error('CI must provide working Unix sockets for the Core transport tests.')
        return false
      }
      throw error
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })()
  return unixSocketSupport
}

async function fixture(
  handler: CoreRequestHandler = () => ({ ok: true }),
  allowedMethods: readonly CoreHandlerMethod[] = ['core.health'],
): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-core-'))
  const socketPath = path.join(directory, 'runtime', 'agent-console', 'core.sock')
  const server = new LocalCoreServer({
    socketPath,
    serverVersion: 'test',
    handler,
    allowedMethods,
    maxEventHistory: 10,
  })
  const value = { directory, socketPath, server }
  fixtures.push(value)
  await server.start()
  return value
}

function client(socketPath: string, options: { protocolVersion?: number; requestTimeoutMs?: number } = {}): CoreClient {
  const value = new CoreClient({
    socketPath,
    clientVersion: 'test',
    protocolVersion: options.protocolVersion,
    requestTimeoutMs: options.requestTimeoutMs,
  })
  clients.push(value)
  return value
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for test condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  for (const value of clients.splice(0)) value.disconnect()
  for (const value of fixtures.splice(0)) {
    await value.server.close().catch(() => undefined)
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

describe('Unix-only Core transport', () => {
  it('creates a 0700 directory and 0600 Unix socket without a TCP address', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const { socketPath, server } = await fixture()
    const directoryStat = await fs.stat(path.dirname(socketPath))
    const socketStat = await fs.stat(socketPath)

    expect(directoryStat.mode & 0o777).toBe(0o700)
    expect(socketStat.mode & 0o777).toBe(0o600)
    expect(socketStat.isSocket()).toBe(true)
    expect(server.address).toBe(socketPath)
    expect(typeof server.address).toBe('string')
  })

  it('requires a compatible initialize handshake and enforces the method allowlist', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const { socketPath } = await fixture()
    const incompatible = client(socketPath, { protocolVersion: CORE_PROTOCOL_VERSION + 1 })
    await expect(incompatible.connect()).rejects.toMatchObject({
      code: CORE_RPC_ERROR.PROTOCOL_VERSION_MISMATCH,
    })

    const connected = client(socketPath)
    await connected.connect()
    await expect(connected.request('core.health')).resolves.toEqual({ ok: true })
    await expect(connected.request('runtime.get')).rejects.toMatchObject({
      code: CORE_RPC_ERROR.METHOD_NOT_FOUND,
    })
  })

  it('handles requests and replays sequenced events after an explicit reconnect', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const handler: CoreRequestHandler = (method, params, context) => ({ method, params, client: context.client.name })
    const { socketPath, server } = await fixture(handler, ['core.health'])
    const connected = client(socketPath)
    const events: CoreEvent[] = []
    connected.onEvent((event) => events.push(event))

    await connected.connect()
    await expect(connected.request('core.health', { verbose: true })).resolves.toEqual({
      method: 'core.health',
      params: { verbose: true },
      client: 'agent-console-desktop',
    })
    server.publish('runtime.updated', { revision: 1 })
    await waitFor(() => events.length === 1)
    expect(events[0].seq).toBe(1)

    connected.disconnect()
    server.publish('runtime.updated', { revision: 2 })
    await connected.connect()
    await waitFor(() => events.length === 2)
    expect(events.map((event) => event.seq)).toEqual([1, 2])
    expect(connected.lastEventSequence).toBe(2)
    expect(connected.subscriptionState?.resetRequired).toBe(false)
  })

  it('recognizes a restarted Core instance even when its event sequence starts at the same number', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const first = await fixture(() => ({ ok: true }), ['core.health'])
    const connected = client(first.socketPath)
    const events: CoreEvent[] = []
    connected.onEvent((event) => events.push(event))
    await connected.connect()
    first.server.publish('runtime.updated', { generation: 1 })
    await waitFor(() => events.length === 1)

    connected.disconnect()
    await first.server.close()
    const secondServer = new LocalCoreServer({
      socketPath: first.socketPath,
      serverVersion: 'test-restarted',
      handler: () => ({ ok: true }),
      allowedMethods: ['core.health'],
    })
    fixtures.push({ directory: first.directory, socketPath: first.socketPath, server: secondServer })
    await secondServer.start()
    secondServer.publish('runtime.updated', { generation: 2 })

    await connected.connect()
    await waitFor(() => events.length === 2)
    expect(events[1]).toMatchObject({ seq: 1, payload: { generation: 2 } })
  })

  it('limits excessive concurrent requests from one local client', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const never = new Promise<never>(() => undefined)
    let handlerCalls = 0
    const { socketPath } = await fixture(() => {
      handlerCalls += 1
      return never
    }, ['runtime.refresh'])
    const connected = client(socketPath, { requestTimeoutMs: 100 })
    await connected.connect()
    const requests = Array.from({ length: 96 }, () => connected.request('runtime.refresh').catch((error: unknown) => error))
    const results = await Promise.all(requests)
    expect(results.some((result) => result instanceof CoreRemoteError && result.code === CORE_RPC_ERROR.TOO_MANY_REQUESTS)).toBe(true)
    expect(handlerCalls).toBe(32)
  })

  it('requires a fresh bootstrap instead of replaying an oversized event backlog', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const { socketPath, server } = await fixture(() => ({ ok: true }), ['core.health'])
    for (let index = 0; index < 101; index += 1) server.publish('task.updated', { index })
    const connected = client(socketPath)
    const events: CoreEvent[] = []
    connected.onEvent((event) => events.push(event))
    await connected.connect()
    expect(connected.subscriptionState?.resetRequired).toBe(true)
    expect(events).toEqual([])
  })

  it('requires a fresh bootstrap when a small event count exceeds the replay byte limit', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const { socketPath, server } = await fixture(() => ({ ok: true }), ['core.health'])
    for (let index = 0; index < 4; index += 1) {
      server.publish('task.updated', { index, summary: 'x'.repeat(600_000) })
    }
    const connected = client(socketPath)
    const events: CoreEvent[] = []
    connected.onEvent((event) => events.push(event))
    await connected.connect()
    expect(connected.subscriptionState?.resetRequired).toBe(true)
    expect(events).toEqual([])
  })

  it('rejects messages larger than 1 MiB on both client and server boundaries', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const { socketPath } = await fixture()
    const connected = client(socketPath)
    await connected.connect()
    await expect(connected.request('core.health', { text: 'x'.repeat(CORE_MAX_MESSAGE_BYTES) }))
      .rejects.toBeInstanceOf(CoreClientMessageTooLargeError)

    const raw = net.createConnection({ path: socketPath })
    await once(raw, 'connect')
    const received = new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      raw.on('data', (chunk: Buffer) => chunks.push(chunk))
      raw.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    raw.write(Buffer.alloc(CORE_MAX_MESSAGE_BYTES + 1, 0x61))
    const response = await received
    expect(JSON.parse(response.trim()).error.code).toBe(CORE_RPC_ERROR.MESSAGE_TOO_LARGE)
  })

  it('rejects timed-out and disconnected in-flight requests', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const never = new Promise<never>(() => undefined)
    const handler: CoreRequestHandler = () => never
    const { socketPath, server } = await fixture(handler, ['runtime.refresh', 'runtime.get'])
    const connected = client(socketPath, { requestTimeoutMs: 30 })
    await connected.connect()

    await expect(connected.request('runtime.refresh')).rejects.toBeInstanceOf(CoreClientTimeoutError)
    const pending = connected.request('runtime.get', undefined, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await server.close()
    await expect(pending).rejects.toBeInstanceOf(CoreClientDisconnectedError)
  })

  it('returns typed remote errors without converting them to transport failures', async ({ skip }) => {
    if (!await supportsUnixSockets()) skip('Unix sockets are blocked by this execution sandbox.')
    const handler: CoreRequestHandler = () => {
      throw new CoreRpcException(CORE_RPC_ERROR.CONFLICT, 'Revision conflict.', { currentRevision: 3 })
    }
    const { socketPath } = await fixture(handler, ['config.commit'])
    const connected = client(socketPath)
    await connected.connect()
    const error = await connected.request('config.commit').catch((value: unknown) => value)
    expect(error).toBeInstanceOf(CoreRemoteError)
    expect(error).toMatchObject({ code: CORE_RPC_ERROR.CONFLICT, data: { currentRevision: 3 } })
  })
})
