import { describe, expect, it } from 'vitest'
import {
  parseRemoteRuntimeConfig,
  requireArmedRemoteRuntimeConfig,
} from '../core/remote/runtime-config'

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AGENT_CONSOLE_REMOTE_ARMED: '0',
    AGENT_CONSOLE_SUPABASE_URL: 'https://project.supabase.co',
    AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'a'.repeat(32)}`,
    AGENT_CONSOLE_PUBLIC_BASE_URL: 'https://remote.example.test',
    AGENT_CONSOLE_GATEWAY_LOCAL_HOST: '127.0.0.1',
    AGENT_CONSOLE_GATEWAY_LOCAL_PORT: '43127',
    ...overrides,
  }
}

describe('Remote runtime configuration', () => {
  it('treats a completely absent configuration as fail-closed and unconfigured', () => {
    expect(parseRemoteRuntimeConfig({})).toMatchObject({ configured: false })
    expect(() => requireArmedRemoteRuntimeConfig({})).toThrow('Install a private remote.env')
  })

  it('allows account setup while disarmed but refuses to start a Gateway', () => {
    expect(parseRemoteRuntimeConfig(environment())).toMatchObject({
      configured: true,
      config: { armed: false, gatewayHost: '127.0.0.1', gatewayPort: 43127 },
    })
    expect(() => requireArmedRemoteRuntimeConfig(environment())).toThrow('disarmed')
    expect(requireArmedRemoteRuntimeConfig(environment({ AGENT_CONSOLE_REMOTE_ARMED: '1' }))).toMatchObject({
      armed: true,
    })
  })

  it('rejects partial config, non-loopback Gateway binds and secret Supabase keys', () => {
    const partial = environment()
    delete partial.AGENT_CONSOLE_PUBLIC_BASE_URL
    expect(() => parseRemoteRuntimeConfig(partial)).toThrow('incomplete')
    expect(() => parseRemoteRuntimeConfig(environment({ AGENT_CONSOLE_GATEWAY_LOCAL_HOST: '0.0.0.0' })))
      .toThrow('exactly 127.0.0.1')
    expect(() => parseRemoteRuntimeConfig(environment({
      AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY: `sb_secret_${'a'.repeat(32)}`,
    }))).toThrow('publishable/anon')
  })
})
