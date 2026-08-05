import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '../shared/types'
import { classifyProcess, inferStatus } from '../electron/services/classification'
import { parsePsOutput, parseTmuxOutput } from '../electron/services/process-monitor'

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

  it('honors a manual override', () => {
    expect(inferStatus(null, '', 'codex', 'finished')).toBe('finished')
  })
})

describe('system output parsers', () => {
  it('parses ps rows with a command line containing spaces', () => {
    const rows = parsePsOutput('  2201  2100  4.2  1.7  367 R+ pts/3 codex codex --full-auto --search\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 2201, ppid: 2100, cpu: 4.2, command: 'codex', kind: 'codex' })
    expect(rows[0].args).toBe('codex --full-auto --search')
  })

  it('parses tmux panes', () => {
    const panes = parseTmuxOutput('review\tmain\t%1\t3001\tcodex\t/home/user/review\t1\t0\t1720000000\n')
    expect(panes).toHaveLength(1)
    expect(panes[0]).toMatchObject({ session: 'review', window: 'main', panePid: 3001, active: true, dead: false })
  })
})
