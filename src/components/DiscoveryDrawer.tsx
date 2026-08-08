import { ExternalLink, LoaderCircle, Plus, Radar, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DiscoveredItem, Project, RuntimeSnapshot } from '../../shared/types'
import { formatDuration, formatPercent, KIND_LABEL, shortPath } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { StatusBadge } from './StatusBadge'

interface DiscoveryDrawerProps {
  open: boolean
  snapshot: RuntimeSnapshot
  projects: Project[]
  initialProjectId: string
  onClose: () => void
  onRefresh: () => void
  onImport: (items: DiscoveredItem[], projectId: string) => void
  onFocus: (discoveredId: string) => Promise<void>
}

export function DiscoveryDrawer({
  open,
  snapshot,
  projects,
  initialProjectId,
  onClose,
  onRefresh,
  onImport,
  onFocus,
}: DiscoveryDrawerProps) {
  const i18n = useI18n()
  const { t } = i18n
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => (
    typeof window !== 'undefined'
      && !window.agentConsole
      && new URLSearchParams(window.location.search).get('preview') === 'discovery'
      ? new Set(snapshot.discovered.map((item) => item.id))
      : new Set()
  ))
  const [projectId, setProjectId] = useState(initialProjectId)
  const [focusingId, setFocusingId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSelectedIds(new Set())
      setFocusingId(null)
      return
    }
    const preferred = projects.some((project) => project.id === initialProjectId) ? initialProjectId : projects[0]?.id ?? ''
    setProjectId(preferred)
  }, [initialProjectId, open, projects])

  useEffect(() => {
    const available = new Set(snapshot.discovered.map((item) => item.id))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
  }, [snapshot.discovered])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (open && event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [open, onClose])

  const items = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return snapshot.discovered
    return snapshot.discovered.filter((item) =>
      `${item.name} ${item.kind} ${item.cwd} ${item.args} ${item.tmuxSession} ${item.keywords.join(' ')}`.toLocaleLowerCase().includes(needle),
    )
  }, [query, snapshot.discovered])
  const selectedItems = snapshot.discovered.filter((item) => selectedIds.has(item.id))
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id))

  const toggle = (itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const focusItem = async (item: DiscoveredItem) => {
    setFocusingId(item.id)
    try {
      await onFocus(item.id)
    } finally {
      setFocusingId((current) => current === item.id ? null : current)
    }
  }

  return (
    <>
      <div className={`drawer-scrim ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`discovery-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <header className="drawer-header">
          <div className="drawer-title">
            <span><Radar size={18} /></span>
            <div><h2>{t('Process Discovery')}</h2><p>{t('AI CLI processes not yet assigned to a Project')}</p></div>
          </div>
          <div>
            <button className="icon-button" onClick={onRefresh} title={t('Scan now')}><RefreshCw size={16} /></button>
            <button className="icon-button" onClick={onClose} title={t('Close')}><X size={18} /></button>
          </div>
        </header>

        <div className="drawer-summary">
          <div><strong>{snapshot.discovered.length}</strong><span>{t('UNASSIGNED')}</span></div>
          <div><strong>{snapshot.discovered.filter((item) => item.kind === 'codex').length}</strong><span>CODEX</span></div>
          <div><strong>{snapshot.discovered.filter((item) => Boolean(item.tmuxSession)).length}</strong><span>TMUX</span></div>
        </div>

        <label className="drawer-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Filter by name, path, command or keyword')} />
        </label>

        <div className="discovery-bulk-bar">
          <label className="discovery-select-all">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() => setSelectedIds((current) => {
                const next = new Set(current)
                if (allVisibleSelected) items.forEach((item) => next.delete(item.id))
                else items.forEach((item) => next.add(item.id))
                return next
              })}
            />
            <span>{t('Select visible')}</span>
          </label>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label={t('Destination Project')}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.emoji} {project.name}</option>)}
          </select>
          <button
            className="action-button action-button--primary"
            disabled={selectedItems.length === 0 || !projectId}
            onClick={() => {
              onImport(selectedItems, projectId)
              setSelectedIds(new Set())
            }}
          >
            <Plus size={14} /> {t('Add selected ({{count}})', { count: selectedItems.length })}
          </button>
        </div>

        <div className="discovery-list">
          {items.map((item) => (
            <article className={`discovery-item ${selectedIds.has(item.id) ? 'is-selected' : ''}`} key={item.id}>
              <header>
                <label className="discovery-checkbox" title={t('Select {{name}}', { name: item.name })}>
                  <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggle(item.id)} />
                </label>
                <div className="discovery-identity">
                  <span style={{ color: item.color, borderColor: `${item.color}55` }}>{item.emoji}</span>
                  <div><strong>{item.name}</strong><small>{t(KIND_LABEL[item.kind])} {item.pid ? `· PID ${item.pid}` : ''}</small></div>
                </div>
                <StatusBadge status={item.status} />
              </header>
              {item.keywords.length > 0 && <div className="discovery-keywords">{item.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div>}
              <div className="discovery-metrics">
                <span>CPU <b>{formatPercent(item.cpu, i18n)}</b></span>
                <span>{t('MEM')} <b>{formatPercent(item.memory, i18n)}</b></span>
                <span>{t('UP')} <b>{formatDuration(item.runtimeSeconds, i18n)}</b></span>
              </div>
              <div className="discovery-path" title={item.cwd}>{shortPath(item.cwd, i18n)}</div>
              <div className="discovery-output" title={item.lastOutput}>{item.lastOutput || item.args}</div>
              <footer>
                <span>{item.tmuxSession ? `tmux: ${item.tmuxSession}` : item.command}</span>
                <button className="text-button" disabled={focusingId === item.id} onClick={() => void focusItem(item)}>
                  {focusingId === item.id ? <LoaderCircle className="is-spinning" size={14} /> : <ExternalLink size={14} />} {t('Focus')}
                </button>
              </footer>
            </article>
          ))}
          {items.length === 0 && (
            <div className="drawer-empty">
              <Radar size={25} />
              <strong>{t('No unassigned processes')}</strong>
              <span>{t(query ? 'Nothing matches this filter.' : 'Every detected process is already managed.')}</span>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
