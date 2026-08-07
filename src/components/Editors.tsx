import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleAlert,
  Download,
  ExternalLink,
  Languages,
  MonitorUp,
  Palette,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Type,
} from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import type {
  AgentConfig,
  AgentKind,
  AgentStatus,
  ConsoleSettings,
  CoreConnectionPhase,
  CoreConnectionState,
  CoreHealth,
  Project,
  TerminalApp,
  UpdateState,
} from '../../shared/types'
import { installationKindLabel } from '../../shared/update-helpers'
import { uniqueId } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { THEMES } from '../lib/themes'
import { Modal } from './Modal'
import { RemoteControlSettings } from './RemoteControlSettings'

const COLORS = ['#55a6ff', '#a478ff', '#54c79b', '#f6b94b', '#ef6f7a', '#8b98a9']
const KINDS: AgentKind[] = ['codex', 'backend', 'worker', 'python', 'node', 'docker', 'tmux', 'terminal', 'process']
const TERMINALS: TerminalApp[] = ['auto', 'ghostty', 'gnome-terminal', 'kitty', 'konsole', 'xfce4-terminal', 'x-terminal-emulator']
const STATUSES: AgentStatus[] = ['thinking', 'running', 'waiting', 'idle', 'finished', 'error', 'stopped', 'offline']

interface AgentEditorProps {
  projects: Project[]
  initial: Partial<AgentConfig>
  existing: boolean
  onSave: (agent: AgentConfig) => void
  onDelete?: () => void
  onClose: () => void
}

interface DeleteConfirmationProps {
  subject: string
  detail: string
  confirmLabel: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteConfirmation({
  subject,
  detail,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: DeleteConfirmationProps) {
  const { t } = useI18n()
  return (
    <div className="delete-confirmation" role="alert">
      <AlertTriangle size={16} />
      <span><strong>{subject}</strong><small>{detail}</small></span>
      <div>
        <button type="button" className="action-button" autoFocus disabled={busy} onClick={onCancel}>{t('Keep it')}</button>
        <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>
          <Trash2 size={14} /> {busy ? t('Deleting…') : confirmLabel}
        </button>
      </div>
    </div>
  )
}

export function AgentEditor({ projects, initial, existing, onSave, onDelete, onClose }: AgentEditorProps) {
  const { t } = useI18n()
  const firstProject = projects[0]
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState<AgentConfig>({
    id: initial.id ?? uniqueId('agent'),
    projectId: initial.projectId ?? firstProject?.id ?? 'inbox',
    name: initial.name ?? t('New Agent'),
    emoji: initial.emoji ?? '◆',
    color: initial.color ?? '#55a6ff',
    kind: initial.kind ?? 'codex',
    terminalTitle: initial.terminalTitle ?? `◆ ${t('New Agent')}`,
    terminalApp: initial.terminalApp ?? 'auto',
    tmuxSession: initial.tmuxSession ?? '',
    command: initial.command ?? '',
    cwd: initial.cwd ?? '',
    matchPattern: initial.matchPattern ?? '',
    logPath: initial.logPath ?? '',
    autoStart: initial.autoStart ?? false,
    order: initial.order ?? 0,
    pid: initial.pid ?? null,
    statusOverride: initial.statusOverride ?? null,
  })

  const update = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (deletePending || !draft.name.trim() || !draft.projectId) return
    const cleanName = draft.name.trim()
    onSave({
      ...draft,
      name: cleanName,
      terminalTitle: draft.terminalTitle.trim() || `${draft.emoji} ${cleanName}`,
      tmuxSession: draft.tmuxSession.replace(/[^a-zA-Z0-9_.-]/g, '-'),
      cwd: draft.cwd.trim(),
    })
  }

  const cancelDelete = () => {
    setDeletePending(false)
    window.requestAnimationFrame(() => deleteButtonRef.current?.focus({ preventScroll: true }))
  }

  const requestClose = () => {
    if (deletePending) cancelDelete()
    else onClose()
  }

  const confirmDelete = () => {
    if (!onDelete || deleting) return
    setDeleting(true)
    onDelete()
  }

  return (
    <Modal
      title={existing ? t('Edit {{name}}', { name: initial.name ?? draft.name }) : t('Add Agent')}
      subtitle={t('Define how this process is identified and how its terminal should open.')}
      onClose={requestClose}
      size="large"
    >
      <form className="editor-form" onSubmit={submit}>
        <section className="form-section">
          <div className="form-section__title"><span>01</span><div><strong>{t('Identity')}</strong><small>{t('How this Agent appears in Mission Control')}</small></div></div>
          <div className="form-grid form-grid--identity">
            <label><span>{t('Name')}</span><input required value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
            <label><span>{t('Project')}</span><select value={draft.projectId} onChange={(event) => update('projectId', event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.emoji} {project.name}</option>)}</select></label>
            <label><span>{t('Symbol')}</span><input className="emoji-input" value={draft.emoji} maxLength={8} onChange={(event) => update('emoji', event.target.value)} /></label>
            <label><span>{t('Type')}</span><select value={draft.kind} onChange={(event) => update('kind', event.target.value as AgentKind)}>{KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          </div>
          <div className="color-picker-row">
            <span>{t('Color label')}</span>
            <div>{COLORS.map((color) => <button type="button" key={color} className={draft.color === color ? 'is-selected' : ''} style={{ background: color }} onClick={() => update('color', color)} aria-label={t('Use {{color}}', { color })} />)}<input type="color" value={draft.color} onChange={(event) => update('color', event.target.value)} /></div>
          </div>
        </section>

        <section className="form-section">
          <div className="form-section__title"><span>02</span><div><strong>{t('Terminal & launch')}</strong><small>{t('tmux is recommended because work survives a closed window')}</small></div></div>
          <div className="form-grid">
            <label className="field-span-2"><span>{t('Working directory')}</span><input value={draft.cwd} placeholder="/home/you/Projects/my-project" onChange={(event) => update('cwd', event.target.value)} /><small>{t('The folder this Agent works inside.')}</small></label>
            <label><span>{t('tmux session')}</span><input value={draft.tmuxSession} placeholder="product-roadmap" onChange={(event) => update('tmuxSession', event.target.value)} /><small>{t('Leave empty if this process does not use tmux.')}</small></label>
            <label><span>{t('Terminal app')}</span><select value={draft.terminalApp} onChange={(event) => update('terminalApp', event.target.value as TerminalApp)}>{TERMINALS.map((terminal) => <option key={terminal} value={terminal}>{terminal}</option>)}</select></label>
            <label className="field-span-2"><span>{t('Terminal title')}</span><input value={draft.terminalTitle} onChange={(event) => update('terminalTitle', event.target.value)} /></label>
            <label className="field-span-2"><span>{t('Launch command')}</span><textarea rows={2} value={draft.command} placeholder="codex" onChange={(event) => update('command', event.target.value)} /><small>{t('Used only when Agent Console needs to start a new session. Leave empty for an already-running imported process.')}</small></label>
          </div>
        </section>

        <section className="form-section">
          <div className="form-section__title"><span>03</span><div><strong>{t('Process matching')}</strong><small>{t('How the live process is connected to this card')}</small></div></div>
          <div className="form-grid">
            <label><span>PID</span><input type="number" min="1" value={draft.pid ?? ''} placeholder={t('Automatic')} onChange={(event) => update('pid', event.target.value ? Number(event.target.value) : null)} /></label>
            <label><span>{t('Status override')}</span><select value={draft.statusOverride ?? ''} onChange={(event) => update('statusOverride', (event.target.value || null) as AgentStatus | null)}><option value="">{t('Automatic')}</option>{STATUSES.map((status) => <option key={status} value={status}>{t(status.charAt(0).toUpperCase() + status.slice(1))}</option>)}</select></label>
            <label className="field-span-2"><span>{t('Command match pattern')}</span><input value={draft.matchPattern} placeholder={t('Optional, for example: codex.*product-roadmap')} onChange={(event) => update('matchPattern', event.target.value)} /><small>{t('Advanced: a text pattern used if the PID changes after restart.')}</small></label>
            <label className="field-span-2"><span>{t('Log file')}</span><input value={draft.logPath} placeholder={t('Optional path to a log file')} onChange={(event) => update('logPath', event.target.value)} /><small>{t('The last line becomes the Agent card’s latest output.')}</small></label>
          </div>
          <label className="toggle-row"><input type="checkbox" checked={draft.autoStart} onChange={(event) => update('autoStart', event.target.checked)} /><span><strong>{t('Include in workspace restore')}</strong><small>{t('Start or open this Agent when the Project is restored.')}</small></span></label>
        </section>

        <footer className="editor-actions">
          {deletePending && onDelete ? (
            <DeleteConfirmation
              subject={t('Delete {{name}}?', { name: draft.name })}
              detail={t('It will disappear from Agent Console, but its running process will not be stopped.')}
              confirmLabel={t('Delete Agent')}
              busy={deleting}
              onCancel={cancelDelete}
              onConfirm={confirmDelete}
            />
          ) : (
            <>
              {existing && onDelete ? <button ref={deleteButtonRef} type="button" className="danger-button" onClick={() => setDeletePending(true)}><Trash2 size={14} /> {t('Delete Agent')}</button> : <span />}
              <div><button type="button" className="action-button" onClick={onClose}>{t('Cancel')}</button><button type="submit" className="action-button action-button--primary">{t('Save Agent')}</button></div>
            </>
          )}
        </footer>
      </form>
    </Modal>
  )
}

interface ProjectEditorProps {
  initial?: Project
  agentCount: number
  onSave: (project: Project) => void
  onDelete?: () => void
  onClose: () => void
}

export function ProjectEditor({ initial, agentCount, onSave, onDelete, onClose }: ProjectEditorProps) {
  const { t } = useI18n()
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState<Project>(initial ?? { id: uniqueId('project'), name: t('New Project'), emoji: '◇', color: '#55a6ff', collapsed: false, order: 0 })
  const [deletePending, setDeletePending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!deletePending && draft.name.trim()) onSave({ ...draft, name: draft.name.trim() })
  }
  const cancelDelete = () => {
    setDeletePending(false)
    window.requestAnimationFrame(() => deleteButtonRef.current?.focus({ preventScroll: true }))
  }
  const requestClose = () => {
    if (deletePending) cancelDelete()
    else onClose()
  }
  const confirmDelete = () => {
    if (!onDelete || deleting) return
    setDeleting(true)
    onDelete()
  }
  return (
    <Modal title={initial ? t('Edit {{name}}', { name: initial.name }) : t('New Project')} subtitle={t('A Project groups related Agents, terminals, backends, and workers.')} onClose={requestClose} size="small">
      <form className="editor-form project-editor" onSubmit={submit}>
        <label><span>{t('Project name')}</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <div className="form-grid form-grid--project">
          <label><span>{t('Symbol')}</span><input value={draft.emoji} maxLength={8} onChange={(event) => setDraft({ ...draft, emoji: event.target.value })} /></label>
          <label><span>{t('Color')}</span><input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label>
        </div>
        <div className="project-preview" style={{ '--project-color': draft.color } as React.CSSProperties}><span>{draft.emoji}</span><div><strong>{draft.name || t('Project name')}</strong><small>{t('{{count}} Agents', { count: agentCount })}</small></div></div>
        {initial && agentCount > 0 && <div className="form-notice"><AlertTriangle size={15} /><span>{t('Move or delete this Project’s {{count}} Agents before deleting the Project.', { count: agentCount })}</span></div>}
        <footer className="editor-actions">
          {deletePending && onDelete ? (
            <DeleteConfirmation
              subject={t('Delete {{name}}?', { name: draft.name })}
              detail={t('This removes the empty Project from Agent Console.')}
              confirmLabel={t('Delete Project')}
              busy={deleting}
              onCancel={cancelDelete}
              onConfirm={confirmDelete}
            />
          ) : (
            <>
              {initial && onDelete ? <button ref={deleteButtonRef} type="button" className="danger-button" disabled={agentCount > 0} onClick={() => setDeletePending(true)}><Trash2 size={14} /> {t('Delete Project')}</button> : <span />}
              <div><button type="button" className="action-button" onClick={onClose}>{t('Cancel')}</button><button type="submit" className="action-button action-button--primary">{t('Save Project')}</button></div>
            </>
          )}
        </footer>
      </form>
    </Modal>
  )
}

interface SettingsEditorProps {
  settings: ConsoleSettings
  availableTerminals: TerminalApp[]
  updateState: UpdateState
  coreHealth: CoreHealth
  coreConnection: CoreConnectionState
  onSave: (settings: ConsoleSettings) => void
  onPreview: (settings: ConsoleSettings) => void
  onClose: () => void
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
  onInstallUpdate: () => void
  onOpenReleasesPage: () => void
}

const CORE_CONNECTION_LABELS: Record<CoreConnectionPhase, string> = {
  starting: 'Starting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  incompatible: 'Version mismatch',
}

function updateHeading(updateState: UpdateState, t: ReturnType<typeof useI18n>['t']): string {
  const headings: Record<UpdateState['phase'], () => string> = {
    disabled: () => t('Updates are off in preview mode'),
    idle: () => t('Ready to check'),
    checking: () => t('Checking for updates'),
    available: () => t('Version {{version}} is available', { version: updateState.availableVersion ?? '' }),
    downloading: () => t('Downloading version {{version}}', { version: updateState.availableVersion ?? '' }),
    downloaded: () => t('Ready to restart and update'),
    'up-to-date': () => t('Agent Console is up to date'),
    error: () => t('Update check needs attention'),
  }
  return headings[updateState.phase]()
}

export function SettingsEditor({
  settings,
  availableTerminals,
  updateState,
  coreHealth,
  coreConnection,
  onSave,
  onPreview,
  onClose,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenReleasesPage,
}: SettingsEditorProps) {
  const { t, message, formatDateTime, formatBytes } = useI18n()
  const [draft, setDraft] = useState(settings)
  const [settingsPage, setSettingsPage] = useState<'general' | 'remote'>('general')

  const update = (next: ConsoleSettings) => {
    setDraft(next)
    onPreview(next)
  }

  const setFontSize = (value: number) => {
    const fontSizePx = Math.min(50, Math.max(5, Math.round(value)))
    update({ ...draft, fontSizePx })
  }

  const resetAppearance = () => update({ ...draft, fontSizePx: 25, theme: 'navy-gold' })

  return (
    <Modal title={t('Console Settings')} subtitle={t('Make Mission Control comfortable on your screen.')} onClose={onClose} size="large">
      <div className="settings-editor-shell">
        <nav className="settings-page-tabs" aria-label={t('Settings pages')}>
          <button type="button" className={settingsPage === 'general' ? 'is-selected' : ''} aria-current={settingsPage === 'general' ? 'page' : undefined} onClick={() => setSettingsPage('general')}><MonitorUp size={14} /> {t('General')}</button>
          <button type="button" className={settingsPage === 'remote' ? 'is-selected' : ''} aria-current={settingsPage === 'remote' ? 'page' : undefined} onClick={() => setSettingsPage('remote')}><Smartphone size={14} /> {t('Mobile Remote')}</button>
        </nav>
        {settingsPage === 'general' ? (
          <form className="editor-form settings-editor settings-editor--expanded" onSubmit={(event) => { event.preventDefault(); onSave(draft) }}>
        <section className="settings-section settings-section--language">
          <header className="settings-section__header">
            <span><Languages size={17} /></span>
            <div><strong>{t('Interface language')}</strong><small>{t('Choose the language used by Agent Console. Changes preview instantly.')}</small></div>
          </header>
          <div className="language-selector" role="group" aria-label={t('Language')}>
            <button type="button" className={draft.language === 'zh-CN' ? 'is-selected' : ''} aria-pressed={draft.language === 'zh-CN'} onClick={() => update({ ...draft, language: 'zh-CN' })}>简体中文</button>
            <button type="button" className={draft.language === 'en' ? 'is-selected' : ''} aria-pressed={draft.language === 'en'} onClick={() => update({ ...draft, language: 'en' })}>English</button>
          </div>
        </section>

        <section className="settings-section settings-section--core">
          <header className="settings-section__header">
            <span><ShieldCheck size={17} /></span>
            <div><strong>{t('Local Console Core')}</strong><small>{t('The protected background service that owns local state and Agent monitoring.')}</small></div>
          </header>

          <div className={`local-core-panel local-core-panel--${coreConnection.phase}`}>
            <div className="local-core-panel__summary" aria-live="polite">
              <span><i /><strong>{t(CORE_CONNECTION_LABELS[coreConnection.phase])}</strong></span>
              <small>{message(coreConnection.message)}</small>
            </div>
            <div className="local-core-detail-grid">
              <div><small>{t('Transport')}</small><strong>{t('Unix socket')}</strong></div>
              <div><small>{t('Network')}</small><strong>{t(coreHealth.tcpListening ? 'TCP active' : 'No TCP listener')}</strong></div>
              <div><small>{t('Core version')}</small><strong>v{coreHealth.appVersion}</strong></div>
              <div><small>{t('Protocol')}</small><strong>v{coreHealth.protocolVersion}</strong></div>
            </div>
            <p><ShieldCheck size={13} /> {t('Local-only mode: the socket is restricted to your Linux user and the Core does not listen on a network port.')}</p>
          </div>
        </section>

        <section className="settings-section settings-section--updates">
          <header className="settings-section__header">
            <span><Rocket size={17} /></span>
            <div><strong>{t('Application updates')}</strong><small>{t('Check, download, verify, and install new Agent Console versions here.')}</small></div>
          </header>

          <div className={`update-panel update-panel--${updateState.phase}`}>
            <div className="update-panel__summary">
              <span className="update-panel__icon">
                {updateState.phase === 'error'
                  ? <CircleAlert size={20} />
                  : updateState.phase === 'downloaded' || updateState.phase === 'up-to-date'
                    ? <CheckCircle2 size={20} />
                    : updateState.phase === 'checking' || updateState.phase === 'downloading'
                      ? <RefreshCw className="is-spinning" size={20} />
                      : <Download size={20} />}
              </span>
              <div>
                <strong>{updateHeading(updateState, t)}</strong>
                <p>{message(updateState.message)}</p>
              </div>
            </div>

            <div className="update-version-grid">
              <div><small>{t('Installed')}</small><strong>v{updateState.currentVersion}</strong></div>
              <div><small>{t('Package')}</small><strong>{t(installationKindLabel(updateState.installationKind))}</strong></div>
              <div><small>{t('Available')}</small><strong>{updateState.availableVersion ? `v${updateState.availableVersion}` : '—'}</strong></div>
              <div><small>{t('Last checked')}</small><strong>{updateState.lastCheckedAt ? formatDateTime(updateState.lastCheckedAt) : t('Not yet')}</strong></div>
            </div>

            {updateState.phase === 'downloading' && updateState.progress && (
              <div className="update-progress" aria-label={t('Download progress {{percent}}%', { percent: updateState.progress.percent })}>
                <div><span style={{ width: `${updateState.progress.percent}%` }} /></div>
                <footer>
                  <strong>{updateState.progress.percent.toFixed(1)}%</strong>
                  <span>{formatBytes(updateState.progress.transferred)} / {formatBytes(updateState.progress.total)}</span>
                  <span>{formatBytes(updateState.progress.bytesPerSecond)}/s</span>
                </footer>
              </div>
            )}

            {updateState.releaseNotes && (
              <div className="update-release-notes">
                <strong>{updateState.releaseName || t('What’s new in v{{version}}', { version: updateState.availableVersion ?? '' })}</strong>
                <pre>{updateState.releaseNotes}</pre>
              </div>
            )}

            <div className="update-panel__actions">
              <span><ShieldCheck size={13} /> {t('Downloads are integrity-checked before installation.')}</span>
              <div>
                <button type="button" className="action-button" onClick={onOpenReleasesPage}><ExternalLink size={14} /> {t('Releases')}</button>
                {updateState.canCheck && <button type="button" className="action-button action-button--primary" onClick={onCheckForUpdates}><RefreshCw size={14} /> {t('Check now')}</button>}
                {updateState.phase === 'checking' && <button type="button" className="action-button action-button--primary" disabled><RefreshCw className="is-spinning" size={14} /> {t('Checking…')}</button>}
                {updateState.canDownload && <button type="button" className="action-button action-button--primary" onClick={onDownloadUpdate}><Download size={14} /> {t('Download update')}</button>}
                {updateState.phase === 'downloading' && <button type="button" className="action-button action-button--primary" disabled><RefreshCw className="is-spinning" size={14} /> {t('Downloading…')}</button>}
                {updateState.canInstall && <button type="button" className="action-button action-button--primary update-install-button" onClick={onInstallUpdate}><Rocket size={14} /> {t('Restart and update')}</button>}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section settings-section--font">
          <header className="settings-section__header">
            <span><Type size={17} /></span>
            <div><strong>{t('Interface size')}</strong><small>{t('Scales all text, controls, cards, and spacing together. Changes preview instantly.')}</small></div>
            <button type="button" className="text-button" onClick={resetAppearance}><RotateCcw size={14} /> {t('Default')}</button>
          </header>

          <div className="font-size-control">
            <div className="font-size-readout">
              <span className="font-size-readout__small">A</span>
              <input
                type="range"
                min={5}
                max={50}
                step={1}
                value={draft.fontSizePx}
                onChange={(event) => setFontSize(Number(event.target.value))}
                aria-label={t('Interface font size')}
              />
              <span className="font-size-readout__large">A</span>
              <label>
                <input
                  type="number"
                  min={5}
                  max={50}
                  value={draft.fontSizePx}
                  onChange={(event) => setFontSize(Number(event.target.value))}
                  aria-label={t('Interface font size in pixels')}
                />
                <span>px</span>
              </label>
            </div>
            <div className="font-size-presets" aria-label={t('Font size presets')}>
              {[12, 18, 25, 32, 40, 50].map((size) => (
                <button type="button" key={size} className={draft.fontSizePx === size ? 'is-selected' : ''} onClick={() => setFontSize(size)}>{size}px</button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section settings-section--themes">
          <header className="settings-section__header">
            <span><Palette size={17} /></span>
            <div><strong>{t('Color world')}</strong><small>{t('Choose a complete visual system, from calm paper themes to luminous night control rooms.')}</small></div>
          </header>
          <div className="theme-grid">
            {THEMES.map((theme) => (
              <button
                type="button"
                key={theme.id}
                className={`theme-card ${draft.theme === theme.id ? 'is-selected' : ''}`}
                onClick={() => update({ ...draft, theme: theme.id })}
                aria-pressed={draft.theme === theme.id}
              >
                <span className="theme-card__swatches">
                  {theme.swatches.map((color, index) => <i key={`${color}-${index}`} style={{ background: color }} />)}
                </span>
                <span className="theme-card__copy">
                  <strong>{t(theme.name)}</strong>
                  <small>{t(theme.origin)}</small>
                  <em>{t(theme.description)}</em>
                </span>
                <span className="theme-card__check">{draft.theme === theme.id ? <Check size={14} /> : null}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section settings-section--system">
          <header className="settings-section__header">
            <span><MonitorUp size={17} /></span>
            <div><strong>{t('System preferences')}</strong><small>{t('Terminal behavior and local monitoring frequency.')}</small></div>
          </header>
          <div className="settings-system-grid">
            <label><span>{t('Default terminal')}</span><select value={draft.defaultTerminal} onChange={(event) => setDraft({ ...draft, defaultTerminal: event.target.value as TerminalApp })}><option value="auto">{t('Automatic — use first available')}</option>{availableTerminals.map((terminal) => <option key={terminal} value={terminal}>{terminal}</option>)}</select></label>
            <label><span>{t('Live scan interval')}</span><select value={draft.scanIntervalMs} onChange={(event) => setDraft({ ...draft, scanIntervalMs: Number(event.target.value) })}><option value={1000}>{t('Every second')}</option><option value={2500}>{t('Every 2.5 seconds')}</option><option value={5000}>{t('Every 5 seconds')}</option><option value={10000}>{t('Every 10 seconds')}</option></select></label>
          </div>
          <label className="toggle-row"><input type="checkbox" checked={draft.compactMode} onChange={(event) => setDraft({ ...draft, compactMode: event.target.checked })} /><span><strong>{t('Compact Agent cards')}</strong><small>{t('Fit more Agents on screen.')}</small></span></label>
        </section>

            <footer className="editor-actions"><span /><div><button type="button" className="action-button" onClick={onClose}>{t('Cancel')}</button><button type="submit" className="action-button action-button--primary">{t('Save Settings')}</button></div></footer>
          </form>
        ) : (
          <div className="settings-editor settings-editor--expanded remote-settings-page">
            <RemoteControlSettings />
            <footer className="editor-actions"><span /><button type="button" className="action-button" onClick={onClose}>{t('Close')}</button></footer>
          </div>
        )}
      </div>
    </Modal>
  )
}
