import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DiscoveredItem, RuntimeSnapshot } from '../shared/types'
import { DiscoveryDrawer } from '../src/components/DiscoveryDrawer'
import { I18nProvider } from '../src/lib/i18n'

const item: DiscoveredItem = {
  id: 'process-4100',
  name: 'Editor · 销售看板',
  suggestedName: '销售看板 Editor',
  emoji: '>_',
  color: '#8b98a9',
  kind: 'process',
  pid: 4100,
  ppid: 4000,
  cpu: 1,
  memory: 2,
  runtimeSeconds: 60,
  command: 'nvim',
  args: 'nvim dashboard.tsx',
  cwd: '/workspace/sales-dashboard',
  tmuxSession: '',
  terminalTitle: 'Sales dashboard',
  lastOutput: 'dashboard.tsx',
  status: 'idle',
  keywords: ['sales-dashboard', '销售看板'],
}

const snapshot: RuntimeSnapshot = {
  capturedAt: '2026-08-07T00:00:00.000Z',
  agents: [],
  discovered: [item],
  capabilities: {
    platform: 'linux',
    terminals: ['gnome-terminal'],
    tmux: true,
    wmctrl: true,
    xdotool: false,
    docker: false,
    homeDirectory: '/home/test',
  },
  scanError: null,
}

describe('process discovery drawer', () => {
  it('renders bulk selection, a single destination Project, keywords, and direct focus controls', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider language="en">
        <DiscoveryDrawer
          open
          snapshot={snapshot}
          projects={[{ id: 'project', groupId: 'workspace', name: 'Sales', emoji: '↗', color: '#54c79b', collapsed: false, order: 0 }]}
          initialProjectId="project"
          onClose={vi.fn()}
          onRefresh={vi.fn()}
          onImport={vi.fn()}
          onFocus={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('Select visible')
    expect(markup).toContain('Add selected (0)')
    expect(markup).toContain('sales-dashboard')
    expect(markup).toContain('销售看板')
    expect(markup).toContain('Focus')
    expect(markup).not.toContain('Preview')
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2)
  })
})
