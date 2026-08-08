import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProcessMonitor } from '../core/services/process-monitor'
import type { SystemManager } from '../core/services/system-manager'
import { createDefaultState } from '../core/services/state-store'
import type { DiscoveredItem, RuntimeSnapshot, SystemCapabilities } from '../shared/types'

const capabilities: SystemCapabilities = {
  platform: 'linux',
  terminals: [],
  tmux: false,
  wmctrl: false,
  xdotool: false,
  docker: false,
  homeDirectory: '/home/test',
}

const discoveredProcess: DiscoveredItem = {
  id: 'process-4242',
  name: 'Node · agent-console',
  suggestedName: 'Node · agent-console',
  emoji: '⬢',
  color: '#66ccff',
  kind: 'node',
  pid: 4242,
  ppid: 1,
  cpu: 1,
  memory: 2,
  runtimeSeconds: 60,
  command: 'node',
  args: 'node server.js',
  cwd: '/home/test/agent-console',
  tmuxSession: '',
  terminalTitle: '⬢ Node · agent-console',
  lastOutput: 'node server.js',
  status: 'running',
  keywords: ['server'],
}

function snapshot(includeDiscovery: boolean): RuntimeSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agents: [],
    discovered: includeDiscovery ? [discoveredProcess] : [],
    capabilities,
    scanError: null,
  }
}

type ProcessMonitorInternals = {
  performScan: (includeDiscovery: boolean) => Promise<RuntimeSnapshot>
  scanPromise: Promise<RuntimeSnapshot> | null
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ProcessMonitor discovery lifecycle', () => {
  it('keeps discovery enabled when an active-client timer overlaps a manual refresh', async () => {
    vi.useFakeTimers()
    const state = createDefaultState()
    state.settings.scanIntervalMs = 50
    const monitor = new ProcessMonitor(
      () => state,
      {} as SystemManager,
    )
    const internals = monitor as unknown as ProcessMonitorInternals
    const published: RuntimeSnapshot[] = []
    const includeDiscoveryCalls: boolean[] = []
    let releaseFirstScan: (() => void) | undefined
    let delayNextScan = false
    vi.spyOn(internals, 'performScan').mockImplementation(async (includeDiscovery) => {
      includeDiscoveryCalls.push(includeDiscovery)
      if (delayNextScan) {
        delayNextScan = false
        await new Promise<void>((resolve) => {
          releaseFirstScan = resolve
        })
      }
      return snapshot(includeDiscovery)
    })
    monitor.subscribe((next) => published.push(next))

    monitor.setActiveClients(1)
    await internals.scanPromise
    expect(includeDiscoveryCalls).toEqual([true])
    expect(published.map((item) => item.discovered.length)).toEqual([1])
    includeDiscoveryCalls.length = 0
    published.length = 0
    delayNextScan = true
    const manualRefresh = monitor.scan(true)
    await vi.advanceTimersByTimeAsync(50)
    releaseFirstScan?.()

    try {
      const result = await manualRefresh
      expect(includeDiscoveryCalls).toEqual([true, true])
      expect(published.map((item) => item.discovered.length)).toEqual([1, 1])
      expect(result.discovered).toEqual([discoveredProcess])
      expect(monitor.current?.discovered).toEqual([discoveredProcess])
    } finally {
      monitor.stop()
    }
  })

  it('keeps the low-cost scan when no desktop client is connected', async () => {
    vi.useFakeTimers()
    const state = createDefaultState()
    state.settings.scanIntervalMs = 50
    const monitor = new ProcessMonitor(
      () => state,
      {} as SystemManager,
    )
    const scan = vi.spyOn(monitor as unknown as ProcessMonitorInternals, 'performScan')
      .mockImplementation(async (includeDiscovery) => snapshot(includeDiscovery))

    monitor.start()
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(scan).toHaveBeenCalledTimes(1)
      expect(scan).toHaveBeenLastCalledWith(false)
    } finally {
      monitor.stop()
    }
  })
})
