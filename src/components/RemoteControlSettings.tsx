import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleAlert,
  CloudCog,
  KeyRound,
  Laptop,
  LoaderCircle,
  LogIn,
  LogOut,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Trash2,
  Unplug,
  UserPlus,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  RemoteAgentPermissionSet,
  RemotePairingView,
  RemoteServiceCheck,
  RemoteSettingsState,
} from '../../shared/remote-settings'
import type { AgentConsoleApi } from '../../shared/types'
import { getApi } from '../lib/api'
import { useI18n } from '../lib/i18n'

type RemoteActionName =
  | 'sign-up'
  | 'sign-in'
  | 'sign-out'
  | 'verification'
  | 'password-reset'
  | 'password-recovery'
  | 'enable'
  | 'disable'
  | 'pairing'
  | 'pairing-decision'
  | 'device'
  | 'permission'
  | 'rename'
  | 'doctor'
  | 'remove-workstation'

interface RemoteActions {
  signUp: (email: string, password: string, nickname: string) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  resendVerification: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  completePasswordRecovery: (newPassword: string) => Promise<void>
  enable: () => Promise<void>
  disable: () => Promise<void>
  beginPairing: () => Promise<void>
  cancelPairing: (pairingId: string) => Promise<void>
  decidePairing: (pairingId: string, approve: boolean) => Promise<void>
  revokeDevice: (deviceId: string) => Promise<void>
  retryDevice: (deviceId: string) => Promise<void>
  updatePermission: (agentId: string, permissions: RemoteAgentPermissionSet) => Promise<void>
  renameWorkstation: (displayName: string) => Promise<void>
  runDoctor: () => Promise<void>
  removeWorkstation: (confirmationName: string) => Promise<void>
}

export interface RemoteControlSettingsViewProps {
  state: RemoteSettingsState
  busyAction: RemoteActionName | null
  error: string | null
  actions: RemoteActions
}

const EMPTY_PERMISSIONS: RemoteAgentPermissionSet = {
  viewStatus: false,
  viewEvents: false,
  message: false,
  approve: false,
  interrupt: false,
}

const PERMISSION_LABELS: Record<keyof RemoteAgentPermissionSet, string> = {
  viewStatus: 'Status',
  viewEvents: 'Events',
  message: 'Message',
  approve: 'Approve',
  interrupt: 'Interrupt',
}

export function normalizedPermissions(
  current: RemoteAgentPermissionSet,
  key: keyof RemoteAgentPermissionSet,
  enabled: boolean,
): RemoteAgentPermissionSet {
  const next = { ...current, [key]: enabled }
  if (key === 'viewStatus' || key === 'viewEvents') {
    next.viewStatus = enabled
    next.viewEvents = enabled
  }
  if (enabled) {
    next.viewStatus = true
    if (key === 'viewEvents' || key === 'message' || key === 'approve' || key === 'interrupt') next.viewEvents = true
    if (key === 'message') next.message = true
  }
  if (!next.viewStatus) return { ...EMPTY_PERMISSIONS }
  if (!next.viewEvents) return { ...next, message: false, approve: false }
  return next
}

function StatusPill({ state }: { state: RemoteSettingsState['phase'] }) {
  const { t } = useI18n()
  const ready = state === 'ready'
  const warning = state === 'starting' || state === 'verification-required' || state === 'password-recovery'
  const icon = ready ? <Wifi size={13} /> : warning ? <LoaderCircle className={state === 'starting' ? 'is-spinning' : ''} size={13} /> : <WifiOff size={13} />
  return <span className={`remote-status-pill remote-status-pill--${ready ? 'ready' : warning ? 'warning' : 'offline'}`}>{icon}{t(state.replaceAll('-', ' '))}</span>
}

function CheckRow({ check }: { check: RemoteServiceCheck }) {
  const { t, message, formatDateTime } = useI18n()
  const icon = check.state === 'pass'
    ? <Check size={13} />
    : check.state === 'pending'
      ? <LoaderCircle className="is-spinning" size={13} />
      : check.state === 'warning' || check.state === 'not-run'
        ? <AlertTriangle size={13} />
        : <CircleAlert size={13} />
  return (
    <li className={`remote-check remote-check--${check.state}`}>
      <span>{icon}</span>
      <div><strong>{message(check.label)}</strong><small>{message(check.detail)}</small></div>
      <time>{check.checkedAt ? formatDateTime(check.checkedAt) : t('Not checked')}</time>
    </li>
  )
}

function PairingPanel({ pairing, busy, actions }: { pairing: RemotePairingView; busy: boolean; actions: RemoteActions }) {
  const { t } = useI18n()
  const seconds = Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1_000))
  const minutes = Math.ceil(seconds / 60)
  return (
    <div className="remote-pairing" aria-live="polite">
      <div className="remote-pairing__qr">
        {pairing.qrDataUrl?.startsWith('data:image/png;base64,')
          ? <img src={pairing.qrDataUrl} alt={t('One-time Agent Console Remote pairing QR code')} />
          : <QrCode size={62} aria-hidden="true" />}
      </div>
      <div className="remote-pairing__copy">
        <strong>{t(pairing.stage === 'showing-code' ? 'Scan with Agent Console Remote' : 'Confirm this phone on the computer')}</strong>
        <p>{t(minutes === 1 ? 'This code works once and expires in about {{count}} minute.' : 'This code works once and expires in about {{count}} minutes.', { count: minutes })}</p>
        <span className="remote-sas" aria-label={t('Safety code {{code}}', { code: pairing.sas.split('').join(' ') })}>{pairing.sas}</span>
        {pairing.candidateDeviceName && <small>{t('Phone requesting access: {{name}}. Make sure the same six digits appear on the phone.', { name: pairing.candidateDeviceName })}</small>}
        <div className="remote-inline-actions">
          {pairing.stage === 'awaiting-computer-confirmation' && (
            <>
              <button type="button" className="action-button" disabled={busy} onClick={() => void actions.decidePairing(pairing.pairingId, false)}>{t('Reject')}</button>
              <button type="button" className="action-button action-button--primary" disabled={busy} onClick={() => void actions.decidePairing(pairing.pairingId, true)}><ShieldCheck size={14} /> {t('Confirm phone')}</button>
            </>
          )}
          <button type="button" className="text-button" disabled={busy} onClick={() => void actions.cancelPairing(pairing.pairingId)}>{t('Cancel pairing')}</button>
        </div>
      </div>
    </div>
  )
}

function Section({ icon, title, description, action, children, className = '' }: { icon: ReactNode; title: string; description: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`settings-section remote-settings-section ${className}`}>
      <header className="settings-section__header">
        <span>{icon}</span>
        <div><strong>{title}</strong><small>{description}</small></div>
        {action}
      </header>
      {children}
    </section>
  )
}

export function RemoteControlSettingsView({ state, busyAction, error, actions }: RemoteControlSettingsViewProps) {
  const { t, message, formatDateTime } = useI18n()
  const [authMode, setAuthMode] = useState<'sign-in' | 'register'>('sign-in')
  const [email, setEmail] = useState(state.account?.email ?? '')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [workstationName, setWorkstationName] = useState(state.workstation?.displayName ?? '')
  const [removeConfirmation, setRemoveConfirmation] = useState('')
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null)
  const signedOut = state.phase === 'signed-out' || state.phase === 'unconfigured'
  const enabled = state.gateway.enabled
  const reachable = state.phase === 'ready'

  useEffect(() => {
    if (state.workstation) setWorkstationName(state.workstation.displayName)
  }, [state.workstation?.displayName])

  const canSubmitAuth = email.trim().length > 3 && password.length >= 8 && (authMode === 'sign-in' || nickname.trim().length > 0)

  if (state.phase === 'secure-storage-unavailable') {
    return (
      <div className="remote-control-settings">
        <Section icon={<ShieldOff size={17} />} title={t('Mobile Remote is locked')} description={t('Remote access will not use plaintext credential storage.')} className="remote-settings-section--blocked">
          <div className="remote-blocking-notice"><ShieldOff size={22} /><div><strong>{t('Secure Linux storage is unavailable')}</strong><p>{message(state.message)}</p><small>{t('Unlock your desktop keyring, then restart Agent Console. Existing local Projects and Agents are unaffected.')}</small></div></div>
        </Section>
      </div>
    )
  }

  if (state.phase === 'unconfigured') {
    return (
      <div className="remote-control-settings">
        <Section icon={<CloudCog size={17} />} title={t('Mobile Remote needs administrator setup')} description={t('Registration stays disabled until public service settings have been installed.')}>
          <div className="remote-blocking-notice"><CloudCog size={22} /><div><strong>{t('Remote service is not configured')}</strong><p>{message(state.message)}</p><small>{t('Install a private remote.env file with mode 0600, then run Agent Console Remote Doctor. Do not paste a Supabase secret or VPS private key into this screen.')}</small></div></div>
        </Section>
      </div>
    )
  }

  if (state.phase === 'password-recovery') {
    const recoveryReady = newPassword.length >= 8 && newPassword === confirmPassword
    return (
      <div className="remote-control-settings">
        <Section icon={<KeyRound size={17} />} title={t('Choose a new password')} description={t('Remote access remains locked until recovery finishes in secure storage.')}>
          <div className="remote-auth-card">
            <div className="remote-auth-fields">
              <label><span>{t('New password')}</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
              <label><span>{t('Confirm new password')}</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /><small>{t('Use at least 8 characters. Remote services stay disabled during recovery.')}</small></label>
            </div>
            {confirmPassword && newPassword !== confirmPassword && <div className="remote-error" role="alert"><CircleAlert size={14} /> {t('Passwords do not match.')}</div>}
            {error && <div className="remote-error" role="alert"><CircleAlert size={14} /> {message(error)}</div>}
            <footer><button type="button" className="action-button action-button--primary" disabled={!recoveryReady || busyAction !== null} onClick={() => void actions.completePasswordRecovery(newPassword)}>{busyAction === 'password-recovery' ? <LoaderCircle className="is-spinning" size={14} /> : <KeyRound size={14} />} {t('Save new password')}</button></footer>
          </div>
        </Section>
      </div>
    )
  }

  if (signedOut) {
    return (
      <div className="remote-control-settings">
        <Section icon={<Smartphone size={17} />} title={t('Mobile Remote')} description={t('Sign in first. Login alone never grants a phone access to this computer.')}>
          <div className="remote-auth-card">
            <div className="remote-auth-tabs" role="tablist" aria-label={t('Remote account action')}>
              <button type="button" role="tab" aria-selected={authMode === 'sign-in'} className={authMode === 'sign-in' ? 'is-selected' : ''} onClick={() => setAuthMode('sign-in')}><LogIn size={14} /> {t('Sign in')}</button>
              <button type="button" role="tab" aria-selected={authMode === 'register'} className={authMode === 'register' ? 'is-selected' : ''} onClick={() => setAuthMode('register')}><UserPlus size={14} /> {t('Create account')}</button>
            </div>
            <div className="remote-auth-fields">
              <label><span>{t('Email (login account)')}</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              {authMode === 'register' && <label><span>{t('Display name')}</span><input autoComplete="nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} /></label>}
              <label><span>{t('Password')}</span><input type="password" autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /><small>{t('Use at least 8 characters. Agent Console never returns this password to the renderer after submission.')}</small></label>
            </div>
            {error && <div className="remote-error" role="alert"><CircleAlert size={14} /> {message(error)}</div>}
            <footer>
              {authMode === 'sign-in' && <button type="button" className="text-button" disabled={!email.trim() || busyAction !== null} onClick={() => void actions.requestPasswordReset(email.trim())}>{t('Forgot password?')}</button>}
              <button
                type="button"
                className="action-button action-button--primary"
                disabled={!canSubmitAuth || busyAction !== null}
                onClick={() => void (authMode === 'register' ? actions.signUp(email.trim(), password, nickname.trim()) : actions.signIn(email.trim(), password))}
              >
                {busyAction === (authMode === 'register' ? 'sign-up' : 'sign-in') ? <LoaderCircle className="is-spinning" size={14} /> : authMode === 'register' ? <UserPlus size={14} /> : <LogIn size={14} />}
                {t(authMode === 'register' ? 'Create account' : 'Sign in')}
              </button>
            </footer>
          </div>
        </Section>
      </div>
    )
  }

  return (
    <div className="remote-control-settings">
      <Section
        icon={<Smartphone size={17} />}
        title={t('Mobile Remote')}
        description={t('A limited Agent remote control channel — never a general terminal.')}
        action={<StatusPill state={state.phase} />}
      >
        <div className={`remote-overview remote-overview--${state.phase}`}>
          <div className="remote-overview__hero">
            <span>{reachable ? <Wifi size={24} /> : <WifiOff size={24} />}</span>
            <div><strong>{t(reachable
              ? 'The signed public Remote path passed its health check'
              : enabled
                ? 'Mobile Remote is enabled but needs attention'
                : 'Mobile Remote is off')}</strong><p>{message(state.message)}</p></div>
            <button type="button" className={`action-button ${enabled ? '' : 'action-button--primary'}`} disabled={busyAction !== null || (!enabled && !state.capabilities.canEnable)} onClick={() => void (enabled ? actions.disable() : actions.enable())}>
              {busyAction === 'enable' || busyAction === 'disable' ? <LoaderCircle className="is-spinning" size={14} /> : enabled ? <Unplug size={14} /> : <Wifi size={14} />}
              {t(enabled ? 'Turn off remote' : 'Turn on remote')}
            </button>
          </div>
          <div className="remote-overview__facts">
            <div><small>{t('Computer')}</small><strong>{state.workstation?.displayName ?? t('Not registered')}</strong></div>
            <div><small>{t('Public entry')}</small><strong>{state.gateway.publicBaseUrl ?? t('Not configured')}</strong></div>
            <div><small>{t('Local Gateway')}</small><strong>{state.gateway.localAddress ?? t('Not listening')}</strong></div>
            <div><small>{t('Last reachable')}</small><strong>{state.gateway.lastReachableAt ? formatDateTime(state.gateway.lastReachableAt) : t('Never')}</strong></div>
          </div>
          {error && <div className="remote-error" role="alert"><CircleAlert size={14} /> {message(error)}</div>}
        </div>
      </Section>

      {state.phase === 'verification-required' && (
        <Section icon={<KeyRound size={17} />} title={t('Verify your email')} description={t('No Gateway or pairing code is available until this account is verified.')}>
          <div className="remote-verification"><p>{t('We sent a verification message to {{email}}.', { email: state.account?.email ?? '' })}</p><button type="button" className="action-button" disabled={busyAction !== null} onClick={() => void actions.resendVerification()}><RefreshCw size={14} /> {t('Send again')}</button></div>
        </Section>
      )}

      {state.account?.emailVerified && (
        <>
          <Section
            icon={<CloudCog size={17} />}
            title={t('Connection check')}
            description={t('Core stays Unix-only; only Gateway may listen, and only on 127.0.0.1.')}
            action={<button type="button" className="action-button" disabled={!state.capabilities.canRunDoctor || busyAction !== null} onClick={() => void actions.runDoctor()}>{busyAction === 'doctor' ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />} {t('Run Doctor')}</button>}
          >
            <ul className="remote-check-list">{state.checks.map((check) => <CheckRow key={check.id} check={check} />)}</ul>
          </Section>

          <Section
            icon={<QrCode size={17} />}
            title={t('Paired phones')}
            description={t('Each phone has its own public key and can be revoked without changing your password.')}
            action={!state.pairing && <button type="button" className="action-button action-button--primary" disabled={!state.capabilities.canPair || busyAction !== null} onClick={() => void actions.beginPairing()}><QrCode size={14} /> {t('Add phone')}</button>}
          >
            {state.pairing && <PairingPanel pairing={state.pairing} busy={busyAction !== null} actions={actions} />}
            {!state.pairing && state.devices.length === 0 && <div className="remote-empty"><Smartphone size={21} /><div><strong>{t('No phone is paired')}</strong><small>{t('Turn on Mobile Remote, then create a five-minute one-time QR code.')}</small></div></div>}
            <div className="remote-device-list">
              {state.devices.map((device) => (
                <article key={device.deviceId} className={`remote-device remote-device--${device.state}`}>
                  <span><Smartphone size={17} /></span>
                  <div><strong>{device.displayName}</strong><small>{t('Paired {{paired}} · Last seen {{lastSeen}}', { paired: formatDateTime(device.pairedAt), lastSeen: device.lastSeenAt ? formatDateTime(device.lastSeenAt) : t('Never') })}</small>{device.state === 'pending-cloud-sync' && <em>{t('Local access is already blocked; cloud sync still needs retrying.')}</em>}</div>
                  {device.state === 'pending-cloud-sync' && <button type="button" className="action-button" disabled={busyAction !== null} onClick={() => void actions.retryDevice(device.deviceId)}><RefreshCw size={13} /> {t('Retry')}</button>}
                  {device.state !== 'revoked' && pendingRevoke !== device.deviceId && <button type="button" className="text-button text-button--danger" disabled={busyAction !== null} onClick={() => setPendingRevoke(device.deviceId)}>{t('Revoke')}</button>}
                  {pendingRevoke === device.deviceId && <div className="remote-revoke-confirm"><button type="button" className="action-button" onClick={() => setPendingRevoke(null)}>{t('Keep')}</button><button type="button" className="danger-button" disabled={busyAction !== null} onClick={() => void actions.revokeDevice(device.deviceId)}><Trash2 size={13} /> {t('Revoke now')}</button></div>}
                </article>
              ))}
            </div>
          </Section>

          <Section icon={<ShieldCheck size={17} />} title={t('Agent permissions')} description={t('New Agents are hidden from phones. Events are redacted summaries, never terminal output.')}>
            {state.agents.length === 0
              ? <div className="remote-empty"><ShieldCheck size={21} /><div><strong>{t('No Agent permissions yet')}</strong><small>{t('Add an Agent to a Project before allowing phone access.')}</small></div></div>
              : <div className="remote-permission-table">
                  <div className="remote-permission-table__head"><span>{t('Agent')}</span><span>{t('Status')}</span><span>{t('Events')}</span><span>{t('Message')}</span><span>{t('Approve')}</span><span>{t('Interrupt')}</span></div>
                  {state.agents.map((agent) => (
                    <div className="remote-permission-row" key={agent.agentId} style={{ '--agent-color': agent.color } as CSSProperties}>
                      <div><i /><span><strong>{agent.agentName}</strong><small>{agent.projectName}{agent.pendingCloudSync ? ` · ${t('sync pending')}` : ''}</small></span></div>
                      {(Object.keys(EMPTY_PERMISSIONS) as Array<keyof RemoteAgentPermissionSet>).map((permission) => (
                        <label key={permission} title={permission === 'approve' ? t('Only one explicit, structured approval at a time') : undefined}>
                          <input
                            type="checkbox"
                            checked={agent.permissions[permission]}
                            disabled={busyAction !== null}
                            aria-label={`${agent.agentName}: ${t(PERMISSION_LABELS[permission])}`}
                            onChange={(event) => void actions.updatePermission(agent.agentId, normalizedPermissions(agent.permissions, permission, event.target.checked))}
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                </div>}
          </Section>

          <Section icon={<Laptop size={17} />} title={t('Account and this computer')} description={t('Signing out does not silently delete keys or leave a half-removed workstation.')}>
            <div className="remote-account-grid">
              <div className="remote-account-card"><small>{t('Signed in as')}</small><strong>{state.account.email}</strong><span>{state.account.nickname}</span><button type="button" className="text-button" disabled={busyAction !== null} onClick={() => void actions.signOut()}><LogOut size={13} /> {t('Sign out')}</button></div>
              <div className="remote-rename-card"><label><span>{t('Computer name')}</span><input value={workstationName} onChange={(event) => setWorkstationName(event.target.value)} /></label><button type="button" className="action-button" disabled={!workstationName.trim() || workstationName.trim() === state.workstation?.displayName || busyAction !== null} onClick={() => void actions.renameWorkstation(workstationName.trim())}>{t('Save name')}</button></div>
            </div>
            {state.workstation?.pendingCloudSync && <div className="remote-warning"><AlertTriangle size={14} /> {t('This computer has a cloud sync change waiting to retry.')}</div>}
            {state.capabilities.canRemoveWorkstation && <details className="remote-danger-zone">
              <summary><Trash2 size={14} /> {t('Remove this workstation')} <ChevronRight size={13} /></summary>
              <p>{t('This first turns remote access off and revokes phones. The local encrypted key is deleted only after cloud removal succeeds.')}</p>
              <label><span>{t('Type {{name}} to confirm', { name: state.workstation?.displayName ?? '' })}</span><input value={removeConfirmation} onChange={(event) => setRemoveConfirmation(event.target.value)} /></label>
              <button type="button" className="danger-button" disabled={removeConfirmation !== state.workstation?.displayName || busyAction !== null} onClick={() => void actions.removeWorkstation(removeConfirmation)}><Trash2 size={13} /> {t('Remove workstation')}</button>
            </details>}
          </Section>
        </>
      )}
    </div>
  )
}

export function RemoteControlSettings({ api: providedApi }: { api?: AgentConsoleApi }) {
  const { t, message } = useI18n()
  const api = useMemo(() => providedApi ?? getApi(), [providedApi])
  const [state, setState] = useState<RemoteSettingsState | null>(null)
  const [busyAction, setBusyAction] = useState<RemoteActionName | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void api.getRemoteSettings().then((next) => {
      if (active) setState(next)
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    const unsubscribe = api.onRemoteSettings((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  const run = async (name: RemoteActionName, operation: () => Promise<RemoteSettingsState | void>) => {
    if (busyAction) return
    setBusyAction(name)
    setError(null)
    try {
      const next = await operation()
      if (next) setState(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAction(null)
    }
  }

  const actions: RemoteActions = {
    signUp: (email, password, nickname) => run('sign-up', () => api.remoteSignUp({ email, password, nickname })),
    signIn: (email, password) => run('sign-in', () => api.remoteSignIn({ email, password })),
    signOut: () => run('sign-out', () => api.remoteSignOut()),
    resendVerification: () => run('verification', () => api.remoteResendVerification()),
    requestPasswordReset: (email) => run('password-reset', async () => { await api.remoteRequestPasswordReset(email) }),
    completePasswordRecovery: (newPassword) => run('password-recovery', () => api.remoteCompletePasswordRecovery({ newPassword })),
    enable: () => run('enable', () => api.remoteEnable()),
    disable: () => run('disable', () => api.remoteDisable()),
    beginPairing: () => run('pairing', () => api.remoteBeginPairing()),
    cancelPairing: (pairingId) => run('pairing', () => api.remoteCancelPairing(pairingId)),
    decidePairing: (pairingId, approve) => run('pairing-decision', () => api.remoteDecidePairing({ pairingId, approve })),
    revokeDevice: (deviceId) => run('device', () => api.remoteRevokeDevice(deviceId)),
    retryDevice: (deviceId) => run('device', () => api.remoteRetryDeviceSync(deviceId)),
    updatePermission: (agentId, permissions) => run('permission', () => api.remoteUpdateAgentPermission({ agentId, permissions })),
    renameWorkstation: (displayName) => run('rename', () => api.remoteRenameWorkstation(displayName)),
    runDoctor: () => run('doctor', () => api.remoteRunDoctor()),
    removeWorkstation: (confirmationName) => run('remove-workstation', () => api.remoteRemoveWorkstation({ confirmationName })),
  }

  if (!state) {
    return <div className="remote-settings-loading" role="status"><LoaderCircle className="is-spinning" size={18} /><span>{error ? message(error) : t('Loading Mobile Remote settings…')}</span></div>
  }

  return <RemoteControlSettingsView state={state} busyAction={busyAction} error={error} actions={actions} />
}
