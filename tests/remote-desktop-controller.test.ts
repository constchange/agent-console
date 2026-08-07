import { describe, expect, it, vi } from 'vitest'
import type { RemoteSettingsState } from '../shared/remote-settings'
import { validateAuthCallbackUrl } from '../electron/services/auth-callback'
import {
  RemoteDesktopController,
  sanitizeRemoteSettingsState,
  type RemoteCoreRequester,
} from '../electron/services/remote-desktop-controller'

const userId = '11111111-1111-4111-8111-111111111111'
const workstationId = '22222222-2222-4222-8222-222222222222'

function state(overrides: Partial<RemoteSettingsState> = {}): RemoteSettingsState {
  return {
    phase: 'disabled',
    message: 'Mobile Remote is off.',
    secureStorageReady: true,
    account: { userId, email: 'owner@example.test', nickname: 'Owner', emailVerified: true },
    workstation: { workstationId, displayName: 'Workstation', pendingCloudSync: false },
    gateway: {
      enabled: false,
      localAddress: '127.0.0.1:43127',
      publicBaseUrl: 'https://remote.example.test',
      gatewayPid: null,
      tunnelActive: false,
      lastReachableAt: null,
    },
    agents: [],
    devices: [],
    pairing: null,
    checks: [
      { id: 'core', label: 'Core', state: 'pass', detail: 'Core is ready.', checkedAt: '2026-08-07T00:00:00.000Z' },
    ],
    capabilities: {
      canRegister: false,
      canSignIn: false,
      canEnable: true,
      canPair: false,
      canRunDoctor: true,
      canRemoveWorkstation: true,
    },
    ...overrides,
  }
}

describe('Remote desktop IPC controller', () => {
  it('strictly validates custom-protocol callbacks', () => {
    const valid = 'agent-console://auth/callback?code=abcdefgh1234'
    expect(validateAuthCallbackUrl(valid)).toBe(valid)
    expect(() => validateAuthCallbackUrl('agent-console://evil/callback?code=abcdefgh1234')).toThrow('target')
    expect(() => validateAuthCallbackUrl('agent-console://auth/callback?code=abcdefgh1234&next=https://evil.test')).toThrow('query')
    expect(() => validateAuthCallbackUrl('agent-console://auth/callback?code=one&code=two')).toThrow()
  })

  it('projects only the public DTO and always disables workstation removal', () => {
    const projected = sanitizeRemoteSettingsState({
      ...state(),
      accessToken: 'must-not-cross-ipc',
      account: { ...state().account, refreshToken: 'must-not-cross-ipc' },
    })
    expect(projected).not.toHaveProperty('accessToken')
    expect(projected.account).not.toHaveProperty('refreshToken')
    expect(projected.capabilities.canRemoveWorkstation).toBe(false)
  })

  it('accepts the redacted verification-required account without inventing a user ID', () => {
    const projected = sanitizeRemoteSettingsState(state({
      phase: 'verification-required',
      account: { userId: null, email: 'pending@example.test', nickname: 'Pending', emailVerified: false },
    }))
    expect(projected.account?.userId).toBeNull()
  })

  it('derives callback purpose from Core state rather than renderer input', async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'remote.settings.get') return state({ phase: 'password-recovery' })
      expect(method).toBe('remote.auth.handleCallback')
      expect(params).toEqual({
        callbackUrl: 'agent-console://auth/callback?code=abcdefgh1234',
        purpose: 'recovery',
      })
      return state({ phase: 'password-recovery' })
    })
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, null)
    await controller.handleAuthCallback('agent-console://auth/callback?code=abcdefgh1234')
  })

  it('rejects a valid callback when local Core state is not expecting one', async () => {
    const request = vi.fn(async () => state({ phase: 'signed-out' }))
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, null)
    await expect(controller.handleAuthCallback('agent-console://auth/callback?code=abcdefgh1234'))
      .rejects.toThrow('No authentication callback')
    expect(request).toHaveBeenCalledOnce()
  })

  it('rolls back Core enablement when system services fail', async () => {
    const methods: string[] = []
    const request = vi.fn(async (method: string) => {
      methods.push(method)
      return state({ gateway: { ...state().gateway, enabled: method === 'remote.control.enable' } })
    })
    const disable = vi.fn(async () => ({ gateway: 'inactive' as const, tunnel: 'inactive' as const, gatewayUnitPath: '', tunnelUnitPath: '' }))
    const status = vi.fn(async () => ({ gateway: 'inactive' as const, tunnel: 'inactive' as const, gatewayUnitPath: '', tunnelUnitPath: '' }))
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, {
      enable: async () => { throw new Error('systemd failed') },
      disable,
      status,
    })
    await expect(controller.enable()).rejects.toThrow('rolled back safely')
    expect(methods).toEqual(['remote.control.enable', 'remote.control.disable'])
    expect(disable).toHaveBeenCalledOnce()
  })

  it('prepares services and refreshes Core environment before enabling authorization', async () => {
    const order: string[] = []
    const request = vi.fn(async (method: string) => {
      order.push(method)
      return state({ gateway: { ...state().gateway, enabled: true } })
    })
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, {
      prepare: async () => { order.push('services.prepare') },
      enable: async () => {
        order.push('services.enable')
        return { gateway: 'active', tunnel: 'active', gatewayUnitPath: '', tunnelUnitPath: '' }
      },
      disable: async () => ({ gateway: 'inactive', tunnel: 'inactive', gatewayUnitPath: '', tunnelUnitPath: '' }),
      status: async () => ({ gateway: 'inactive', tunnel: 'inactive', gatewayUnitPath: '', tunnelUnitPath: '' }),
    }, async () => { order.push('core.refresh-environment') })

    await controller.enable()
    expect(order).toEqual([
      'services.prepare',
      'core.refresh-environment',
      'remote.control.enable',
      'services.enable',
    ])
  })

  it('disables Core first and reports a degraded stop honestly', async () => {
    const order: string[] = []
    const request = vi.fn(async (method: string) => {
        order.push(method)
        return state()
    })
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, {
      enable: async () => { throw new Error('not used') },
      disable: async () => {
        order.push('services.disable')
        throw new Error('systemd failed')
      },
      status: async () => ({
        gateway: 'active',
        tunnel: 'active',
        gatewayUnitPath: '',
        tunnelUnitPath: '',
      }),
    })
    const result = await controller.disable()
    expect(order).toEqual(['remote.control.disable', 'services.disable'])
    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('authorization is off')
    expect(result.gateway.enabled).toBe(false)
    expect(result.gateway.tunnelActive).toBe(true)
  })

  it('attempts to stop public services when Core cannot confirm disablement', async () => {
    const disable = vi.fn(async () => ({
      gateway: 'inactive' as const,
      tunnel: 'inactive' as const,
      gatewayUnitPath: '',
      tunnelUnitPath: '',
    }))
    const request = vi.fn(async () => { throw new Error('Core disconnected') })
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, { enable: disable, disable, status: disable })

    await expect(controller.disable()).rejects.toThrow('could not be confirmed off')
    expect(disable).toHaveBeenCalledOnce()
  })

  it('stops public-facing services after signing out', async () => {
    const order: string[] = []
    const request = vi.fn(async (method: string) => {
      order.push(method)
      return state({ phase: 'signed-out', account: null })
    })
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, {
      enable: async () => { throw new Error('not used') },
      disable: async () => {
        order.push('services.disable')
        return { gateway: 'inactive', tunnel: 'inactive', gatewayUnitPath: '', tunnelUnitPath: '' }
      },
      status: async () => ({ gateway: 'inactive', tunnel: 'inactive', gatewayUnitPath: '', tunnelUnitPath: '' }),
    })

    const result = await controller.signOut()
    expect(order).toEqual(['remote.auth.signOut', 'services.disable'])
    expect(result.phase).toBe('signed-out')
    expect(result.gateway.enabled).toBe(false)
    expect(result.gateway.tunnelActive).toBe(false)
  })

  it('merges real systemd service status into doctor without claiming HTTPS was checked', async () => {
    const doctorState = state({
      checks: [
        { id: 'gateway', label: 'Gateway', state: 'warning', detail: 'Core cannot inspect systemd.', checkedAt: null },
        { id: 'tunnel', label: 'Tunnel', state: 'not-run', detail: 'Not checked.', checkedAt: null },
        { id: 'https', label: 'HTTPS', state: 'not-run', detail: 'Not checked.', checkedAt: null },
      ],
    })
    const request = vi.fn(async () => doctorState)
    const status = async () => ({
      gateway: 'active' as const,
      tunnel: 'active' as const,
      gatewayUnitPath: '',
      tunnelUnitPath: '',
    })
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, { prepare: async () => undefined, enable: status, disable: status, status }, undefined, async () => false)

    const result = await controller.doctor()
    expect(result.checks.find((item) => item.id === 'gateway')?.state).toBe('pass')
    expect(result.checks.find((item) => item.id === 'tunnel')?.state).toBe('pass')
    expect(result.checks.find((item) => item.id === 'https')?.state).toBe('not-run')
  })

  it('reaches ready only after active services and a real public health probe', async () => {
    const enabledState = state({
      phase: 'degraded',
      gateway: { ...state().gateway, enabled: true },
      checks: [
        { id: 'gateway', label: 'Gateway', state: 'warning', detail: 'Not checked.', checkedAt: null },
        { id: 'tunnel', label: 'Tunnel', state: 'not-run', detail: 'Not checked.', checkedAt: null },
        { id: 'https', label: 'HTTPS', state: 'not-run', detail: 'Not checked.', checkedAt: null },
      ],
    })
    const request = vi.fn(async () => enabledState)
    const status = async () => ({
      gateway: 'active' as const,
      tunnel: 'active' as const,
      gatewayUnitPath: '',
      tunnelUnitPath: '',
    })
    const probe = vi.fn(async () => true)
    const controller = new RemoteDesktopController({
      request: request as unknown as RemoteCoreRequester['request'],
    }, { prepare: async () => undefined, enable: status, disable: status, status }, undefined, probe)

    expect((await controller.settings()).phase).toBe('degraded')
    const diagnosed = await controller.doctor()
    expect(probe).toHaveBeenCalledWith('https://remote.example.test')
    expect(diagnosed.phase).toBe('ready')
    expect(diagnosed.gateway.lastReachableAt).not.toBeNull()
    expect(diagnosed.checks.find((item) => item.id === 'https')?.state).toBe('pass')
    expect((await controller.projectEvent(enabledState)).phase).toBe('ready')
  })
})
