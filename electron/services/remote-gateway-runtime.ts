import path from 'node:path'
import type { CoreHandlerMethod } from '../../shared/core-protocol'
import { requireArmedRemoteRuntimeConfig, type RemoteRuntimeConfig } from '../../core/remote/runtime-config'
import { GatewayCoreClient, type GatewayBridgeMethod, type GatewayBridgeTransport } from '../../gateway/core-client'
import { GatewayHttpServer, type GatewayRequestDispatcher } from '../../gateway/http-server'
import { CoreClient } from './core-client'

const REMOTE_GATEWAY_SOCKET_ARGUMENT = '--remote-gateway-socket='
const MAX_SOCKET_PATH_BYTES = 4_096

export interface RemoteGatewayRuntime {
  readonly config: RemoteRuntimeConfig
  readonly socketPath: string
  close(): Promise<void>
}

export interface RemoteGatewayRuntimeFactories {
  createTransport(
    socketPath: string,
    clientVersion: string,
    lane: 'health' | 'requests' | 'streams',
  ): GatewayBridgeTransport
  createHttpServer(options: {
    host: '127.0.0.1'
    port: number
    dispatcher: GatewayRequestDispatcher
  }): Pick<GatewayHttpServer, 'start' | 'close'>
}

function defaultFactories(): RemoteGatewayRuntimeFactories {
  return {
    createTransport(socketPath, clientVersion, lane) {
      const client = new CoreClient({
        socketPath,
        channel: 'gateway',
        clientVersion,
        clientName: `agent-console-remote-gateway-${lane}`,
      })
      return {
        async connect() {
          await client.connect()
        },
        request<T>(method: GatewayBridgeMethod, params: unknown, timeoutMs?: number) {
          // GATEWAY_BRIDGE_METHODS are part of the gateway-only Core allowlist.
          // Keep the cast at this transport boundary so callers cannot use the
          // raw Core client to reach any other method.
          return client.request<T>(method as CoreHandlerMethod, params, timeoutMs)
        },
        disconnect() {
          client.disconnect()
        },
      }
    },
    createHttpServer(options) {
      return new GatewayHttpServer(options)
    },
  }
}

export function remoteGatewaySocketFromArguments(argv: readonly string[]): string {
  const values = argv.filter((value) => value.startsWith(REMOTE_GATEWAY_SOCKET_ARGUMENT))
  if (values.length !== 1) throw new Error('Remote Gateway requires exactly one private Core socket argument.')
  const candidate = values[0].slice(REMOTE_GATEWAY_SOCKET_ARGUMENT.length)
  if (!candidate
    || Buffer.byteLength(candidate, 'utf8') > MAX_SOCKET_PATH_BYTES
    || /[\0\r\n]/.test(candidate)
    || !path.isAbsolute(candidate)
    || path.normalize(candidate) !== candidate) {
    throw new Error('Remote Gateway Core socket path is invalid.')
  }
  return candidate
}

export async function startRemoteGatewayRuntime(options: {
  argv: readonly string[]
  environment?: NodeJS.ProcessEnv
  clientVersion: string
  factories?: RemoteGatewayRuntimeFactories
}): Promise<RemoteGatewayRuntime> {
  const config = requireArmedRemoteRuntimeConfig(options.environment)
  if (config.gatewayHost !== '127.0.0.1') throw new Error('Remote Gateway may only bind to 127.0.0.1.')
  const socketPath = remoteGatewaySocketFromArguments(options.argv)
  const factories = options.factories ?? defaultFactories()
  const healthClient = new GatewayCoreClient(factories.createTransport(socketPath, options.clientVersion, 'health'))
  const requestClient = new GatewayCoreClient(factories.createTransport(socketPath, options.clientVersion, 'requests'))
  const streamClient = new GatewayCoreClient(factories.createTransport(socketPath, options.clientVersion, 'streams'))
  const clients = [healthClient, requestClient, streamClient]
  const dispatcher: GatewayRequestDispatcher = {
    health: () => healthClient.health(),
    dispatch: (envelope, context) => requestClient.dispatch(envelope, context),
    openEvents: (envelope, context) => streamClient.openEvents(envelope, context),
  }
  const server = factories.createHttpServer({
    host: config.gatewayHost,
    port: config.gatewayPort,
    dispatcher,
  })
  try {
    await Promise.all(clients.map((client) => client.connect()))
    const address = await server.start()
    if (address.host !== '127.0.0.1' || address.port !== config.gatewayPort) {
      throw new Error('Remote Gateway bound to an unexpected local address.')
    }
  } catch (error) {
    await server.close().catch(() => undefined)
    for (const client of clients) client.close()
    throw error
  }

  let closed = false
  return {
    config,
    socketPath,
    async close() {
      if (closed) return
      closed = true
      await server.close().catch(() => undefined)
      for (const client of clients) client.close()
    },
  }
}
