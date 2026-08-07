import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot } from '../shared/types'
import { createRemoteDashboard } from '../core/remote-projection'

describe('remote-safe projection', () => {
  it('projects only the active task and omits local control/process details', () => {
    const snapshot: RuntimeSnapshot = {
      capturedAt: '2026-08-06T20:00:00.000Z',
      agents: [{
        id: 'agent-1', projectId: 'project-1', name: 'Agent', emoji: '◆', color: '#55a6ff', kind: 'codex',
        terminalTitle: 'private', terminalApp: 'auto', tmuxSession: 'secret-pane', command: 'codex --secret',
        cwd: '/home/user/private', matchPattern: 'secret', logPath: '/home/user/private.log', autoStart: true,
        order: 0, pid: 1234, statusOverride: null, cpu: 1, memory: 2, runtimeSeconds: 3, status: 'waiting',
        lastUpdated: '2026-08-06T20:00:00.000Z', lastOutput: 'private output', processName: 'codex',
        processState: 'S+', terminalOpen: true,
      }],
      discovered: [],
      capabilities: { platform: 'linux', terminals: [], tmux: true, wmctrl: false, xdotool: false, docker: false, homeDirectory: '/home/user' },
      scanError: null,
    }
    const safe = createRemoteDashboard(snapshot, [{
      id: 'task-1', agentId: 'agent-1', adapter: 'tmux-compatibility', status: 'needs_input',
      summary: 'Agent is waiting for input.', active: true, version: 4,
      createdAt: snapshot.capturedAt, updatedAt: snapshot.capturedAt,
    }], {
      streamId: 'stream-1', oldestAvailableSeq: 1, latestSeq: 8,
    }, () => ({ view: true, viewEvents: true, message: true, approve: false, interrupt: true }))

    expect(safe.agents[0]).toMatchObject({
      id: 'agent-1', projectId: 'project-1', name: 'Agent', status: 'needs_attention',
      task: { id: 'task-1', version: 4 },
    })
    const json = JSON.stringify(safe)
    for (const secret of ['command', 'cwd', 'logPath', 'matchPattern', 'pid', 'tmuxSession', 'private output', 'secret-pane']) {
      expect(json).not.toContain(secret)
    }
  })
})
