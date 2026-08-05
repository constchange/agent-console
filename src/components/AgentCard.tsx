import { ExternalLink, Pencil, Square, SquareTerminal } from 'lucide-react'
import type { Project, RuntimeAgent } from '../../shared/types'
import { formatDuration, formatPercent, KIND_LABEL, shortPath, timeLabel } from '../lib/format'
import { StatusBadge } from './StatusBadge'

interface AgentCardProps {
  agent: RuntimeAgent
  project: Project
  onOpen: () => void
  onCloseTerminal: () => void
  onEdit: () => void
}

export function AgentCard({ agent, project, onOpen, onCloseTerminal, onEdit }: AgentCardProps) {
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
          <button className="icon-button icon-button--small" onClick={(event) => { event.stopPropagation(); onEdit() }} title="Edit Agent">
            <Pencil size={14} />
          </button>
        </div>
      </header>

      <div className="agent-metrics">
        <div>
          <span>CPU</span>
          <strong>{formatPercent(agent.cpu)}</strong>
          <i><b style={{ width: `${Math.min(100, agent.cpu)}%`, background: agent.color }} /></i>
        </div>
        <div>
          <span>MEMORY</span>
          <strong>{formatPercent(agent.memory)}</strong>
          <i><b style={{ width: `${Math.min(100, agent.memory * 4)}%`, background: '#7c8cff' }} /></i>
        </div>
        <div>
          <span>RUNNING TIME</span>
          <strong>{formatDuration(agent.runtimeSeconds)}</strong>
          <small>{agent.processName || KIND_LABEL[agent.kind]}</small>
        </div>
      </div>

      <dl className="agent-details">
        <div><dt>PID</dt><dd>{agent.pid ?? '—'}</dd></div>
        <div><dt>TMUX</dt><dd title={agent.tmuxSession || 'Not configured'}>{agent.tmuxSession || '—'}</dd></div>
        <div><dt>TERMINAL</dt><dd title={agent.terminalTitle}>{agent.terminalTitle || '—'}</dd></div>
        <div className="agent-details__cwd"><dt>CWD</dt><dd title={agent.cwd}>{shortPath(agent.cwd)}</dd></div>
      </dl>

      <footer className="agent-output">
        <div className="agent-output__line">
          <span className="prompt-mark">›</span>
          <span title={agent.lastOutput}>{agent.lastOutput}</span>
        </div>
        <div className="agent-output__meta">
          <span>{agent.terminalOpen ? 'TERMINAL OPEN' : 'NO WINDOW'}</span>
          <span>UPDATED {timeLabel(agent.lastUpdated)}</span>
        </div>
      </footer>

      <div className="agent-card__actions">
        <button className="action-button action-button--primary" onClick={(event) => { event.stopPropagation(); onOpen() }}>
          {agent.terminalOpen ? <ExternalLink size={14} /> : <SquareTerminal size={14} />}
          {agent.terminalOpen ? 'Focus' : 'Open'}
        </button>
        <button
          className="action-button"
          onClick={(event) => { event.stopPropagation(); onCloseTerminal() }}
          title="Close the window. A tmux session keeps running."
        >
          <Square size={12} /> Close window
        </button>
      </div>
    </article>
  )
}
