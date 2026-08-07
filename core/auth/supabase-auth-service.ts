import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import type { RemotePublicAuthState } from '../../shared/remote-validation'
import type { SecureSessionStorage } from './secure-session-storage'

const RECOVERY_MARKER_KEY = 'agent-console.recovery'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DEFAULT_NETWORK_TIMEOUT_MS = 8_000

export interface VerifiedSupabaseClaims {
  userId: string
  email: string | null
  expiresAt: number
  issuedAt: number
  sessionId: string
}

export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<VerifiedSupabaseClaims>
  getPublicState(): RemotePublicAuthState
}

/**
 * Narrow database-only view used by trusted Core services. The Supabase auth
 * object (and therefore getSession/refresh-token access) is not exposed.
 */
export type AuthenticatedSupabaseDatabase = Pick<SupabaseClient, 'from'>

export interface AuthenticatedSupabaseDatabaseProvider {
  withAuthenticatedDatabase<T>(
    operation: (database: AuthenticatedSupabaseDatabase, userId: string) => Promise<T>,
  ): Promise<T>
}

export interface SupabaseAuthConfig {
  url: string
  publishableKey: string
  callbackUrl?: string
  allowInsecureLocalhost?: boolean
}

export interface SupabaseAuthServiceOptions {
  clientFactory?: typeof createClient
  now?: () => number
  fetch?: typeof globalThis.fetch
  networkTimeoutMs?: number
}

type AuthListener = (state: RemotePublicAuthState) => void

function boundedFetch(
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const controller = new AbortController()
    const upstream = init.signal
    const abortFromUpstream = () => controller.abort(upstream?.reason)
    if (upstream?.aborted) abortFromUpstream()
    else upstream?.addEventListener('abort', abortFromUpstream, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Supabase request timed out.')), timeoutMs)
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
      upstream?.removeEventListener('abort', abortFromUpstream)
    }
  }
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Supabase request timed out.')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function publicMessage(_error: unknown, fallback: string): string {
  // Provider errors are useful for local diagnostics, but they can also
  // contain URLs, email addresses, query parameters, or credential fragments.
  // Only fixed, caller-selected text is allowed to cross the Core boundary.
  return fallback.slice(0, 300)
}

function validateConfig(config: SupabaseAuthConfig): Required<SupabaseAuthConfig> {
  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    throw new Error('Supabase URL is invalid.')
  }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(config.allowInsecureLocalhost && local && url.protocol === 'http:')) {
    throw new Error('Supabase URL must use HTTPS.')
  }
  if (url.username || url.password || url.hash || url.search) throw new Error('Supabase URL is invalid.')
  const publishableKey = config.publishableKey.trim()
  if (!publishableKey || publishableKey.length > 4_096 || /\s/.test(publishableKey)) {
    throw new Error('Supabase publishable key is invalid.')
  }
  let jwtRole = ''
  const jwtParts = publishableKey.split('.')
  if (jwtParts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8')) as { role?: unknown }
      jwtRole = typeof payload.role === 'string' ? payload.role : ''
    } catch {
      // A malformed publishable key will be rejected by Supabase. Do not echo it.
    }
  }
  const loweredKey = publishableKey.toLowerCase()
  if (/service[_-]?role/i.test(publishableKey)
    || loweredKey.startsWith('sb_secret_')
    || jwtRole === 'service_role'
    || loweredKey.startsWith('sb_') && !loweredKey.startsWith('sb_publishable_')) {
    throw new Error('Only a Supabase publishable/anon key may be used by Agent Console.')
  }
  const callbackUrl = config.callbackUrl ?? 'agent-console://auth/callback'
  const callback = new URL(callbackUrl)
  if (callback.protocol !== 'agent-console:' || callback.hostname !== 'auth' || callback.pathname !== '/callback') {
    throw new Error('Agent Console authentication callback URL is invalid.')
  }
  return {
    url: url.toString().replace(/\/$/, ''),
    publishableKey,
    callbackUrl,
    allowInsecureLocalhost: Boolean(config.allowInsecureLocalhost),
  }
}

function signedOutState(message = 'Sign in to enable remote control.'): RemotePublicAuthState {
  return {
    phase: 'signed_out',
    userId: null,
    email: null,
    emailConfirmed: false,
    sessionExpiresAt: null,
    remoteAllowed: false,
    message,
  }
}

export class SupabaseAuthService implements AccessTokenVerifier, AuthenticatedSupabaseDatabaseProvider {
  private readonly config: Required<SupabaseAuthConfig>
  private readonly now: () => number
  private readonly clientFactory: typeof createClient
  private readonly networkTimeoutMs: number
  private readonly fetch: typeof globalThis.fetch
  private client: SupabaseClient | null = null
  private unsubscribe: (() => void) | null = null
  private listeners = new Set<AuthListener>()
  private authEventQueue: Promise<void> = Promise.resolve()
  private state: RemotePublicAuthState = {
    ...signedOutState('Authentication has not started.'),
    phase: 'unconfigured',
  }
  private initialized = false

  constructor(
    config: SupabaseAuthConfig,
    private readonly storage: SecureSessionStorage,
    options: SupabaseAuthServiceOptions = {},
  ) {
    this.config = validateConfig(config)
    this.now = options.now ?? Date.now
    this.clientFactory = options.clientFactory ?? createClient
    this.networkTimeoutMs = options.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS
    if (!Number.isSafeInteger(this.networkTimeoutMs) || this.networkTimeoutMs < 100 || this.networkTimeoutMs > 30_000) {
      throw new Error('Supabase network timeout is invalid.')
    }
    this.fetch = boundedFetch(options.fetch ?? globalThis.fetch, this.networkTimeoutMs)
  }

  getPublicState(): RemotePublicAuthState {
    return { ...this.state }
  }

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener)
    listener(this.getPublicState())
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<RemotePublicAuthState> {
    if (this.initialized) return this.getPublicState()
    try {
      await this.storage.initialize()
    } catch (error) {
      this.setState({
        ...signedOutState(publicMessage(error, 'The operating-system keyring is unavailable.')),
        phase: 'locked',
      })
      throw error
    }

    this.client = this.clientFactory(this.config.url, this.config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
        storage: this.storage,
      },
      global: { fetch: this.fetch },
    })
    const subscription = this.client.auth.onAuthStateChange((event, session) => {
      this.queueAuthStateEvent(event, session)
    })
    this.unsubscribe = () => subscription.data.subscription.unsubscribe()
    this.client.auth.startAutoRefresh()
    this.initialized = true

    const recoveryPending = await this.storage.getItem(RECOVERY_MARKER_KEY) !== null
    const { data, error } = await this.client.auth.getSession()
    if (error) {
      this.setState({
        ...signedOutState('Authentication will retry when the network is available.'),
        phase: 'degraded',
      })
    } else if (data.session) {
      this.setStateFromSession(data.session, recoveryPending)
    } else {
      this.setState(recoveryPending
        ? { ...signedOutState('Finish password recovery before enabling remote control.'), phase: 'recovery' }
        : signedOutState())
    }
    return this.getPublicState()
  }

  async signUp(email: string, password: string, nickname?: string): Promise<RemotePublicAuthState> {
    const client = this.requireClient()
    const credentials = this.validateCredentials(email, password)
    const displayName = nickname === undefined ? undefined : this.validateNickname(nickname)
    const { data, error } = await client.auth.signUp({
      ...credentials,
      options: {
        emailRedirectTo: this.config.callbackUrl,
        ...(displayName ? { data: { display_name: displayName } } : {}),
      },
    })
    if (error) throw new Error(publicMessage(error, 'Registration failed.'))
    if (data.session) await this.setStateFromSessionRespectingRecovery(data.session)
    else this.setState({
      ...signedOutState('Check your email to confirm the new account.'),
      email: data.user?.email ?? credentials.email,
    })
    return this.getPublicState()
  }

  async resendSignupVerification(email: string): Promise<void> {
    const client = this.requireClient()
    const { error } = await client.auth.resend({
      type: 'signup',
      email: this.validateEmail(email),
      options: { emailRedirectTo: this.config.callbackUrl },
    })
    if (error) throw new Error(publicMessage(error, 'Confirmation email could not be resent.'))
  }

  async signIn(email: string, password: string): Promise<RemotePublicAuthState> {
    const client = this.requireClient()
    const credentials = this.validateCredentials(email, password)
    const { data, error } = await client.auth.signInWithPassword(credentials)
    if (error || !data.session) throw new Error(publicMessage(error, 'Sign-in failed.'))
    await this.setStateFromSessionRespectingRecovery(data.session)
    return this.getPublicState()
  }

  async signOut(): Promise<RemotePublicAuthState> {
    const client = this.requireClient()
    const { error } = await client.auth.signOut({ scope: 'local' })
    if (error) throw new Error(publicMessage(error, 'Sign-out failed.'))
    await this.storage.removeItem(RECOVERY_MARKER_KEY)
    this.setState(signedOutState())
    return this.getPublicState()
  }

  async requestPasswordRecovery(email: string): Promise<RemotePublicAuthState> {
    const client = this.requireClient()
    const normalizedEmail = this.validateEmail(email)
    await this.markRecoveryPending()
    const { error } = await client.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: this.config.callbackUrl,
    })
    if (error) {
      await this.storage.removeItem(RECOVERY_MARKER_KEY)
      throw new Error(publicMessage(error, 'Password recovery could not be requested.'))
    }
    return this.getPublicState()
  }

  async handleCallback(callbackUrl: string, purpose: 'email-confirmation' | 'recovery'): Promise<RemotePublicAuthState> {
    const client = this.requireClient()
    const callback = this.parseCallback(callbackUrl)
    const recoveryPending = await this.storage.getItem(RECOVERY_MARKER_KEY) !== null
    if (purpose === 'recovery' && !recoveryPending) {
      throw new Error('No password recovery is pending on this workstation.')
    }
    const { data, error } = await client.auth.exchangeCodeForSession(callback.code)
    if (error || !data.session) throw new Error(publicMessage(error, 'Authentication callback failed.'))
    // The caller may assert recovery, but it may never downgrade one. The
    // encrypted Core marker keeps Remote locked until the password is changed.
    this.setStateFromSession(data.session, recoveryPending)
    return this.getPublicState()
  }

  async completePasswordRecovery(newPassword: string): Promise<RemotePublicAuthState> {
    const client = this.requireClient()
    if (await this.storage.getItem(RECOVERY_MARKER_KEY) === null || this.state.phase !== 'recovery') {
      throw new Error('No verified password recovery session is active.')
    }
    this.validatePassword(newPassword)
    const { data, error } = await client.auth.updateUser({ password: newPassword })
    if (error || !data.user) throw new Error(publicMessage(error, 'Password update failed.'))
    await this.storage.removeItem(RECOVERY_MARKER_KEY)
    const session = (await client.auth.getSession()).data.session
    if (!session) throw new Error('Password changed, but the local session must be refreshed before remote control can resume.')
    // updateUser may have emitted a TOKEN_REFRESHED event while the encrypted
    // marker still existed. Drain that event before publishing the final
    // marker-free state so an older callback cannot relock a completed flow.
    await this.authEventQueue
    this.setStateFromSession(session)
    return this.getPublicState()
  }

  async verifyAccessToken(token: string): Promise<VerifiedSupabaseClaims> {
    const client = this.requireClient()
    if (!token || token.length > 8_192 || !/^[A-Za-z0-9._~-]+$/.test(token)) {
      throw new Error('Access token is invalid.')
    }
    const { data, error } = await settleWithin(client.auth.getClaims(token), this.networkTimeoutMs)
    if (error || !data) throw new Error('Access token could not be verified.')
    const claims = data.claims
    const nowSeconds = Math.floor(this.now() / 1_000)
    const expectedIssuer = `${this.config.url}/auth/v1`
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== expectedIssuer
      || !audiences.includes('authenticated')
      || claims.role !== 'authenticated'
      || !UUID_PATTERN.test(claims.sub)
      || !Number.isSafeInteger(claims.exp)
      || claims.exp <= nowSeconds
      || typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 30
      || !Number.isSafeInteger(claims.iat)
      || claims.iat > nowSeconds + 30
      || typeof claims.session_id !== 'string'
      || !UUID_PATTERN.test(claims.session_id)) {
      throw new Error('Access token claims are not valid for Agent Console.')
    }
    return {
      userId: claims.sub.toLowerCase(),
      email: typeof claims.email === 'string' ? claims.email.slice(0, 320) : null,
      expiresAt: claims.exp,
      issuedAt: claims.iat,
      sessionId: claims.session_id.toLowerCase(),
    }
  }

  /** Core-only bridge for RLS-protected metadata operations; never expose it over IPC. */
  async withAuthenticatedDatabase<T>(
    operation: (database: AuthenticatedSupabaseDatabase, userId: string) => Promise<T>,
  ): Promise<T> {
    const client = this.requireClient()
    if (this.state.phase !== 'signed_in' || !this.state.remoteAllowed || !this.state.userId) {
      throw new Error('A verified signed-in session is required for remote metadata synchronization.')
    }
    return operation(client, this.state.userId)
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.client?.auth.stopAutoRefresh()
    this.client = null
    this.initialized = false
    this.listeners.clear()
    await this.authEventQueue.catch(() => undefined)
    await this.storage.close()
  }

  private requireClient(): SupabaseClient {
    if (!this.initialized || !this.client) throw new Error('Supabase authentication is not initialized.')
    if (this.state.phase === 'locked') throw new Error('Authentication is locked because secure storage is unavailable.')
    return this.client
  }

  private setStateFromSession(session: Session, recovery = false): void {
    const user: User = session.user
    this.setState({
      phase: recovery ? 'recovery' : 'signed_in',
      userId: user.id.toLowerCase(),
      email: user.email ?? null,
      emailConfirmed: Boolean(user.email_confirmed_at),
      sessionExpiresAt: session.expires_at ? new Date(session.expires_at * 1_000).toISOString() : null,
      remoteAllowed: !recovery && Boolean(user.email_confirmed_at),
      message: recovery
        ? 'Choose a new password before remote control can resume.'
        : user.email_confirmed_at
          ? 'Signed in securely.'
          : 'Confirm your email before enabling remote control.',
    })
  }

  private async setStateFromSessionRespectingRecovery(session: Session): Promise<void> {
    this.setStateFromSession(session, await this.storage.getItem(RECOVERY_MARKER_KEY) !== null)
  }

  private setState(state: RemotePublicAuthState): void {
    this.state = { ...state }
    for (const listener of this.listeners) listener(this.getPublicState())
  }

  private queueAuthStateEvent(event: string, session: Session | null): void {
    this.authEventQueue = this.authEventQueue.then(async () => {
      if (event === 'PASSWORD_RECOVERY') {
        await this.markRecoveryPending()
        return
      }
      const recoveryPending = await this.storage.getItem(RECOVERY_MARKER_KEY) !== null
      if (event === 'SIGNED_OUT') {
        this.setState(recoveryPending
          ? { ...signedOutState('Finish password recovery before enabling remote control.'), phase: 'recovery' }
          : signedOutState())
        return
      }
      if (session) this.setStateFromSession(session, recoveryPending)
    }).catch(() => {
      this.setState({
        ...this.state,
        phase: 'locked',
        remoteAllowed: false,
        message: 'Authentication state could not be secured. Remote control remains locked.',
      })
    })
  }

  private async markRecoveryPending(): Promise<void> {
    await this.storage.setItem(RECOVERY_MARKER_KEY, JSON.stringify({ id: randomUUID(), createdAt: new Date(this.now()).toISOString() }))
    this.setState({
      ...this.state,
      phase: 'recovery',
      remoteAllowed: false,
      message: 'Password recovery is in progress. Remote control is locked.',
    })
  }

  private parseCallback(callbackUrl: string): { code: string } {
    if (typeof callbackUrl !== 'string' || callbackUrl.length > 4_096) {
      throw new Error('Authentication callback is invalid.')
    }
    let callback: URL
    try {
      callback = new URL(callbackUrl)
    } catch {
      throw new Error('Authentication callback is invalid.')
    }
    if (callback.protocol !== 'agent-console:'
      || callback.hostname !== 'auth'
      || callback.pathname !== '/callback'
      || callback.username
      || callback.password
      || callback.port
      || callback.hash) {
      throw new Error('Authentication callback target is invalid.')
    }
    const allowed = new Set(['code', 'error', 'error_code', 'error_description'])
    for (const key of new Set(callback.searchParams.keys())) {
      if (!allowed.has(key) || callback.searchParams.getAll(key).length !== 1) {
        throw new Error('Authentication callback query is invalid.')
      }
    }
    if (callback.searchParams.has('error') || callback.searchParams.has('error_code')) {
      throw new Error('Authentication provider rejected the callback.')
    }
    if (callback.searchParams.has('error_description')) {
      throw new Error('Authentication callback query is invalid.')
    }
    const codes = callback.searchParams.getAll('code')
    if (codes.length !== 1 || !/^[A-Za-z0-9._~-]{8,2048}$/.test(codes[0])) {
      throw new Error('Authentication callback code is invalid.')
    }
    return { code: codes[0] }
  }

  private validateCredentials(email: string, password: string): { email: string; password: string } {
    return { email: this.validateEmail(email), password: this.validatePassword(password) }
  }

  private validateEmail(email: string): string {
    const value = email.trim().toLowerCase()
    if (value.length < 3 || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new Error('Email address is invalid.')
    }
    return value
  }

  private validatePassword(password: string): string {
    if (typeof password !== 'string' || password.length < 8 || password.length > 1_024) {
      throw new Error('Password must contain between 8 and 1,024 characters.')
    }
    return password
  }

  private validateNickname(nickname: string): string {
    if (typeof nickname !== 'string') throw new Error('Nickname is invalid.')
    const value = nickname.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
    if (!value || value.length > 80) throw new Error('Nickname must contain between 1 and 80 characters.')
    return value
  }
}
