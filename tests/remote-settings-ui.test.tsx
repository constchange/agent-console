import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteSettingsState } from '../shared/remote-settings'
import { normalizedPermissions, RemoteControlSettingsView } from '../src/components/RemoteControlSettings'

const actions = {
  signUp: vi.fn(async () => undefined),
  signIn: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
  resendVerification: vi.fn(async () => undefined),
  requestPasswordReset: vi.fn(async () => undefined),
  completePasswordRecovery: vi.fn(async () => undefined),
  enable: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
  beginPairing: vi.fn(async () => undefined),
  cancelPairing: vi.fn(async () => undefined),
  decidePairing: vi.fn(async () => undefined),
  revokeDevice: vi.fn(async () => undefined),
  retryDevice: vi.fn(async () => undefined),
  updatePermission: vi.fn(async () => undefined),
  renameWorkstation: vi.fn(async () => undefined),
  runDoctor: vi.fn(async () => undefined),
  removeWorkstation: vi.fn(async () => undefined),
}

function state(overrides: Partial<RemoteSettingsState>): RemoteSettingsState {
  return {
    phase: 'disabled',
    message: 'Mobile Remote is off.',
    secureStorageReady: true,
    account: { userId: 'user-1', email: 'owner@example.com', nickname: 'Owner', emailVerified: true },
    workstation: { workstationId: 'workstation-1', displayName: 'Office', pendingCloudSync: false },
    gateway: { enabled: false, localAddress: null, publicBaseUrl: null, gatewayPid: null, tunnelActive: false, lastReachableAt: null },
    agents: [],
    devices: [],
    pairing: null,
    checks: [
      { id: 'secure-storage', label: 'Secure storage', state: 'pass', detail: 'Protected storage is available.', checkedAt: '2026-08-07T00:00:00.000Z' },
      { id: 'core', label: 'Console Core', state: 'pass', detail: 'Unix socket connected.', checkedAt: '2026-08-07T00:00:00.000Z' },
      { id: 'gateway', label: 'Local Gateway', state: 'not-run', detail: 'Remote is off.', checkedAt: null },
      { id: 'tunnel', label: 'VPS tunnel', state: 'not-run', detail: 'Remote is off.', checkedAt: null },
      { id: 'https', label: 'HTTPS 443', state: 'not-run', detail: 'Remote is off.', checkedAt: null },
    ],
    capabilities: { canRegister: false, canSignIn: false, canEnable: true, canPair: false, canRunDoctor: true, canRemoveWorkstation: true },
    ...overrides,
  }
}

function render(remoteState: RemoteSettingsState): string {
  return renderToStaticMarkup(<RemoteControlSettingsView state={remoteState} busyAction={null} error={null} actions={actions} />)
}

describe('Mobile Remote desktop settings', () => {
  it('keeps the two public view toggles aligned with the conservative v0.5 grant', () => {
    const empty = { viewStatus: false, viewEvents: false, message: false, approve: false, interrupt: false }
    expect(normalizedPermissions(empty, 'viewStatus', true)).toMatchObject({ viewStatus: true, viewEvents: true })
    expect(normalizedPermissions(empty, 'interrupt', true)).toMatchObject({
      viewStatus: true,
      viewEvents: true,
      interrupt: true,
    })
    expect(normalizedPermissions({ ...empty, viewStatus: true, viewEvents: true, message: true }, 'viewEvents', false))
      .toEqual(empty)
  })

  it('blocks registration until administrator configuration is installed', () => {
    const markup = render(state({
      phase: 'unconfigured',
      account: null,
      workstation: null,
      message: 'SUPABASE_URL and the public publishable key are missing.',
      capabilities: { canRegister: false, canSignIn: false, canEnable: false, canPair: false, canRunDoctor: false, canRemoveWorkstation: false },
    }))

    expect(markup).toContain('needs administrator setup')
    expect(markup).toContain('remote.env')
    expect(markup).not.toContain('Create account</button>')
  })

  it('labels email as the login account and explains that login is not pairing', () => {
    const markup = render(state({
      phase: 'signed-out',
      account: null,
      workstation: null,
      capabilities: { canRegister: true, canSignIn: true, canEnable: false, canPair: false, canRunDoctor: false, canRemoveWorkstation: false },
    }))

    expect(markup).toContain('Email (login account)')
    expect(markup).toContain('Login alone never grants a phone access')
    expect(markup).toContain('Forgot password?')
  })

  it('shows the HTTPS boundary, device revocation, and per-Agent permissions when ready', () => {
    const markup = render(state({
      phase: 'ready',
      message: 'Online through HTTPS 443.',
      gateway: { enabled: true, localAddress: '127.0.0.1:43127', publicBaseUrl: 'https://remote.example.invalid', gatewayPid: 4321, tunnelActive: true, lastReachableAt: '2026-08-07T01:00:00.000Z' },
      agents: [{
        agentId: 'agent-1',
        agentName: 'Product Planner',
        projectName: 'Product',
        color: '#55a6ff',
        permissions: { viewStatus: true, viewEvents: true, message: true, approve: false, interrupt: false },
        pendingCloudSync: false,
      }],
      devices: [{ deviceId: 'phone-1', displayName: 'Pixel', platform: 'android', state: 'active', pairedAt: '2026-08-07T00:00:00.000Z', lastSeenAt: '2026-08-07T01:00:00.000Z' }],
      capabilities: { canRegister: false, canSignIn: false, canEnable: false, canPair: true, canRunDoctor: true, canRemoveWorkstation: true },
    }))

    expect(markup).toContain('HTTPS 443')
    expect(markup).toContain('127.0.0.1:43127')
    expect(markup).toContain('Pixel')
    expect(markup).toContain('Revoke')
    expect(markup).toContain('Product Planner')
    expect(markup).toContain('aria-label="Product Planner: approve"')
  })

  it('fails closed when secure Linux storage is unavailable', () => {
    const markup = render(state({
      phase: 'secure-storage-unavailable',
      secureStorageReady: false,
      message: 'Electron reported the basic_text backend.',
    }))

    expect(markup).toContain('will not use plaintext credential storage')
    expect(markup).toContain('Unlock your desktop keyring')
    expect(markup).not.toContain('Turn on remote')
  })

  it('requires a new password and keeps Remote locked during recovery', () => {
    const markup = render(state({
      phase: 'password-recovery',
      account: null,
      workstation: null,
      capabilities: { canRegister: false, canSignIn: false, canEnable: false, canPair: false, canRunDoctor: false, canRemoveWorkstation: false },
    }))

    expect(markup).toContain('Choose a new password')
    expect(markup).toContain('Confirm new password')
    expect(markup).toContain('Remote services stay disabled during recovery')
    expect(markup).not.toContain('Turn on remote')
  })
})
