import { Plus, Radar, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DiscoveredItem, RuntimeSnapshot } from '../../shared/types'
import { formatDuration, formatPercent, KIND_LABEL, shortPath } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { StatusBadge } from './StatusBadge'

interface DiscoveryDrawerProps {
  open: boolean
  snapshot: RuntimeSnapshot
  onClose: () => void
  onRefresh: () => void
  onImport: (item: DiscoveredItem) => void
}

export function DiscoveryDrawer({ open, snapshot, onClose, onRefresh, onImport }: DiscoveryDrawerProps) {
  const i18n = useI18n()
  const { t } = i18n
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (open && event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [open, onClose])

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return snapshot.discovered
    return snapshot.discovered.filter((item) =>
      `${item.name} ${item.kind} ${item.cwd} ${item.args} ${item.tmuxSession}`.toLowerCase().includes(needle),
    )
  }, [query, snapshot.discovered])

  return (
    <>
      <div className={`drawer-scrim ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`discovery-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <header className="drawer-header">
          <div className="drawer-title">
            <span><Radar size={18} /></span>
            <div><h2>{t('Process Discovery')}</h2><p>{t('Live processes not yet assigned to a Project')}</p></div>
          </div>
          <div>
            <button className="icon-button" onClick={onRefresh} title={t('Scan now')}><RefreshCw size={16} /></button>
            <button className="icon-button" onClick={onClose} title={t('Close')}><X size={18} /></button>
          </div>
        </header>

        <div className="drawer-summary">
          <div><strong>{snapshot.discovered.length}</strong><span>{t('UNASSIGNED')}</span></div>
          <div><strong>{snapshot.discovered.filter((item) => item.kind === 'codex').length}</strong><span>CODEX</span></div>
          <div><strong>{snapshot.discovered.filter((item) => item.kind === 'backend' || item.kind === 'worker').length}</strong><span>{t('SERVICES')}</span></div>
        </div>

        <label className="drawer-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Filter discovered processes')} />
        </label>

        <div className="discovery-list">
          {items.map((item) => (
            <article className="discovery-item" key={item.id}>
              <header>
                <div className="discovery-identity">
                  <span style={{ color: item.color, borderColor: `${item.color}55` }}>{item.emoji}</span>
                  <div><strong>{item.name}</strong><small>{t(KIND_LABEL[item.kind])} {item.pid ? `· PID ${item.pid}` : ''}</small></div>
                </div>
                <StatusBadge status={item.status} />
              </header>
              <div className="discovery-metrics">
                <span>CPU <b>{formatPercent(item.cpu, i18n)}</b></span>
                <span>{t('MEM')} <b>{formatPercent(item.memory, i18n)}</b></span>
                <span>{t('UP')} <b>{formatDuration(item.runtimeSeconds, i18n)}</b></span>
              </div>
              <div className="discovery-path" title={item.cwd}>{shortPath(item.cwd, i18n)}</div>
              <div className="discovery-output" title={item.lastOutput}>{item.lastOutput || item.args}</div>
              <footer>
                <span>{item.tmuxSession ? `tmux: ${item.tmuxSession}` : item.command}</span>
                <button className="text-button text-button--accent" onClick={() => onImport(item)}><Plus size={14} /> {t('Add to Project')}</button>
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
