import { describe, expect, it, vi } from 'vitest'
import { TmuxControlAdapter, type TmuxCommandRunner } from '../core/adapters/tmux-control'

function stat(startTime = '777'): string {
  const beforeStart = [
    'S', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18',
  ]
  return `900 (codex worker) ${beforeStart.join(' ')} ${startTime} 0 0 0`
}

function runner(overrides: Partial<TmuxCommandRunner> = {}): TmuxCommandRunner {
  return {
    exec: vi.fn(async (file: string, args: string[]) => {
      if (file === 'tmux' && args[0] === 'list-panes') return { stdout: '%4\t701\tcodex\t0\n' }
      if (file === 'ps' && args.includes('tpgid=')) return { stdout: '900\n' }
      if (file === 'ps' && args.includes('comm=')) return { stdout: 'codex\n' }
      return { stdout: '' }
    }),
    writeStdin: vi.fn(async () => undefined),
    readFile: vi.fn(async () => stat()),
    ...overrides,
  }
}

describe('TmuxControlAdapter', () => {
  it('binds an actionable pane to the foreground pid and process start time', async () => {
    const adapter = new TmuxControlAdapter(runner())
    await expect(adapter.inspect('codex-main')).resolves.toEqual({
      session: 'codex-main',
      paneId: '%4',
      panePid: 701,
      foregroundPid: 900,
      foregroundStartTime: '777',
      command: 'codex',
    })
  })

  it('refuses a session with multiple panes', async () => {
    const adapter = new TmuxControlAdapter(runner({
      exec: vi.fn(async () => ({ stdout: '%4\t701\tcodex\t0\n%5\t702\tcodex\t0\n' })),
    }))
    await expect(adapter.inspect('codex-main')).rejects.toThrow('exactly one pane')
  })

  it('refuses a pane that has returned to a shell', async () => {
    const adapter = new TmuxControlAdapter(runner({
      exec: vi.fn(async (file, args) => {
        if (file === 'tmux' && args[0] === 'list-panes') return { stdout: '%4\t701\tbash\t0\n' }
        return { stdout: '' }
      }),
    }))
    await expect(adapter.inspect('codex-main')).rejects.toThrow('no longer running Codex')
  })

  it('loads message bytes through stdin instead of placing them in a shell command', async () => {
    const fake = runner()
    const adapter = new TmuxControlAdapter(fake)
    const identity = await adapter.inspect('codex-main')
    const result = await adapter.sendMessage('codex-main', identity, 'please inspect $(touch /tmp/nope)', 'req-1')
    expect(result.ok).toBe(true)
    expect(fake.writeStdin).toHaveBeenCalledWith(
      'tmux',
      ['load-buffer', '-b', 'agent-console-req-1', '-'],
      'please inspect $(touch /tmp/nope)',
      { timeout: 2500 },
    )
    expect(fake.exec).toHaveBeenCalledWith(
      'tmux',
      [
        'paste-buffer', '-b', 'agent-console-req-1', '-t', '%4', '-d',
        ';',
        'send-keys', '-t', '%4', 'Enter',
      ],
      { timeout: 2500 },
    )
  })

  it('refuses delivery when the foreground pid start time changes', async () => {
    let reads = 0
    const fake = runner({
      readFile: vi.fn(async () => stat(String(++reads))),
    })
    const adapter = new TmuxControlAdapter(fake)
    const identity = await adapter.inspect('codex-main')
    await expect(adapter.sendMessage('codex-main', identity, 'hello', 'req-2')).rejects.toThrow('process changed')
    expect(fake.writeStdin).not.toHaveBeenCalled()
  })

  it('rejects control characters and oversized messages before invoking tmux', async () => {
    const fake = runner()
    const adapter = new TmuxControlAdapter(fake)
    const identity = await adapter.inspect('codex-main')
    await expect(adapter.sendMessage('codex-main', identity, 'bad\u0000text', 'req-3')).rejects.toThrow('control characters')
    await expect(adapter.sendMessage('codex-main', identity, 'x'.repeat(9_000), 'req-4')).rejects.toThrow('8 KiB')
    expect(fake.writeStdin).not.toHaveBeenCalled()
  })
})
