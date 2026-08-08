import { ExternalLink, Pencil, Square, SquareTerminal, X } from 'lucide-react'
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
  onDelete: () => void
}

function firstCharacters(value: string, count: number): string {
  return Array.from(value).slice(0, count).join('')
}

function lastCharacters(value: string, count: number): string {
  return Array.from(value).slice(-count).join('')
}

function createdAt(agent: RuntimeAgent): string | null {
  if (agent.codexSession?.createdAt) return agent.codexSession.createdAt
  if (!agent.pid || agent.runtimeSeconds <= 0) return null
  const captured = Date.parse(agent.lastUpdated)
  return Number.isFinite(captured)
    ? new Date(captured - agent.runtimeSeconds * 1_000).toISOString()
    : null
}

export function AgentCard({ agent, project, onOpen, onCloseTerminal, onEdit, onDelete }: AgentCardProps) {
  const i18n = useI18n()
  const { t } = i18n

  if (agent.kind === 'codex') {
    const session = agent.codexSession
    const effectiveGoal = session?.goal.trim() || agent.goal.trim()
    const creationTime = createdAt(agent)
    const summaries = [
      { label: t('First command'), value: firstCharacters(session?.firstPrompt ?? '', 50), empty: t('No recorded command') },
      { label: t('Latest command'), value: firstCharacters(session?.latestPrompt ?? '', 50), empty: t('No recorded command') },
      { label: t('Last completed response'), value: lastCharacters(session?.lastCompletedResponse ?? '', 50), empty: t('No completed response') },
    ]

    return (
      <article className={`agent-card agent-card--codex agent-card--${agent.status}`}>
        <div className="agent-card__accent" style={{ background: project.color }} />
        <header className="agent-card__header">
          <div className="agent-identity">
            <div>
              <div className="agent-project-name" style={{ color: project.color }}>{project.name}</div>
              <div className="agent-title-row">
                <h3>{agent.name}</h3>
                {effectiveGoal && <span className="agent-title-goal" style={{ color: project.color }} title={effectiveGoal}>{effectiveGoal}</span>}
              </div>
            </div>
          </div>
          <div className="agent-card__header-actions">
            <button className="icon-button icon-button--small" onClick={onEdit} title={t('Edit Agent')} aria-label={t('Edit Agent')}>
              <Pencil size={14} />
            </button>
            <button className="icon-button icon-button--small codex-card__delete" onClick={onDelete} title={t('Delete Agent')} aria-label={t('Delete Agent')}>
              <X size={15} />
            </button>
          </div>
        </header>

        <dl className="codex-card__meta">
          <div>
            <dt>{t('Created')}</dt>
            <dd>{creationTime ? i18n.formatDateTime(creationTime) : '—'}</dd>
          </div>
          <div>
            <dt>{t('Working folder')}</dt>
            <dd title={agent.cwd}>{agent.cwd ? shortPath(agent.cwd, i18n) : '—'}</dd>
          </div>
        </dl>

        <div className="codex-card__summaries">
          {summaries.map((summary) => (
            <section className="codex-card__summary" key={summary.label}>
              <span>{summary.label}</span>
              <p className={summary.value ? '' : 'is-empty'}>{summary.value || summary.empty}</p>
            </section>
          ))}
        </div>

        <section className="codex-card__note">
          <span>{t('Note')}</span>
          <p className={agent.note ? '' : 'is-empty'} title={agent.note}>{agent.note || t('No note')}</p>
        </section>

        <div className="codex-card__status">
          <span>{t('Current status')}</span>
          <StatusBadge status={agent.status} />
        </div>

        <div className="agent-card__actions codex-card__actions">
          <button className="action-button action-button--primary" onClick={onOpen}>
            <ExternalLink size={14} /> {t('Focus')}
          </button>
        </div>
      </article>
    )
  }

  const effectiveGoal = agent.goal.trim()

  return (
    <article className={`agent-card agent-card--${agent.status}`} onDoubleClick={onOpen}>
      <div className="agent-card__accent" style={{ background: project.color }} />
      <header className="agent-card__header">
        <div className="agent-identity">
            <div>
              <div className="agent-project-name" style={{ color: project.color }}>{project.name}</div>
              <div className="agent-title-row">
                <h3>{agent.name}</h3>
                {effectiveGoal && <span className="agent-title-goal" style={{ color: project.color }} title={effectiveGoal}>{effectiveGoal}</span>}
              </div>
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
          <i><b style={{ width: `${Math.min(100, agent.cpu)}%`, background: project.color }} /></i>
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
        <div className="agent-output__note">
          <span>{t('Note')}</span>
          <p className={agent.note ? '' : 'is-empty'} title={agent.note}>{agent.note || t('No note')}</p>
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
