import { describe, expect, it, vi } from 'vitest'
import {
  remoteGatewaySocketFromArguments,
  startRemoteGatewayRuntime,
  type RemoteGatewayRuntimeFactories,
} from '../electron/services/remote-gateway-runtime'

function environment(armed: string | null = '1'): NodeJS.ProcessEnv {
  return {
    ...(armed === null ? {} : { AGENT_CONSOLE_REMOTE_ARMED: armed }),
    AGENT_CONSOLE_SUPABASE_URL: 'https://project.supabase.co',
    AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'a'.repeat(32)}`,
    AGENT_CONSOLE_PUBLIC_BASE_URL: 'https://remote.example.test',
    AGENT_CONSOLE_GATEWAY_LOCAL_HOST: '127.0.0.1',
    AGENT_CONSOLE_GATEWAY_LOCAL_PORT: '43127',
  }
}

describe('Electron Remote Gateway runtime', () => {
  it('requires one normalized absolute Core socket path', () => {
    expect(remoteGatewaySocketFromArguments(['--remote-gateway-socket=/run/user/1000/agent-console/gateway/core.sock']))
      .toBe('/run/user/1000/agent-console/gateway/core.sock')
    expect(() => remoteGatewaySocketFromArguments([])).toThrow('exactly one')
    expect(() => remoteGatewaySocketFromArguments([
      '--remote-gateway-socket=/one.sock',
      '--remote-gateway-socket=/two.sock',
    ])).toThrow('exactly one')
    expect(() => remoteGatewaySocketFromArguments(['--remote-gateway-socket=relative.sock'])).toThrow('invalid')
    expect(() => remoteGatewaySocketFromArguments(['--remote-gateway-socket=/tmp/../core.sock'])).toThrow('invalid')
  })

  it.each([null, '0', 'true', ' 1'])('fails closed for non-armed value %s before creating a transport', async (armed) => {
    const createTransport = vi.fn()
    await expect(startRemoteGatewayRuntime({
      argv: ['--remote-gateway-socket=/run/user/1000/agent-console/gateway/core.sock'],
      environment: environment(armed),
      clientVersion: '0.5.0',
      factories: { createTransport } as unknown as RemoteGatewayRuntimeFactories,
    })).rejects.toThrow()
    expect(createTransport).not.toHaveBeenCalled()
  })

  it('connects before binding loopback and closes both sides safely', async () => {
    const order: string[] = []
    const factories: RemoteGatewayRuntimeFactories = {
      createTransport(socketPath, _clientVersion, lane) {
        expect(socketPath).toBe('/run/user/1000/agent-console/gateway/core.sock')
        return {
          connect: async () => { order.push(`connect-${lane}`) },
          request: async () => { throw new Error('not used') },
          disconnect: () => { order.push(`disconnect-${lane}`) },
        }
      },
      createHttpServer(options) {
        expect(options.host).toBe('127.0.0.1')
        expect(options.port).toBe(43127)
        return {
          start: async () => {
            order.push('listen')
            return { host: '127.0.0.1' as const, port: 43127 }
          },
          close: async () => { order.push('close-http') },
        }
      },
    }
    const runtime = await startRemoteGatewayRuntime({
      argv: ['--remote-gateway-socket=/run/user/1000/agent-console/gateway/core.sock'],
      environment: environment(),
      clientVersion: '0.5.0',
      factories,
    })
    expect(order).toEqual(['connect-health', 'connect-requests', 'connect-streams', 'listen'])
    await runtime.close()
    await runtime.close()
    expect(order).toEqual([
      'connect-health', 'connect-requests', 'connect-streams', 'listen', 'close-http',
      'disconnect-health', 'disconnect-requests', 'disconnect-streams',
    ])
  })

  it('closes HTTP and Core resources when startup fails after connecting', async () => {
    const order: string[] = []
    const factories: RemoteGatewayRuntimeFactories = {
      createTransport(_socketPath, _clientVersion, lane) {
        return {
          connect: async () => { order.push(`connect-${lane}`) },
          request: async () => { throw new Error('not used') },
          disconnect: () => { order.push(`disconnect-${lane}`) },
        }
      },
      createHttpServer() {
        return {
          start: async () => {
            order.push('listen')
            throw new Error('bind failed')
          },
          close: async () => { order.push('close-http') },
        }
      },
    }

    await expect(startRemoteGatewayRuntime({
      argv: ['--remote-gateway-socket=/run/user/1000/agent-console/gateway/core.sock'],
      environment: environment(),
      clientVersion: '0.5.0',
      factories,
    })).rejects.toThrow('bind failed')
    expect(order).toEqual([
      'connect-health', 'connect-requests', 'connect-streams', 'listen', 'close-http',
      'disconnect-health', 'disconnect-requests', 'disconnect-streams',
    ])
  })
})
