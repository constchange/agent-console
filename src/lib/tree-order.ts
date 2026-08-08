import type { AgentConfig, Project, ProjectGroup } from '../../shared/types'

function insertionIndex<T extends { id: string }>(items: T[], targetId?: string): number {
  if (!targetId) return items.length
  const index = items.findIndex((item) => item.id === targetId)
  return index < 0 ? items.length : index
}

export function normalizeProjectOrders(projects: Project[]): Project[] {
  const orderById = new Map<string, number>()
  for (const groupId of new Set(projects.map((project) => project.groupId))) {
    projects
      .filter((project) => project.groupId === groupId)
      .sort((a, b) => a.order - b.order)
      .forEach((project, order) => orderById.set(project.id, order))
  }
  return projects.map((project) => ({ ...project, order: orderById.get(project.id) ?? project.order }))
}

export function normalizeAgentOrders(agents: AgentConfig[]): AgentConfig[] {
  const orderById = new Map<string, number>()
  for (const projectId of new Set(agents.map((agent) => agent.projectId))) {
    agents
      .filter((agent) => agent.projectId === projectId)
      .sort((a, b) => a.order - b.order)
      .forEach((agent, order) => orderById.set(agent.id, order))
  }
  return agents.map((agent) => ({ ...agent, order: orderById.get(agent.id) ?? agent.order }))
}

export function reorderGroups(
  groups: ProjectGroup[],
  sourceId: string,
  targetId?: string,
): ProjectGroup[] {
  const source = groups.find((group) => group.id === sourceId)
  if (!source || sourceId === targetId) return groups
  const ordered = groups.filter((group) => group.id !== sourceId).sort((a, b) => a.order - b.order)
  ordered.splice(insertionIndex(ordered, targetId), 0, source)
  return ordered.map((group, order) => ({ ...group, order }))
}

export function reorderProjects(
  projects: Project[],
  sourceId: string,
  targetGroupId: string,
  targetId?: string,
): Project[] {
  const source = projects.find((project) => project.id === sourceId)
  if (!source || sourceId === targetId) return projects
  const containers = new Set(projects.map((project) => project.groupId))
  containers.add(targetGroupId)
  const result = new Map<string, Project>()

  for (const groupId of containers) {
    const ordered = projects
      .filter((project) => project.id !== sourceId && project.groupId === groupId)
      .sort((a, b) => a.order - b.order)
    if (groupId === targetGroupId) {
      ordered.splice(insertionIndex(ordered, targetId), 0, { ...source, groupId })
    }
    ordered.forEach((project, order) => result.set(project.id, { ...project, groupId, order }))
  }
  return projects.map((project) => result.get(project.id) ?? project)
}

export function reorderAgents(
  agents: AgentConfig[],
  projects: Project[],
  sourceId: string,
  targetProjectId: string,
  targetId?: string,
): AgentConfig[] {
  const source = agents.find((agent) => agent.id === sourceId)
  const project = projects.find((candidate) => candidate.id === targetProjectId)
  if (!source || !project || sourceId === targetId) return agents
  const containers = new Set(agents.map((agent) => agent.projectId))
  containers.add(targetProjectId)
  const result = new Map<string, AgentConfig>()

  for (const projectId of containers) {
    const ordered = agents
      .filter((agent) => agent.id !== sourceId && agent.projectId === projectId)
      .sort((a, b) => a.order - b.order)
    if (projectId === targetProjectId) {
      ordered.splice(insertionIndex(ordered, targetId), 0, {
        ...source,
        projectId,
        emoji: '',
        color: project.color,
      })
    }
    ordered.forEach((agent, order) => result.set(agent.id, { ...agent, order }))
  }
  return agents.map((agent) => result.get(agent.id) ?? agent)
}
