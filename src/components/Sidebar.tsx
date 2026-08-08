import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Gauge,
  GripVertical,
  Layers3,
  Pencil,
  Plus,
  Search,
  Settings,
} from 'lucide-react'
import type { DragEvent } from 'react'
import type { AgentConfig, ConsoleState, Project, ProjectGroup, RuntimeSnapshot } from '../../shared/types'
import { STATUS_META } from '../lib/format'
import { useI18n } from '../lib/i18n'

const GROUP_DRAG = 'application/x-agent-console-group'
const PROJECT_DRAG = 'application/x-agent-console-project'
const AGENT_DRAG = 'application/x-agent-console-agent'

function dragId(event: DragEvent, type: string): string {
  return event.dataTransfer.getData(type)
}

function pointerInsertionTarget<T extends { id: string }>(event: DragEvent, items: T[], currentId: string): string | undefined {
  const bounds = event.currentTarget.getBoundingClientRect()
  if (event.clientY <= bounds.top + bounds.height / 2) return currentId
  const currentIndex = items.findIndex((item) => item.id === currentId)
  return currentIndex < 0 ? undefined : items[currentIndex + 1]?.id
}

interface SidebarProps {
  state: ConsoleState
  snapshot: RuntimeSnapshot
  selectedProjectId: string
  search: string
  onSearch: (value: string) => void
  onSelectProject: (id: string) => void
  onToggleGroup: (group: ProjectGroup) => void
  onToggleProject: (project: Project) => void
  onAddGroup: () => void
  onEditGroup: (group: ProjectGroup) => void
  onAddProject: (groupId?: string) => void
  onEditProject: (project: Project) => void
  onAddAgent: (projectId: string) => void
  onEditAgent: (agent: AgentConfig) => void
  onOpenAgent: (agentId: string) => void
  onReorderGroup: (sourceId: string, targetId?: string) => void
  onReorderProject: (sourceId: string, targetGroupId: string, targetProjectId?: string) => void
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
  onToggleGroup,
  onToggleProject,
  onAddGroup,
  onEditGroup,
  onAddProject,
  onEditProject,
  onAddAgent,
  onEditAgent,
  onOpenAgent,
  onReorderGroup,
  onReorderProject,
  onReorderAgent,
  onOpenSettings,
}: SidebarProps) {
  const { t } = useI18n()
  const runtimeById = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
  const groups = [...state.groups].sort((a, b) => a.order - b.order)
  const query = search.trim().toLocaleLowerCase()

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
          placeholder={t('Search categories, projects and agents')}
          aria-label={t('Search categories, projects and agents')}
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
          <span>{t('CATEGORIES')}</span>
          <button className="icon-button icon-button--small" onClick={onAddGroup} title={t('New category')}>
            <Layers3 size={14} />
          </button>
        </div>

        {groups.map((group) => {
          const groupProjects = state.projects
            .filter((project) => project.groupId === group.id)
            .sort((a, b) => a.order - b.order)
          const visibleProjects = groupProjects.filter((project) => {
            if (!query || group.name.toLocaleLowerCase().includes(query) || project.name.toLocaleLowerCase().includes(query)) return true
            return state.agents.some((agent) => agent.projectId === project.id
              && `${agent.name} ${agent.kind} ${agent.cwd} ${agent.tmuxSession}`.toLocaleLowerCase().includes(query))
          })
          if (query && visibleProjects.length === 0 && !group.name.toLocaleLowerCase().includes(query)) return null

          return (
            <section
              className="tree-group"
              key={group.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const projectId = dragId(event, PROJECT_DRAG)
                const groupId = dragId(event, GROUP_DRAG)
                if (projectId) onReorderProject(projectId, group.id)
                else if (groupId && groupId !== group.id) onReorderGroup(groupId, group.id)
              }}
            >
              <div
                className="tree-group__row"
                draggable={!query}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(GROUP_DRAG, group.id)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.stopPropagation()
                  event.preventDefault()
                  const projectId = dragId(event, PROJECT_DRAG)
                  const groupId = dragId(event, GROUP_DRAG)
                  if (projectId) onReorderProject(projectId, group.id)
                  else if (groupId && groupId !== group.id) {
                    onReorderGroup(groupId, pointerInsertionTarget(event, groups, group.id))
                  }
                }}
              >
                <GripVertical className="tree-grip" size={13} aria-hidden="true" />
                <button
                  className="tree-chevron"
                  onClick={() => onToggleGroup(group)}
                  aria-label={t(group.collapsed ? 'Expand category' : 'Collapse category')}
                >
                  {group.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <button className="tree-group__main" onClick={() => onToggleGroup(group)} onDoubleClick={() => onEditGroup(group)}>
                  <span>{group.name}</span>
                  <small>{groupProjects.length}</small>
                </button>
                <button className="tree-action" onClick={() => onAddProject(group.id)} title={t('New project in {{name}}', { name: group.name })} aria-label={t('New project in {{name}}', { name: group.name })}>
                  <FolderPlus size={13} />
                </button>
                <button className="tree-action" onClick={() => onEditGroup(group)} title={t('Edit {{name}}', { name: group.name })} aria-label={t('Edit {{name}}', { name: group.name })}>
                  <Pencil size={13} />
                </button>
              </div>

              {(!group.collapsed || query) && (
                <div className="tree-group__projects">
                  {visibleProjects.map((project) => {
                    const allAgents = state.agents
                      .filter((agent) => agent.projectId === project.id)
                      .sort((a, b) => a.order - b.order)
                    const filteredAgents = allAgents.filter((agent) => !query
                      || project.name.toLocaleLowerCase().includes(query)
                      || `${agent.name} ${agent.kind} ${agent.cwd} ${agent.tmuxSession}`.toLocaleLowerCase().includes(query))
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
                          event.stopPropagation()
                          event.preventDefault()
                          const sourceAgentId = dragId(event, AGENT_DRAG)
                          const sourceProjectId = dragId(event, PROJECT_DRAG)
                          if (sourceAgentId) onReorderAgent(sourceAgentId, project.id)
                          else if (sourceProjectId && sourceProjectId !== project.id) {
                            onReorderProject(sourceProjectId, group.id, project.id)
                          }
                        }}
                      >
                        <div
                          className={`tree-project__row ${selectedProjectId === project.id ? 'is-selected' : ''}`}
                          draggable={!query}
                          onDragStart={(event) => {
                            event.stopPropagation()
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData(PROJECT_DRAG, project.id)
                          }}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            const sourceAgentId = dragId(event, AGENT_DRAG)
                            const sourceProjectId = dragId(event, PROJECT_DRAG)
                            if (sourceAgentId) onReorderAgent(sourceAgentId, project.id)
                            else if (sourceProjectId && sourceProjectId !== project.id) {
                              onReorderProject(
                                sourceProjectId,
                                group.id,
                                pointerInsertionTarget(event, groupProjects, project.id),
                              )
                            }
                          }}
                        >
                          <GripVertical className="tree-grip" size={12} aria-hidden="true" />
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
                          <button className="tree-action tree-action--project" onClick={() => onEditProject(project)} title={t('Edit {{name}}', { name: project.name })} aria-label={t('Edit {{name}}', { name: project.name })}>
                            <Pencil size={13} />
                          </button>
                        </div>

                        {(!project.collapsed || query) && (
                          <div className="tree-agents">
                            {filteredAgents.map((agent) => {
                              const runtime = runtimeById.get(agent.id)
                              const meta = STATUS_META[runtime?.status ?? 'offline']
                              return (
                                <div
                                  key={agent.id}
                                  className="tree-agent"
                                  draggable={!query}
                                  onDragStart={(event) => {
                                    event.stopPropagation()
                                    event.dataTransfer.effectAllowed = 'move'
                                    event.dataTransfer.setData(AGENT_DRAG, agent.id)
                                  }}
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={(event) => {
                                    event.stopPropagation()
                                    event.preventDefault()
                                    const sourceId = dragId(event, AGENT_DRAG)
                                    if (sourceId && sourceId !== agent.id) {
                                      onReorderAgent(sourceId, project.id, pointerInsertionTarget(event, allAgents, agent.id))
                                    }
                                  }}
                                >
                                  <GripVertical className="tree-grip" size={11} aria-hidden="true" />
                                  <span className="tree-agent__line" style={{ background: project.color }} />
                                  <span className="tree-agent__status" style={{ background: meta.color }} />
                                  <button onClick={() => onOpenAgent(agent.id)} title={t('Focus and center {{name}}', { name: agent.name })}>{agent.name}</button>
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
                  {!query && groupProjects.length === 0 && (
                    <button className="tree-empty-category" onClick={() => onAddProject(group.id)}>
                      <FolderPlus size={13} /> {t('Add first project')}
                    </button>
                  )}
                </div>
              )}
            </section>
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
