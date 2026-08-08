import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  centeredWindowBounds,
  parseWmctrlWindows,
  TerminalManager,
  terminalWindowIdentity,
  windowTitle,
  type DesktopWindowRecord,
} from '../electron/services/terminal-manager'
import type { AgentConfig, ConsoleSettings, DiscoveredItem } from '../shared/types'

const settings: ConsoleSettings = {
  language: 'en',
  defaultTerminal: 'auto',
  scanIntervalMs: 2_500,
  compactMode: true,
  fontSizePx: 25,
  theme: 'navy-gold',
}

function agent(id: string, pid: number): AgentConfig {
  return {
    id,
    projectId: 'project',
    name: 'Codex',
    emoji: '◆',
    color: '#55a6ff',
    kind: 'codex',
    terminalTitle: '◆ Codex',
    terminalApp: 'auto',
    tmuxSession: '',
    command: '',
    cwd: '/workspace/project',
    note: '',
    goal: '',
    matchPattern: '',
    logPath: '',
    autoStart: false,
    order: 0,
    pid,
    statusOverride: null,
  }
}

function wmctrlOutput(windows: DesktopWindowRecord[]): string {
  return windows.map((item) => `${item.id}  0 ${item.pid ?? -1} host ${item.title}`).join('\n')
}

describe('terminal window identity and focus', () => {
  it('centers a window at exactly three fifths of the current display work area', () => {
    expect(centeredWindowBounds({ x: -1920, y: 30, width: 1920, height: 1050 })).toEqual({
      x: -1536,
      y: 240,
      width: 1152,
      height: 630,
    })
  })

  it('gives Agents with the same visible title different stable identities', () => {
    const first = agent('agent-alpha', 1101)
    const second = agent('agent-beta', 2202)

    expect(terminalWindowIdentity(first.id)).not.toBe(terminalWindowIdentity(second.id))
    expect(windowTitle(first)).not.toBe(windowTitle(second))
    expect(windowTitle(first)).toContain('◆ Codex')
    expect(windowTitle(second)).toContain('◆ Codex')
  })

  it('parses window IDs without treating the visible title as the identity', () => {
    expect(parseWmctrlWindows([
      '0x03a00007  0 4121 host Agent Console · ◆ Codex · [AC:1111111111111111]',
      '0x03a00008  0 -1 host Terminal with spaces',
      'malformed',
    ].join('\n'))).toEqual([
      {
        id: '0x03a00007',
        pid: 4121,
        title: 'Agent Console · ◆ Codex · [AC:1111111111111111]',
      },
      { id: '0x03a00008', pid: null, title: 'Terminal with spaces' },
    ])
  })

  it('focuses the exact window for each running Agent and retains the mapping after title rewrites', async () => {
    const first = agent('agent-alpha', 1101)
    const second = agent('agent-beta', 2202)
    const windows: DesktopWindowRecord[] = [
      { id: '0x101', pid: 9001, title: 'Codex CLI' },
      { id: '0x202', pid: 9002, title: 'Codex CLI' },
    ]
    const ttyByPid = new Map([[1101, '/dev/pts/11'], [2202, '/dev/pts/22']])
    const windowIdByTty = new Map([['/dev/pts/11', '0x101'], ['/dev/pts/22', '0x202']])
    const activated: string[] = []
    const closed: string[] = []

    const exec = vi.fn(async (executable: string, args: string[]) => {
      if (executable === 'which') {
        if (args[0] === 'wmctrl') return { stdout: '/usr/bin/wmctrl\n', stderr: '' }
        throw new Error(`${args[0]} unavailable`)
      }
      if (executable === 'wmctrl' && args[0] === '-lp') {
        return { stdout: wmctrlOutput(windows), stderr: '' }
      }
      if (executable === 'wmctrl' && args[0] === '-i' && args[1] === '-a') {
        activated.push(args[2])
        return { stdout: '', stderr: '' }
      }
      if (executable === 'wmctrl' && args[0] === '-i' && args[1] === '-c') {
        closed.push(args[2])
        return { stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`)
    })
    const manager = new TerminalManager(settings, {
      execFile: exec,
      processAlive: () => true,
      readlink: async (target) => {
        const pid = Number(target.match(/^\/proc\/(\d+)\/fd\/1$/)?.[1])
        const tty = ttyByPid.get(pid)
        if (!tty) throw new Error('Unknown process')
        return tty
      },
      writeFile: async (target, data) => {
        const windowId = windowIdByTty.get(target)
        const title = data.match(/^\u001b]0;(.*)\u0007$/)?.[1]
        const targetWindow = windows.find((item) => item.id === windowId)
        if (!targetWindow || !title) throw new Error('Unknown terminal')
        targetWindow.title = title
      },
      spawnDetached: () => { throw new Error('Focus must not open another terminal') },
      delay: async () => undefined,
    })

    await expect(manager.open(first)).resolves.toMatchObject({ ok: true, action: 'focused' })
    await expect(manager.open(second)).resolves.toMatchObject({ ok: true, action: 'focused' })
    expect(activated).toEqual(['0x101', '0x202'])

    windows[0].title = 'Codex rewrote this title'
    windows[1].title = 'Codex rewrote this title too'
    await expect(manager.listOpenAgentIds([first, second])).resolves.toEqual(new Set([first.id, second.id]))

    await expect(manager.open(second)).resolves.toMatchObject({ ok: true, action: 'focused' })
    await expect(manager.open(first)).resolves.toMatchObject({ ok: true, action: 'focused' })
    expect(activated.slice(-2)).toEqual(['0x202', '0x101'])

    await expect(manager.close(second)).resolves.toMatchObject({ ok: true, action: 'closed' })
    expect(closed).toEqual(['0x202'])
  })

  it('does not mark similarly titled windows as open without an exact Agent identity', async () => {
    const first = agent('agent-alpha', 1101)
    const second = agent('agent-beta', 2202)
    const windows: DesktopWindowRecord[] = [
      { id: '0x101', pid: 9001, title: '◆ Codex — unrelated window' },
    ]
    const manager = new TerminalManager(settings, {
      execFile: async (executable, args) => {
        if (executable === 'which') {
          if (args[0] === 'wmctrl') return { stdout: '/usr/bin/wmctrl\n', stderr: '' }
          throw new Error('unavailable')
        }
        if (executable === 'wmctrl' && args[0] === '-lp') return { stdout: wmctrlOutput(windows), stderr: '' }
        throw new Error('unexpected command')
      },
    })

    await expect(manager.listOpenAgentIds([first, second])).resolves.toEqual(new Set())
  })

  it('restores, resizes, centers, and then activates the exact Agent window', async () => {
    const target = agent('agent-centered', 3303)
    const title = windowTitle(target)
    const commands: Array<{ executable: string; args: string[] }> = []
    const manager = new TerminalManager(settings, {
      execFile: async (executable, args) => {
        commands.push({ executable, args })
        if (executable === 'which') {
          if (args[0] === 'wmctrl') return { stdout: '/usr/bin/wmctrl\n', stderr: '' }
          throw new Error('unavailable')
        }
        if (executable === 'wmctrl' && args[0] === '-lp') {
          return { stdout: `0x303 0 7003 host ${title}\n`, stderr: '' }
        }
        if (executable === 'wmctrl') return { stdout: '', stderr: '' }
        throw new Error('unexpected command')
      },
      processAlive: () => false,
    })

    await expect(manager.open(target, { x: 384, y: 210, width: 1152, height: 630 }))
      .resolves.toMatchObject({ ok: true, action: 'focused' })
    expect(commands.filter(({ executable }) => executable === 'wmctrl').map(({ args }) => args)).toEqual([
      ['-lp'],
      ['-i', '-r', '0x303', '-b', 'remove,maximized_vert,maximized_horz'],
      ['-i', '-r', '0x303', '-b', 'remove,fullscreen'],
      ['-i', '-r', '0x303', '-e', '0,384,210,1152,630'],
      ['-i', '-a', '0x303'],
    ])
  })

  it('writes a unique identity to each discovered TTY, then centers and activates the exact window', async () => {
    const commands: Array<{ executable: string; args: string[] }> = []
    const item = (id: string, pid: number, name: string): DiscoveredItem => ({
      id,
      name,
      suggestedName: name,
      emoji: 'C',
      color: '#55a6ff',
      kind: 'codex',
      pid,
      ppid: 2000,
      cpu: 0.2,
      memory: 0.4,
      runtimeSeconds: 90,
      command: 'codex',
      args: 'codex',
      cwd: '/workspace/project',
      tmuxSession: '',
      terminalTitle: name,
      lastOutput: '',
      status: 'running',
      keywords: ['project'],
    })
    const first = item('process-2201', 2201, 'Codex first')
    const second = item('process-2202', 2202, 'Codex second')
    const windows: DesktopWindowRecord[] = [
      { id: '0x0000002a', pid: 2000, title: 'Codex' },
      { id: '0x0000002b', pid: 2000, title: 'Codex' },
    ]
    const ttyByPid = new Map([[2201, '/dev/pts/21'], [2202, '/dev/pts/22']])
    const windowIdByTty = new Map([['/dev/pts/21', '0x0000002a'], ['/dev/pts/22', '0x0000002b']])
    const manager = new TerminalManager(settings, {
      execFile: async (executable, args) => {
        commands.push({ executable, args })
        if (executable === 'which') {
          if (args[0] === 'wmctrl') return { stdout: '/usr/bin/wmctrl\n', stderr: '' }
          throw new Error('unavailable')
        }
        if (executable === 'wmctrl' && args[0] === '-lp') {
          return { stdout: wmctrlOutput(windows), stderr: '' }
        }
        if (executable === 'wmctrl') return { stdout: '', stderr: '' }
        throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`)
      },
      readlink: async (target) => {
        const pid = Number(target.match(/^\/proc\/(\d+)\/fd\/1$/)?.[1])
        const tty = ttyByPid.get(pid)
        if (!tty) throw new Error('Unknown process')
        return tty
      },
      writeFile: async (target, data) => {
        const windowId = windowIdByTty.get(target)
        const title = data.match(/^\u001b]0;(.*)\u0007$/)?.[1]
        const targetWindow = windows.find((candidate) => candidate.id === windowId)
        if (!targetWindow || !title) throw new Error('Unknown terminal')
        targetWindow.title = title
      },
      processAlive: () => true,
      delay: async () => undefined,
    })

    const bounds = { x: 384, y: 210, width: 1152, height: 630 }
    await expect(manager.focusDiscovered(second, bounds)).resolves.toMatchObject({ ok: true, action: 'focused' })
    await expect(manager.focusDiscovered(first, bounds)).resolves.toMatchObject({ ok: true, action: 'focused' })

    const activations = commands
      .filter(({ executable, args }) => executable === 'wmctrl' && args[0] === '-i' && args[1] === '-a')
      .map(({ args }) => args[2])
    expect(activations).toEqual(['0x0000002b', '0x0000002a'])
    const moves = commands
      .filter(({ executable, args }) => executable === 'wmctrl' && args[0] === '-i' && args[1] === '-r' && args[3] === '-e')
      .map(({ args }) => [args[2], args[4]])
    expect(moves).toEqual([
      ['0x0000002b', '0,384,210,1152,630'],
      ['0x0000002a', '0,384,210,1152,630'],
    ])
  })

  it('makes the deb package install the focus helper instead of asking the user to do it', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      build?: { deb?: { depends?: string[] } }
    }
    const dependencies = packageJson.build?.deb?.depends ?? []
    expect(dependencies).toContain('wmctrl')
    expect(dependencies).toEqual(expect.arrayContaining([
      'libgtk-3-0',
      'libnss3',
      'xdg-utils',
      'libsecret-1-0',
    ]))
  })
})
