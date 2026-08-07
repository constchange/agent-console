import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Project, RuntimeAgent } from '../shared/types'
import { AgentCard } from '../src/components/AgentCard'
import { AgentEditor, ProjectEditor } from '../src/components/Editors'
import { I18nProvider } from '../src/lib/i18n'

const project: Project = {
  id: 'project',
  name: 'All Projects',
  emoji: '◇',
  color: '#55a6ff',
  collapsed: false,
  order: 0,
}

const agent: RuntimeAgent = {
  id: 'agent',
  projectId: project.id,
  name: 'Backend',
  emoji: '◆',
  color: '#a478ff',
  kind: 'backend',
  terminalTitle: 'Backend',
  terminalApp: 'auto',
  tmuxSession: '',
  command: '',
  cwd: '/workspace/example',
  matchPattern: '',
  logPath: '',
  autoStart: false,
  order: 0,
  pid: null,
  statusOverride: null,
  cpu: 1.2,
  memory: 2.4,
  runtimeSeconds: 65,
  status: 'offline',
  lastUpdated: '2026-08-07T00:00:00.000Z',
  lastOutput: 'No live process matched',
  processName: '',
  processState: '',
  terminalOpen: false,
}

describe('renderer localization boundary', () => {
  it('localizes fixed chrome without translating user names or raw terminal output', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider language="zh-CN">
        <AgentCard
          agent={agent}
          project={project}
          onOpen={vi.fn()}
          onCloseTerminal={vi.fn()}
          onEdit={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('内存')
    expect(markup).toContain('关闭窗口')
    expect(markup).toContain('All Projects')
    expect(markup).toContain('Backend')
    expect(markup).toContain('No live process matched')
    expect(markup).not.toContain('未匹配到正在运行的进程')
  })

  it('uses localized defaults for newly created user records', () => {
    const agentMarkup = renderToStaticMarkup(
      <I18nProvider language="zh-CN">
        <AgentEditor projects={[project]} initial={{}} existing={false} onSave={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )
    const projectMarkup = renderToStaticMarkup(
      <I18nProvider language="zh-CN">
        <ProjectEditor agentCount={0} onSave={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )

    expect(agentMarkup).toContain('value="新建 Agent"')
    expect(agentMarkup).toContain('value="◆ 新建 Agent"')
    expect(projectMarkup).toContain('value="新建项目"')
  })
})
