import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '../shared/types'
import { classifyProcess, inferStatus } from '../core/services/classification'
import { buildDiscovered, extractProcessKeywords, parsePsOutput, parseTmuxOutput } from '../core/services/process-monitor'

const processInfo = (overrides: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid: 1200,
  ppid: 1100,
  cpu: 0.1,
  memory: 1.2,
  runtimeSeconds: 80,
  processState: 'S+',
  tty: 'pts/2',
  command: 'codex',
  args: 'codex',
  cwd: '/tmp/project',
  kind: 'codex',
  ...overrides,
})

describe('process classification', () => {
  it('identifies the supported runtime families', () => {
    expect(classifyProcess('codex', 'codex --full-auto')).toBe('codex')
    expect(classifyProcess('node', 'node /repo/node_modules/vite/bin/vite.js')).toBe('backend')
    expect(classifyProcess('python3', 'python3 worker.py')).toBe('worker')
    expect(classifyProcess('python3', 'python3 analysis.py')).toBe('python')
    expect(classifyProcess('node', 'node index.js')).toBe('node')
    expect(classifyProcess('kitty', 'kitty')).toBe('terminal')
  })

  it('does not rediscover Agent Console itself', () => {
    expect(classifyProcess('electron', '/repo/agent-console/dist/electron/main.js')).toBeNull()
  })

  it('includes ordinary interactive terminal work without classifying background services', () => {
    expect(classifyProcess('bash', '-bash', 'pts/4')).toBe('terminal')
    expect(classifyProcess('nvim', 'nvim README.md', 'pts/4')).toBe('process')
    expect(classifyProcess('nvim', 'nvim README.md', '?')).toBeNull()
  })

  it('extracts concise Chinese and English process keywords', () => {
    expect(extractProcessKeywords('agent-console', '销售数据看板', 'npm run customer-sync --watch')).toEqual([
      'agent-console',
      '销售数据看板',
      'npm',
      'customer-sync',
      'customer',
      'sync',
      'watch',
    ])
  })
})

describe('status inference', () => {
  it('handles offline, waiting, thinking, errors, and active processes', () => {
    expect(inferStatus(null, '', 'codex')).toBe('offline')
    expect(inferStatus(processInfo(), 'Waiting for user approval', 'codex')).toBe('waiting')
    expect(inferStatus(processInfo(), 'Thinking about the next patch', 'codex')).toBe('thinking')
    expect(inferStatus(processInfo(), 'fatal: could not connect', 'codex')).toBe('error')
    expect(inferStatus(processInfo({ processState: 'R+', cpu: 22 }), '', 'codex')).toBe('running')
    expect(inferStatus(processInfo(), 'shell ready', 'codex')).toBe('idle')
  })

  it('keeps a structured active Codex task running even while its process is sleeping', () => {
    const sleepingCodex = processInfo({ processState: 'Sl+', cpu: 0.1 })
    expect(inferStatus(sleepingCodex, '', 'codex', null, 0, true)).toBe('running')
    expect(inferStatus(sleepingCodex, 'Previous task completed successfully', 'codex', null, 0, true)).toBe('running')
    expect(inferStatus(sleepingCodex, '', 'codex', null, 0, false)).toBe('idle')
  })

  it('honors a manual override', () => {
    expect(inferStatus(null, '', 'codex', 'finished')).toBe('finished')
  })

  it('recognizes conservative Chinese status signals', () => {
    expect(inferStatus(processInfo(), '正在分析仓库结构', 'codex')).toBe('thinking')
    expect(inferStatus(processInfo(), '等待用户确认后继续', 'codex')).toBe('waiting')
    expect(inferStatus(processInfo(), '任务已完成', 'codex')).toBe('finished')
    expect(inferStatus(processInfo(), '测试失败：无法连接数据库', 'codex')).toBe('error')
    expect(inferStatus(processInfo(), '测试已完成，共 2 个失败', 'codex')).toBe('error')
    expect(inferStatus(processInfo(), '检查完成，当前没有错误', 'codex')).toBe('idle')
    expect(inferStatus(processInfo(), '检查完成，没有发生错误', 'codex')).toBe('idle')
    expect(inferStatus(processInfo(), '尚未全部测试通过', 'codex')).toBe('idle')
    expect(inferStatus(processInfo(), '测试已完成，共 0 个失败', 'codex')).toBe('finished')
  })
})

describe('system output parsers', () => {
  it('parses ps rows with a command line containing spaces', () => {
    const rows = parsePsOutput('  2201  2100  4.2  1.7  367 R+ pts/3 codex codex --full-auto --search\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 2201, ppid: 2100, cpu: 4.2, command: 'codex', kind: 'codex' })
    expect(rows[0].args).toBe('codex --full-auto --search')
  })

  it('marks an unknown command on a TTY as a discoverable regular process', () => {
    const rows = parsePsOutput('  3301  3200  0.2  0.4  99 S+ pts/4 nvim nvim README.md\n')
    expect(rows[0]).toMatchObject({ command: 'nvim', tty: 'pts/4', kind: 'process' })
  })

  it('keeps ordinary terminal work out of AI CLI discovery', () => {
    const shell = processInfo({ pid: 3200, ppid: 3000, command: 'bash', args: 'bash', kind: 'terminal', tty: 'pts/4' })
    const editor = processInfo({ pid: 3300, ppid: 3200, command: 'nvim', args: 'nvim README.md', kind: 'process', tty: 'pts/4' })
    const discovered = buildDiscovered([shell, editor], [], [])
    expect(discovered).toEqual([])
  })

  it('discovers Codex inside tmux while skipping non-AI tmux panes', () => {
    const codex = processInfo({ pid: 3300, ppid: 3200, command: 'codex', args: 'codex', kind: 'codex' })
    const shell = processInfo({ pid: 4400, ppid: 4300, command: 'bash', args: 'bash', kind: 'terminal' })
    const panes = parseTmuxOutput([
      'ai\tmain\t%1\t3200\tcodex\t/home/user/ai\t1\t0\t1720000000',
      'shell\tmain\t%2\t4300\tbash\t/home/user/shell\t1\t0\t1720000000',
    ].join('\n'))
    const discovered = buildDiscovered([codex, shell], panes, [])
    expect(discovered).toHaveLength(1)
    expect(discovered[0]).toMatchObject({ kind: 'codex', tmuxSession: 'ai', pid: 3300 })
  })

  it('parses tmux panes', () => {
    const panes = parseTmuxOutput('review\tmain\t%1\t3001\tcodex\t/home/user/review\t1\t0\t1720000000\n')
    expect(panes).toHaveLength(1)
    expect(panes[0]).toMatchObject({ session: 'review', window: 'main', panePid: 3001, active: true, dead: false })
  })
})
