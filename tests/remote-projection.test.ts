import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot } from '../shared/types'
import { createRemoteSafeSnapshot } from '../core/remote-projection'

describe('remote-safe projection', () => {
  it('does not expose local control or process details', () => {
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
    const safe = createRemoteSafeSnapshot(snapshot, [{
      id: 'task-1', agentId: 'agent-1', projectId: 'project-1', displayName: 'Agent', kind: 'codex',
      status: 'waiting', summary: 'Agent is waiting for input.', present: true,
      firstSeenAt: snapshot.capturedAt, lastSeenAt: snapshot.capturedAt, sourceCapturedAt: snapshot.capturedAt,
    }])
    expect(safe.agents[0]).toEqual({
      id: 'agent-1', projectId: 'project-1', name: 'Agent', emoji: '◆', color: '#55a6ff', kind: 'codex',
      status: 'waiting', updatedAt: snapshot.capturedAt, taskId: 'task-1',
    })
    const json = JSON.stringify(safe)
    for (const secret of ['command', 'cwd', 'logPath', 'matchPattern', 'pid', 'tmux', 'private output', 'secret-pane']) {
      expect(json).not.toContain(secret)
    }
  })
})
