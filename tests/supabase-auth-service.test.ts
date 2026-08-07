import { describe, expect, it, vi } from 'vitest'
import { SupabaseAuthService } from '../core/auth/supabase-auth-service'
import type { SecureSessionStorage } from '../core/auth/secure-session-storage'

function fakeStorage(): SecureSessionStorage {
  const entries = new Map<string, string>()
  return {
    initialize: vi.fn(async () => undefined),
    getItem: vi.fn(async (key: string) => entries.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { entries.set(key, value) }),
    removeItem: vi.fn(async (key: string) => { entries.delete(key) }),
    close: vi.fn(async () => undefined),
  } as unknown as SecureSessionStorage
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const auth = {
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    startAutoRefresh: vi.fn(),
    stopAutoRefresh: vi.fn(),
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    signInWithPassword: vi.fn(async () => ({
      data: { session: null },
      error: new Error('Bearer provider-secret and https://example.test/?access_token=secret'),
    })),
    exchangeCodeForSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    ...overrides,
  }
  return { auth, from: vi.fn() }
}

function service(client = fakeClient(), storage = fakeStorage()): SupabaseAuthService {
  return new SupabaseAuthService({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_public-test-value',
  }, storage, {
    clientFactory: (() => client) as never,
  })
}

describe('SupabaseAuthService boundary hardening', () => {
  it('rejects secret-class workstation keys', () => {
    expect(() => new SupabaseAuthService({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_secret_do-not-install-this',
    }, fakeStorage())).toThrow(/publishable\/anon key/u)
  })

  it('never forwards provider error contents to the desktop boundary', async () => {
    const auth = service()
    await auth.initialize()
    await expect(auth.signIn('owner@example.com', 'correct horse battery staple'))
      .rejects.toThrow('Sign-in failed.')
    await expect(auth.signIn('owner@example.com', 'correct horse battery staple'))
      .rejects.not.toThrow(/provider-secret|access_token/u)
    await auth.dispose()
  })

  it('rejects ambiguous or decorated custom-protocol callbacks before exchange', async () => {
    const client = fakeClient()
    const auth = service(client)
    await auth.initialize()
    await expect(auth.handleCallback(
      'agent-console://auth/callback?code=abcdefgh&state=renderer-controlled',
      'email-confirmation',
    )).rejects.toThrow('Authentication callback query is invalid.')
    await expect(auth.handleCallback(
      'agent-console://auth:444/callback?code=abcdefgh',
      'email-confirmation',
    )).rejects.toThrow('Authentication callback target is invalid.')
    expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
    await auth.dispose()
  })

  it('cannot downgrade an encrypted recovery callback to email confirmation', async () => {
    const session = {
      user: {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'owner@example.com',
        email_confirmed_at: '2026-08-07T00:00:00.000Z',
      },
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    }
    const client = fakeClient({
      exchangeCodeForSession: vi.fn(async () => ({ data: { session }, error: null })),
    })
    const storage = fakeStorage()
    const auth = service(client, storage)
    await auth.initialize()
    await storage.setItem('agent-console.recovery', '{"pending":true}')
    await expect(auth.handleCallback(
      'agent-console://auth/callback?code=abcdefgh',
      'email-confirmation',
    )).resolves.toMatchObject({ phase: 'recovery', remoteAllowed: false })
    await auth.dispose()
  })

  it('keeps a recovery marker locked across later session refresh events', async () => {
    const session = {
      user: {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'owner@example.com',
        email_confirmed_at: '2026-08-07T00:00:00.000Z',
      },
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    }
    let authListener: ((event: string, refreshed: typeof session) => void) | undefined
    const client = fakeClient({
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: { session }, error: null })),
      onAuthStateChange: vi.fn((listener) => {
        authListener = listener
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
    })
    const storage = fakeStorage()
    const auth = service(client, storage)
    await auth.initialize()
    await auth.requestPasswordRecovery('owner@example.com')
    expect(auth.getPublicState()).toMatchObject({ phase: 'recovery', remoteAllowed: false })

    const readsBeforeRefresh = vi.mocked(storage.getItem).mock.calls.length
    authListener?.('TOKEN_REFRESHED', session)
    await vi.waitFor(() => {
      expect(vi.mocked(storage.getItem).mock.calls.length).toBeGreaterThan(readsBeforeRefresh)
    })
    expect(auth.getPublicState()).toMatchObject({ phase: 'recovery', remoteAllowed: false })

    await auth.signIn('owner@example.com', 'correct horse battery staple')
    expect(auth.getPublicState()).toMatchObject({ phase: 'recovery', remoteAllowed: false })
    await auth.dispose()
  })

  it('bounds token verification even when a provider client never settles', async () => {
    const client = fakeClient({
      getClaims: vi.fn(() => new Promise(() => undefined)),
    })
    const auth = new SupabaseAuthService({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public-test-value',
    }, fakeStorage(), {
      clientFactory: (() => client) as never,
      networkTimeoutMs: 100,
    })
    await auth.initialize()
    await expect(auth.verifyAccessToken('header.payload.signature')).rejects.toThrow('timed out')
    await auth.dispose()
  })
})
