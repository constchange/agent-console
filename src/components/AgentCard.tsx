import { ExternalLink, Pencil, Square, SquareTerminal } from 'lucide-react'
import type { Project, RuntimeAgent } from '../../shared/types'
import { formatDuration, formatPercent, KIND_LABEL, shortPath, timeLabel } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { StatusBadge } from './StatusBadge'

interface AgentCardProps {
  agent: RuntimeAgent
  project: Project
  onOpen: () => void
  onCloseTerminal: () => void
  onEdit: () => void
}

export function AgentCard({ agent, project, onOpen, onCloseTerminal, onEdit }: AgentCardProps) {
  const i18n = useI18n()
  const { t } = i18n

  return (
    <article className={`agent-card agent-card--${agent.status}`} onDoubleClick={onOpen}>
      <div className="agent-card__accent" style={{ background: agent.color }} />
      <header className="agent-card__header">
        <div className="agent-identity">
          <span className="agent-emoji" style={{ color: agent.color }}>{agent.emoji}</span>
          <div>
            <div className="agent-project-name" style={{ color: project.color }}>{project.name}</div>
            <h3>{agent.name}</h3>
          </div>
        </div>
        <div className="agent-card__header-actions">
          <StatusBadge status={agent.status} />
          <button className="icon-button icon-button--small" onClick={(event) => { event.stopPropagation(); onEdit() }} title={t('Edit Agent')}>
            <Pencil size={14} />
          </button>
        </div>
      </header>

      <div className="agent-metrics">
        <div>
          <span>CPU</span>
          <strong>{formatPercent(agent.cpu, i18n)}</strong>
          <i><b style={{ width: `${Math.min(100, agent.cpu)}%`, background: agent.color }} /></i>
        </div>
        <div>
          <span>{t('MEMORY')}</span>
          <strong>{formatPercent(agent.memory, i18n)}</strong>
          <i><b style={{ width: `${Math.min(100, agent.memory * 4)}%`, background: '#7c8cff' }} /></i>
        </div>
        <div>
          <span>{t('RUNNING TIME')}</span>
          <strong>{formatDuration(agent.runtimeSeconds, i18n)}</strong>
          <small>{agent.processName || t(KIND_LABEL[agent.kind])}</small>
        </div>
      </div>

      <dl className="agent-details">
        <div><dt>PID</dt><dd>{agent.pid ?? '—'}</dd></div>
        <div><dt>TMUX</dt><dd title={agent.tmuxSession || t('Not configured')}>{agent.tmuxSession || '—'}</dd></div>
        <div><dt>{t('Terminal').toUpperCase()}</dt><dd title={agent.terminalTitle}>{agent.terminalTitle || '—'}</dd></div>
        <div className="agent-details__cwd"><dt>CWD</dt><dd title={agent.cwd}>{shortPath(agent.cwd, i18n)}</dd></div>
      </dl>

      <footer className="agent-output">
        <div className="agent-output__line">
          <span className="prompt-mark">›</span>
          <span title={agent.lastOutput}>{agent.lastOutput}</span>
        </div>
        <div className="agent-output__meta">
          <span>{t(agent.terminalOpen ? 'TERMINAL OPEN' : 'NO WINDOW')}</span>
          <span>{t('UPDATED {{time}}', { time: timeLabel(agent.lastUpdated, i18n) })}</span>
        </div>
      </footer>

      <div className="agent-card__actions">
        <button className="action-button action-button--primary" onClick={(event) => { event.stopPropagation(); onOpen() }}>
          {agent.terminalOpen ? <ExternalLink size={14} /> : <SquareTerminal size={14} />}
          {t(agent.terminalOpen ? 'Focus' : 'Open')}
        </button>
        <button
          className="action-button"
          onClick={(event) => { event.stopPropagation(); onCloseTerminal() }}
          title={t('Close the window. A tmux session keeps running.')}
        >
          <Square size={12} /> {t('Close window')}
        </button>
      </div>
    </article>
  )
}
