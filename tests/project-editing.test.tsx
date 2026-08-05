import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConsoleState, RuntimeSnapshot } from '../shared/types'
import { Dashboard } from '../src/components/Dashboard'
import { Sidebar } from '../src/components/Sidebar'

const project = {
  id: 'test-project',
  name: 'Test Project',
  emoji: '◇',
  color: '#55a6ff',
  collapsed: false,
  order: 0,
}

const state: ConsoleState = {
  version: 1,
  projects: [project],
  agents: [],
  settings: {
    defaultTerminal: 'auto',
    scanIntervalMs: 2_500,
    compactMode: true,
    fontSizePx: 25,
    theme: 'navy-gold',
  },
}

const snapshot: RuntimeSnapshot = {
  capturedAt: '2026-08-04T00:00:00.000Z',
  agents: [],
  discovered: [],
  capabilities: {
    platform: 'linux',
    terminals: [],
    tmux: false,
    wmctrl: false,
    xdotool: false,
    docker: false,
    homeDirectory: '/home/test',
  },
  scanError: null,
}

describe('project editing entry points', () => {
  it('keeps a named edit control in the project explorer', () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        state={state}
        snapshot={snapshot}
        selectedProjectId={project.id}
        search=""
        onSearch={vi.fn()}
        onSelectProject={vi.fn()}
        onToggleProject={vi.fn()}
        onAddProject={vi.fn()}
        onEditProject={vi.fn()}
        onAddAgent={vi.fn()}
        onEditAgent={vi.fn()}
        onOpenAgent={vi.fn()}
        onReorderAgent={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    expect(markup).toContain('aria-label="Edit Test Project"')
    expect(markup).toContain('Double-click to edit')
  })

  it('shows edit controls inside a selected project dashboard', () => {
    const markup = renderToStaticMarkup(
      <Dashboard
        state={state}
        snapshot={snapshot}
        selectedProjectId={project.id}
        search=""
        onOpenAgent={vi.fn()}
        onCloseTerminal={vi.fn()}
        onEditAgent={vi.fn()}
        onEditProject={vi.fn()}
        onAddAgent={vi.fn()}
        onRestoreProject={vi.fn()}
      />,
    )

    expect(markup.match(/Edit Project/g)).toHaveLength(2)
  })
})
