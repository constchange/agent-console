import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Gauge,
  Pencil,
  Plus,
  Search,
  Settings,
} from 'lucide-react'
import type { AgentConfig, ConsoleState, Project, RuntimeSnapshot } from '../../shared/types'
import { STATUS_META } from '../lib/format'
import { useI18n } from '../lib/i18n'

interface SidebarProps {
  state: ConsoleState
  snapshot: RuntimeSnapshot
  selectedProjectId: string
  search: string
  onSearch: (value: string) => void
  onSelectProject: (id: string) => void
  onToggleProject: (project: Project) => void
  onAddProject: () => void
  onEditProject: (project: Project) => void
  onAddAgent: (projectId: string) => void
  onEditAgent: (agent: AgentConfig) => void
  onOpenAgent: (agentId: string) => void
  onReorderAgent: (sourceId: string, targetProjectId: string, targetAgentId?: string) => void
  onOpenSettings: () => void
}

export function Sidebar({
  state,
  snapshot,
  selectedProjectId,
  search,
  onSearch,
  onSelectProject,
  onToggleProject,
  onAddProject,
  onEditProject,
  onAddAgent,
  onEditAgent,
  onOpenAgent,
  onReorderAgent,
  onOpenSettings,
}: SidebarProps) {
  const { t } = useI18n()
  const runtimeById = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
  const projects = [...state.projects].sort((a, b) => a.order - b.order)
  const query = search.trim().toLowerCase()

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="brand-mark"><span /></div>
        <div>
          <strong>{t('AGENT CONSOLE')}</strong>
          <small>{t('LOCAL MISSION CONTROL')}</small>
        </div>
      </div>

      <label className="sidebar-search">
        <Search size={15} />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t('Search projects and agents')}
          aria-label={t('Search projects and agents')}
        />
        <kbd>Ctrl K</kbd>
      </label>

      <nav className="project-tree" aria-label={t('Project Explorer')}>
        <button
          className={`tree-home ${selectedProjectId === 'all' ? 'is-selected' : ''}`}
          onClick={() => onSelectProject('all')}
        >
          <Gauge size={16} />
          <span>{t('All Projects')}</span>
          <span className="tree-count">{state.agents.length}</span>
        </button>

        <div className="tree-label">
          <span>{t('PROJECTS')}</span>
          <button className="icon-button icon-button--small" onClick={onAddProject} title={t('New project')}>
            <FolderPlus size={14} />
          </button>
        </div>

        {projects.map((project) => {
          const allAgents = state.agents
            .filter((agent) => agent.projectId === project.id)
            .sort((a, b) => a.order - b.order)
          const filteredAgents = allAgents.filter((agent) => {
            if (!query) return true
            return `${agent.name} ${agent.kind} ${agent.cwd} ${agent.tmuxSession}`.toLowerCase().includes(query)
          })
          const projectMatches = project.name.toLowerCase().includes(query)
          if (query && !projectMatches && filteredAgents.length === 0) return null
          const active = allAgents.filter((agent) => {
            const status = runtimeById.get(agent.id)?.status
            return status === 'running' || status === 'thinking'
          }).length

          return (
            <div
              className="tree-project"
              key={project.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const sourceId = event.dataTransfer.getData('text/agent-id')
                if (sourceId) onReorderAgent(sourceId, project.id)
              }}
            >
              <div className={`tree-project__row ${selectedProjectId === project.id ? 'is-selected' : ''}`}>
                <button
                  className="tree-chevron"
                  onClick={() => onToggleProject(project)}
                  aria-label={t(project.collapsed ? 'Expand project' : 'Collapse project')}
                >
                  {project.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <button
                  className="tree-project__main"
                  onClick={() => onSelectProject(project.id)}
                  onDoubleClick={() => onEditProject(project)}
                  title={t('Open project · Double-click to edit')}
                >
                  <span className="project-glyph" style={{ color: project.color }}>{project.emoji}</span>
                  <span>{project.name}</span>
                </button>
                <span className="tree-health" title={t('{{count}} active of {{total}}', { count: active, total: allAgents.length })}>
                  <i style={{ background: active ? '#3ddc97' : '#4b5563' }} />
                  {active}/{allAgents.length}
                </span>
                <button
                  className="tree-action tree-action--project"
                  onClick={() => onEditProject(project)}
                  title={t('Edit {{name}}', { name: project.name })}
                  aria-label={t('Edit {{name}}', { name: project.name })}
                >
                  <Pencil size={14} />
                </button>
              </div>

              {!project.collapsed && (
                <div className="tree-agents">
                  {filteredAgents.map((agent) => {
                    const runtime = runtimeById.get(agent.id)
                    const meta = STATUS_META[runtime?.status ?? 'offline']
                    return (
                      <div
                        key={agent.id}
                        className="tree-agent"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/agent-id', agent.id)
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.stopPropagation()
                          event.preventDefault()
                          const sourceId = event.dataTransfer.getData('text/agent-id')
                          if (sourceId && sourceId !== agent.id) onReorderAgent(sourceId, project.id, agent.id)
                        }}
                        onDoubleClick={() => onOpenAgent(agent.id)}
                      >
                        <span className="tree-agent__line" style={{ background: project.color }} />
                        <span className="tree-agent__status" style={{ background: meta.color }} />
                        <span className="tree-agent__emoji" style={{ color: agent.color }}>{agent.emoji}</span>
                        <button onClick={() => onSelectProject(project.id)}>{agent.name}</button>
                        <small>{t(meta.label)}</small>
                        <button className="tree-action" onClick={() => onEditAgent(agent)} title={t('Edit agent')}>
                          <Pencil size={13} />
                        </button>
                      </div>
                    )
                  })}
                  {!query && (
                    <button className="tree-add-agent" onClick={() => onAddAgent(project.id)}>
                      <Plus size={13} /> {t('Add Agent')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <footer className="sidebar__footer">
        <div className="local-health">
          <span className="local-health__pulse" />
          <div>
            <strong>{t('LOCAL SYSTEM')}</strong>
            <small>{t(snapshot.capabilities.tmux ? '{{count}} terminals · tmux ready' : '{{count}} terminals · tmux unavailable', { count: snapshot.capabilities.terminals.length })}</small>
          </div>
        </div>
        <button className="icon-button" onClick={onOpenSettings} title={t('Settings')}>
          <Settings size={17} />
        </button>
      </footer>
    </aside>
  )
}
