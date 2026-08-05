import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleAlert,
  Download,
  ExternalLink,
  MonitorUp,
  Palette,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Type,
} from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import type {
  AgentConfig,
  AgentKind,
  AgentStatus,
  ConsoleSettings,
  Project,
  TerminalApp,
  UpdateState,
} from '../../shared/types'
import { installationKindLabel } from '../../shared/update-helpers'
import { uniqueId } from '../lib/format'
import { THEMES } from '../lib/themes'
import { Modal } from './Modal'

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
  return (
    <div className="delete-confirmation" role="alert">
      <AlertTriangle size={16} />
      <span><strong>{subject}</strong><small>{detail}</small></span>
      <div>
        <button type="button" className="action-button" autoFocus disabled={busy} onClick={onCancel}>Keep it</button>
        <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>
          <Trash2 size={14} /> {busy ? 'Deleting…' : confirmLabel}
        </button>
      </div>
    </div>
  )
}

export function AgentEditor({ projects, initial, existing, onSave, onDelete, onClose }: AgentEditorProps) {
  const firstProject = projects[0]
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState<AgentConfig>({
    id: initial.id ?? uniqueId('agent'),
    projectId: initial.projectId ?? firstProject?.id ?? 'inbox',
    name: initial.name ?? 'New Agent',
    emoji: initial.emoji ?? '◆',
    color: initial.color ?? '#55a6ff',
    kind: initial.kind ?? 'codex',
    terminalTitle: initial.terminalTitle ?? '◆ New Agent',
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
      title={existing ? `Edit ${initial.name}` : 'Add Agent'}
      subtitle="Define how this process is identified and how its terminal should open."
      onClose={requestClose}
      size="large"
    >
      <form className="editor-form" onSubmit={submit}>
        <section className="form-section">
          <div className="form-section__title"><span>01</span><div><strong>Identity</strong><small>How this Agent appears in Mission Control</small></div></div>
          <div className="form-grid form-grid--identity">
            <label><span>Name</span><input required value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
            <label><span>Project</span><select value={draft.projectId} onChange={(event) => update('projectId', event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.emoji} {project.name}</option>)}</select></label>
            <label><span>Symbol</span><input className="emoji-input" value={draft.emoji} maxLength={8} onChange={(event) => update('emoji', event.target.value)} /></label>
            <label><span>Type</span><select value={draft.kind} onChange={(event) => update('kind', event.target.value as AgentKind)}>{KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          </div>
          <div className="color-picker-row">
            <span>Color label</span>
            <div>{COLORS.map((color) => <button type="button" key={color} className={draft.color === color ? 'is-selected' : ''} style={{ background: color }} onClick={() => update('color', color)} aria-label={`Use ${color}`} />)}<input type="color" value={draft.color} onChange={(event) => update('color', event.target.value)} /></div>
          </div>
        </section>

        <section className="form-section">
          <div className="form-section__title"><span>02</span><div><strong>Terminal & launch</strong><small>tmux is recommended because work survives a closed window</small></div></div>
          <div className="form-grid">
            <label className="field-span-2"><span>Working directory</span><input value={draft.cwd} placeholder="/home/you/Projects/my-project" onChange={(event) => update('cwd', event.target.value)} /><small>The folder this Agent works inside.</small></label>
            <label><span>tmux session</span><input value={draft.tmuxSession} placeholder="product-roadmap" onChange={(event) => update('tmuxSession', event.target.value)} /><small>Leave empty if this process does not use tmux.</small></label>
            <label><span>Terminal app</span><select value={draft.terminalApp} onChange={(event) => update('terminalApp', event.target.value as TerminalApp)}>{TERMINALS.map((terminal) => <option key={terminal} value={terminal}>{terminal}</option>)}</select></label>
            <label className="field-span-2"><span>Terminal title</span><input value={draft.terminalTitle} onChange={(event) => update('terminalTitle', event.target.value)} /></label>
            <label className="field-span-2"><span>Launch command</span><textarea rows={2} value={draft.command} placeholder="codex" onChange={(event) => update('command', event.target.value)} /><small>Used only when Agent Console needs to start a new session. Leave empty for an already-running imported process.</small></label>
          </div>
        </section>

        <section className="form-section">
          <div className="form-section__title"><span>03</span><div><strong>Process matching</strong><small>How the live process is connected to this card</small></div></div>
          <div className="form-grid">
            <label><span>PID</span><input type="number" min="1" value={draft.pid ?? ''} placeholder="Auto" onChange={(event) => update('pid', event.target.value ? Number(event.target.value) : null)} /></label>
            <label><span>Status override</span><select value={draft.statusOverride ?? ''} onChange={(event) => update('statusOverride', (event.target.value || null) as AgentStatus | null)}><option value="">Automatic</option>{STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
            <label className="field-span-2"><span>Command match pattern</span><input value={draft.matchPattern} placeholder="Optional, for example: codex.*product-roadmap" onChange={(event) => update('matchPattern', event.target.value)} /><small>Advanced: a text pattern used if the PID changes after restart.</small></label>
            <label className="field-span-2"><span>Log file</span><input value={draft.logPath} placeholder="Optional path to a log file" onChange={(event) => update('logPath', event.target.value)} /><small>The last line becomes the Agent card’s latest output.</small></label>
          </div>
          <label className="toggle-row"><input type="checkbox" checked={draft.autoStart} onChange={(event) => update('autoStart', event.target.checked)} /><span><strong>Include in workspace restore</strong><small>Start or open this Agent when the Project is restored.</small></span></label>
        </section>

        <footer className="editor-actions">
          {deletePending && onDelete ? (
            <DeleteConfirmation
              subject={`Delete ${draft.name}?`}
              detail="It will disappear from Agent Console, but its running process will not be stopped."
              confirmLabel="Delete Agent"
              busy={deleting}
              onCancel={cancelDelete}
              onConfirm={confirmDelete}
            />
          ) : (
            <>
              {existing && onDelete ? <button ref={deleteButtonRef} type="button" className="danger-button" onClick={() => setDeletePending(true)}><Trash2 size={14} /> Delete Agent</button> : <span />}
              <div><button type="button" className="action-button" onClick={onClose}>Cancel</button><button type="submit" className="action-button action-button--primary">Save Agent</button></div>
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
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState<Project>(initial ?? { id: uniqueId('project'), name: 'New Project', emoji: '◇', color: '#55a6ff', collapsed: false, order: 0 })
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
    <Modal title={initial ? `Edit ${initial.name}` : 'New Project'} subtitle="A Project groups related Agents, terminals, backends, and workers." onClose={requestClose} size="small">
      <form className="editor-form project-editor" onSubmit={submit}>
        <label><span>Project name</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <div className="form-grid form-grid--project">
          <label><span>Symbol</span><input value={draft.emoji} maxLength={8} onChange={(event) => setDraft({ ...draft, emoji: event.target.value })} /></label>
          <label><span>Color</span><input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label>
        </div>
        <div className="project-preview" style={{ '--project-color': draft.color } as React.CSSProperties}><span>{draft.emoji}</span><div><strong>{draft.name || 'Project name'}</strong><small>{agentCount} Agents</small></div></div>
        {initial && agentCount > 0 && <div className="form-notice"><AlertTriangle size={15} /><span>Move or delete this Project’s {agentCount} Agents before deleting the Project.</span></div>}
        <footer className="editor-actions">
          {deletePending && onDelete ? (
            <DeleteConfirmation
              subject={`Delete ${draft.name}?`}
              detail="This removes the empty Project from Agent Console."
              confirmLabel="Delete Project"
              busy={deleting}
              onCancel={cancelDelete}
              onConfirm={confirmDelete}
            />
          ) : (
            <>
              {initial && onDelete ? <button ref={deleteButtonRef} type="button" className="danger-button" disabled={agentCount > 0} onClick={() => setDeletePending(true)}><Trash2 size={14} /> Delete Project</button> : <span />}
              <div><button type="button" className="action-button" onClick={onClose}>Cancel</button><button type="submit" className="action-button action-button--primary">Save Project</button></div>
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
  onSave: (settings: ConsoleSettings) => void
  onPreview: (settings: ConsoleSettings) => void
  onClose: () => void
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
  onInstallUpdate: () => void
  onOpenReleasesPage: () => void
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1_024)))
  return `${(value / 1_024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function updateHeading(updateState: UpdateState): string {
  const headings: Record<UpdateState['phase'], string> = {
    disabled: 'Updates are off in preview mode',
    idle: 'Ready to check',
    checking: 'Checking for updates',
    available: `Version ${updateState.availableVersion ?? ''} is available`,
    downloading: `Downloading version ${updateState.availableVersion ?? ''}`,
    downloaded: 'Ready to restart and update',
    'up-to-date': 'Agent Console is up to date',
    error: 'Update check needs attention',
  }
  return headings[updateState.phase]
}

export function SettingsEditor({
  settings,
  availableTerminals,
  updateState,
  onSave,
  onPreview,
  onClose,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenReleasesPage,
}: SettingsEditorProps) {
  const [draft, setDraft] = useState(settings)

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
    <Modal title="Console Settings" subtitle="Make Mission Control comfortable on your screen." onClose={onClose} size="large">
      <form className="editor-form settings-editor settings-editor--expanded" onSubmit={(event) => { event.preventDefault(); onSave(draft) }}>
        <section className="settings-section settings-section--updates">
          <header className="settings-section__header">
            <span><Rocket size={17} /></span>
            <div><strong>Application updates</strong><small>Check, download, verify, and install new Agent Console versions here.</small></div>
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
                <strong>{updateHeading(updateState)}</strong>
                <p>{updateState.message}</p>
              </div>
            </div>

            <div className="update-version-grid">
              <div><small>Installed</small><strong>v{updateState.currentVersion}</strong></div>
              <div><small>Package</small><strong>{installationKindLabel(updateState.installationKind)}</strong></div>
              <div><small>Available</small><strong>{updateState.availableVersion ? `v${updateState.availableVersion}` : '—'}</strong></div>
              <div><small>Last checked</small><strong>{updateState.lastCheckedAt ? new Date(updateState.lastCheckedAt).toLocaleString() : 'Not yet'}</strong></div>
            </div>

            {updateState.phase === 'downloading' && updateState.progress && (
              <div className="update-progress" aria-label={`Download progress ${updateState.progress.percent}%`}>
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
                <strong>{updateState.releaseName || `What’s new in v${updateState.availableVersion}`}</strong>
                <pre>{updateState.releaseNotes}</pre>
              </div>
            )}

            <div className="update-panel__actions">
              <span><ShieldCheck size={13} /> Downloads are integrity-checked before installation.</span>
              <div>
                <button type="button" className="action-button" onClick={onOpenReleasesPage}><ExternalLink size={14} /> Releases</button>
                {updateState.canCheck && <button type="button" className="action-button action-button--primary" onClick={onCheckForUpdates}><RefreshCw size={14} /> Check now</button>}
                {updateState.phase === 'checking' && <button type="button" className="action-button action-button--primary" disabled><RefreshCw className="is-spinning" size={14} /> Checking…</button>}
                {updateState.canDownload && <button type="button" className="action-button action-button--primary" onClick={onDownloadUpdate}><Download size={14} /> Download update</button>}
                {updateState.phase === 'downloading' && <button type="button" className="action-button action-button--primary" disabled><RefreshCw className="is-spinning" size={14} /> Downloading…</button>}
                {updateState.canInstall && <button type="button" className="action-button action-button--primary update-install-button" onClick={onInstallUpdate}><Rocket size={14} /> Restart and update</button>}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section settings-section--font">
          <header className="settings-section__header">
            <span><Type size={17} /></span>
            <div><strong>Interface size</strong><small>Scales all text, controls, cards, and spacing together. Changes preview instantly.</small></div>
            <button type="button" className="text-button" onClick={resetAppearance}><RotateCcw size={14} /> Default</button>
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
                aria-label="Interface font size"
              />
              <span className="font-size-readout__large">A</span>
              <label>
                <input
                  type="number"
                  min={5}
                  max={50}
                  value={draft.fontSizePx}
                  onChange={(event) => setFontSize(Number(event.target.value))}
                  aria-label="Interface font size in pixels"
                />
                <span>px</span>
              </label>
            </div>
            <div className="font-size-presets" aria-label="Font size presets">
              {[12, 18, 25, 32, 40, 50].map((size) => (
                <button type="button" key={size} className={draft.fontSizePx === size ? 'is-selected' : ''} onClick={() => setFontSize(size)}>{size}px</button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section settings-section--themes">
          <header className="settings-section__header">
            <span><Palette size={17} /></span>
            <div><strong>Color world</strong><small>Choose a complete visual system, from calm paper themes to luminous night control rooms.</small></div>
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
                  <strong>{theme.name}</strong>
                  <small>{theme.origin}</small>
                  <em>{theme.description}</em>
                </span>
                <span className="theme-card__check">{draft.theme === theme.id ? <Check size={14} /> : null}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section settings-section--system">
          <header className="settings-section__header">
            <span><MonitorUp size={17} /></span>
            <div><strong>System preferences</strong><small>Terminal behavior and local monitoring frequency.</small></div>
          </header>
          <div className="settings-system-grid">
            <label><span>Default terminal</span><select value={draft.defaultTerminal} onChange={(event) => setDraft({ ...draft, defaultTerminal: event.target.value as TerminalApp })}><option value="auto">Automatic — use first available</option>{availableTerminals.map((terminal) => <option key={terminal} value={terminal}>{terminal}</option>)}</select></label>
            <label><span>Live scan interval</span><select value={draft.scanIntervalMs} onChange={(event) => setDraft({ ...draft, scanIntervalMs: Number(event.target.value) })}><option value={1000}>Every second</option><option value={2500}>Every 2.5 seconds</option><option value={5000}>Every 5 seconds</option><option value={10000}>Every 10 seconds</option></select></label>
          </div>
          <label className="toggle-row"><input type="checkbox" checked={draft.compactMode} onChange={(event) => setDraft({ ...draft, compactMode: event.target.checked })} /><span><strong>Compact Agent cards</strong><small>Fit more Agents on screen.</small></span></label>
        </section>

        <footer className="editor-actions"><span /><div><button type="button" className="action-button" onClick={onClose}>Cancel</button><button type="submit" className="action-button action-button--primary">Save Settings</button></div></footer>
      </form>
    </Modal>
  )
}
