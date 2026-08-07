import { Activity, AlertTriangle, FolderOpen, Pencil, Plus, RotateCcw, SearchX, Sparkles } from 'lucide-react'
import type { AgentConfig, ConsoleState, Project, RuntimeAgent, RuntimeSnapshot } from '../../shared/types'
import { formatPercent } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { AgentCard } from './AgentCard'

interface DashboardProps {
  state: ConsoleState
  snapshot: RuntimeSnapshot
  selectedProjectId: string
  search: string
  onOpenAgent: (agentId: string) => void
  onCloseTerminal: (agentId: string) => void
  onEditAgent: (agent: AgentConfig) => void
  onEditProject: (project: Project) => void
  onAddAgent: (projectId: string) => void
  onRestoreProject: (projectId: string) => void
}

function Metric({ label, value, detail, tone = 'default' }: { label: string; value: string | number; detail: string; tone?: string }) {
  return (
    <div className={`overview-metric overview-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

export function Dashboard({
  state,
  snapshot,
  selectedProjectId,
  search,
  onOpenAgent,
  onCloseTerminal,
  onEditAgent,
  onEditProject,
  onAddAgent,
  onRestoreProject,
}: DashboardProps) {
  const i18n = useI18n()
  const { t } = i18n
  const selectedProject = state.projects.find((project) => project.id === selectedProjectId)
  const visibleProjects = [...state.projects]
    .filter((project) => selectedProjectId === 'all' || project.id === selectedProjectId)
    .sort((a, b) => a.order - b.order)
  const projectIds = new Set(visibleProjects.map((project) => project.id))
  const query = search.trim().toLowerCase()
  const visibleAgents = snapshot.agents.filter((agent) => {
    if (!projectIds.has(agent.projectId)) return false
    if (!query) return true
    return `${agent.name} ${agent.kind} ${agent.cwd} ${agent.tmuxSession} ${agent.lastOutput}`
      .toLowerCase()
      .includes(query)
  })
  const active = visibleAgents.filter((agent) => agent.status === 'running' || agent.status === 'thinking').length
  const waiting = visibleAgents.filter((agent) => agent.status === 'waiting').length
  const errors = visibleAgents.filter((agent) => agent.status === 'error').length
  const totalCpu = visibleAgents.reduce((sum, agent) => sum + agent.cpu, 0)
  const totalMemory = visibleAgents.reduce((sum, agent) => sum + agent.memory, 0)

  return (
    <main className="dashboard">
      <header className="dashboard-heading">
        <div>
          <div className="eyebrow">{t(selectedProject ? 'PROJECT DASHBOARD' : 'MISSION OVERVIEW')}</div>
          <h1>{selectedProject ? `${selectedProject.emoji} ${selectedProject.name}` : t('All Projects')}</h1>
          <p>{t(selectedProject ? 'Live status, resource use, and terminal access.' : 'Every project and Agent on this machine, in one view.')}</p>
        </div>
        {selectedProject && (
          <div className="dashboard-heading__actions">
            <button className="action-button" onClick={() => onEditProject(selectedProject)}><Pencil size={15} /> {t('Edit Project')}</button>
            <button className="action-button" onClick={() => onAddAgent(selectedProject.id)}><Plus size={15} /> {t('Add Agent')}</button>
            <button className="action-button action-button--primary" onClick={() => onRestoreProject(selectedProject.id)}><RotateCcw size={15} /> {t('Restore workspace')}</button>
          </div>
        )}
      </header>

      <section className="overview-strip" aria-label={t('Status overview')}>
        <Metric label={t('VISIBLE AGENTS')} value={visibleAgents.length} detail={t(visibleProjects.length === 1 ? '{{count}} project' : '{{count}} projects', { count: visibleProjects.length })} />
        <Metric label={t('ACTIVE NOW')} value={active} detail={t('{{count}} waiting for you', { count: waiting })} tone="active" />
        <Metric label={t('ATTENTION')} value={errors} detail={t(errors ? 'Errors need review' : 'No active errors')} tone={errors ? 'error' : 'default'} />
        <Metric label={t('TOTAL CPU')} value={formatPercent(totalCpu, i18n)} detail={t('{{value}} memory', { value: formatPercent(totalMemory, i18n) })} />
        <div className="overview-health">
          <Activity size={18} />
          <div><strong>{t(snapshot.scanError ? 'SCAN DEGRADED' : 'SYSTEM LIVE')}</strong><small>{snapshot.scanError ? i18n.message(snapshot.scanError) : t('Updated {{time}}', { time: i18n.formatTime(snapshot.capturedAt) })}</small></div>
        </div>
      </section>

      {visibleProjects.map((project) => {
        const projectAgents = visibleAgents
          .filter((agent) => agent.projectId === project.id)
          .sort((a, b) => a.order - b.order)
        const allProjectAgents = snapshot.agents.filter((agent) => agent.projectId === project.id)
        if (query && projectAgents.length === 0 && !project.name.toLowerCase().includes(query)) return null
        const projectActive = allProjectAgents.filter((agent) => ['running', 'thinking'].includes(agent.status)).length
        const projectWaiting = allProjectAgents.filter((agent) => agent.status === 'waiting').length
        const projectError = allProjectAgents.some((agent) => agent.status === 'error')

        return (
          <section className="project-section" key={project.id}>
            <header className="project-section__header">
              <div className="project-title">
                <span className="project-title__glyph" style={{ color: project.color, borderColor: `${project.color}55` }}>{project.emoji}</span>
                <div>
                  <h2>{project.name}</h2>
                  <p>
                    <span className="inline-health" style={{ background: projectError ? '#ff6577' : projectActive ? '#3ddc97' : '#586272' }} />
                    {t('{{active}} active · {{waiting}} waiting · {{total}} total', { active: projectActive, waiting: projectWaiting, total: allProjectAgents.length })}
                  </p>
                </div>
              </div>
              <div className="project-section__actions">
                {projectError && <span className="attention-note"><AlertTriangle size={13} /> {t('Attention')}</span>}
                <button className="text-button" onClick={() => onEditProject(project)}><Pencil size={14} /> {t('Edit Project')}</button>
                <button className="text-button" onClick={() => onAddAgent(project.id)}><Plus size={14} /> {t('Agent')}</button>
                <button className="text-button" onClick={() => onRestoreProject(project.id)}><RotateCcw size={14} /> {t('Restore')}</button>
              </div>
            </header>

            {projectAgents.length > 0 ? (
              <div className="agent-grid">
                {projectAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    project={project}
                    onOpen={() => onOpenAgent(agent.id)}
                    onCloseTerminal={() => onCloseTerminal(agent.id)}
                    onEdit={() => onEditAgent(agent)}
                  />
                ))}
              </div>
            ) : (
              <div className="project-empty">
                {query ? <SearchX size={22} /> : <FolderOpen size={22} />}
                <div>
                  <strong>{t(query ? 'No matching Agents' : 'No Agents in this project')}</strong>
                  <span>{t(query ? 'Try a different search.' : 'Add one manually or import a discovered process.')}</span>
                </div>
                {!query && <button className="text-button" onClick={() => onAddAgent(project.id)}><Sparkles size={14} /> {t('Add first Agent')}</button>}
              </div>
            )}
          </section>
        )
      })}
    </main>
  )
}
