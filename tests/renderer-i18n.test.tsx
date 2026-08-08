import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Project, RuntimeAgent } from '../shared/types'
import { AgentCard } from '../src/components/AgentCard'
import { AgentEditor, ProjectEditor } from '../src/components/Editors'
import { I18nProvider } from '../src/lib/i18n'

const project: Project = {
  id: 'project',
  groupId: 'workspace',
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
  note: '手动备注内容',
  goal: '手动目标内容',
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
  codexSession: null,
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
          onDelete={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('内存')
    expect(markup).toContain('关闭窗口')
    expect(markup).toContain('All Projects')
    expect(markup).toContain('Backend')
    expect(markup).toContain('No live process matched')
    expect(markup).not.toContain('未匹配到正在运行的进程')
    expect(markup).not.toContain('◆')
  })

  it('renders the compact Codex session card without generic process metrics', () => {
    const codex: RuntimeAgent = {
      ...agent,
      name: 'Codex One',
      kind: 'codex',
      pid: 321,
      runtimeSeconds: 120,
      status: 'thinking',
      codexSession: {
        createdAt: '2026-08-08T09:15:00.000Z',
        goal: '来自 /goal 的目标',
        firstPrompt: '第一条用户命令'.repeat(8),
        latestPrompt: '最近一条用户命令'.repeat(8),
        lastCompletedResponse: '最近完成任务的返回内容'.repeat(8),
      },
    }
    const markup = renderToStaticMarkup(
      <I18nProvider language="zh-CN">
        <AgentCard
          agent={codex}
          project={project}
          onOpen={vi.fn()}
          onCloseTerminal={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('创建时间')
    expect(markup).toContain('运行文件夹')
    expect(markup).toContain('第一条命令')
    expect(markup).toContain('最近一条命令')
    expect(markup).toContain('最近完成任务的回复')
    expect(markup).toContain('来自 /goal 的目标')
    expect(markup).toContain('备注')
    expect(markup).toContain('手动备注内容')
    expect(markup).toContain('当前运行状态')
    expect(markup).toContain('聚焦')
    expect(markup).not.toContain('CPU')
    expect(markup).not.toContain('PID')
    expect(markup).not.toContain('关闭窗口')
  })

  it('uses localized defaults for newly created user records', () => {
    const agentMarkup = renderToStaticMarkup(
      <I18nProvider language="zh-CN">
        <AgentEditor projects={[project]} initial={{}} existing={false} onSave={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )
    const projectMarkup = renderToStaticMarkup(
      <I18nProvider language="zh-CN">
        <ProjectEditor groups={[{ id: 'workspace', name: 'Workspace', collapsed: false, order: 0 }]} agentCount={0} onSave={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )

    expect(agentMarkup).toContain('value="新建 Agent"')
    expect(agentMarkup).toContain('value="新建 Agent"')
    expect(agentMarkup).not.toContain('>图标<')
    expect(agentMarkup).toContain('type="checkbox" checked=""')
    expect(projectMarkup).toContain('value="新建项目"')
  })
})
