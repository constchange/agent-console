import { describe, expect, it } from 'vitest'
import { createDefaultState } from '../core/services/state-store'
import { reorderAgents, reorderGroups, reorderProjects } from '../src/lib/tree-order'

describe('category, Project, and Agent tree ordering', () => {
  it('reorders categories', () => {
    const groups = [
      { id: 'one', name: 'One', collapsed: false, order: 0 },
      { id: 'two', name: 'Two', collapsed: false, order: 1 },
      { id: 'three', name: 'Three', collapsed: false, order: 2 },
    ]
    expect(reorderGroups(groups, 'three', 'one').sort((a, b) => a.order - b.order).map((group) => group.id))
      .toEqual(['three', 'one', 'two'])
  })

  it('moves a Project and implicitly keeps every child Agent attached', () => {
    const state = createDefaultState()
    state.groups.push({ id: 'second', name: 'Second', collapsed: false, order: 1 })
    const moved = reorderProjects(state.projects, 'product', 'second')
    expect(moved.find((project) => project.id === 'product')).toMatchObject({ groupId: 'second', order: 0 })
    expect(state.agents.filter((agent) => agent.projectId === 'product')).toHaveLength(2)
  })

  it('moves and reorders an Agent while inheriting the destination Project color', () => {
    const state = createDefaultState()
    const source = state.agents.find((agent) => agent.projectId === 'product')!
    const target = state.projects.find((project) => project.id === 'sales')!
    const targetFirst = state.agents.filter((agent) => agent.projectId === target.id).sort((a, b) => a.order - b.order)[0]
    const moved = reorderAgents(state.agents, state.projects, source.id, target.id, targetFirst.id)
    expect(moved.find((agent) => agent.id === source.id)).toMatchObject({
      projectId: target.id,
      order: 0,
      color: target.color,
      emoji: '',
    })
    expect(moved.find((agent) => agent.id === targetFirst.id)?.order).toBe(1)
    expect(moved.filter((agent) => agent.projectId === 'product').map((agent) => agent.order)).toEqual([0])
  })
})
