import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsoleCore } from '../core/console-core'
import { resolveCorePaths } from '../core/paths'
import { createDefaultState, StateStore, stateRevision } from '../core/services/state-store'
import { CORE_PROTOCOL_VERSION, CORE_RPC_ERROR, type CoreBootstrapResult, type CoreConfigResult } from '../shared/core-protocol'
import type { ConsoleState, CoreHealth } from '../shared/types'

const directories: string[] = []
const context = { connectionId: 'test', channel: 'desktop' as const, client: { name: 'test', version: '0.5.0' } }
const gatewayContext = { connectionId: 'gateway-test', channel: 'gateway' as const, client: { name: 'gateway', version: '0.5.0' } }

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-core-integration-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('ConsoleCore migration and ownership', () => {
  it('preserves the existing v0.3 state, creates a one-time checkpoint and rejects stale writers', async () => {
    const directory = await temporaryDirectory()
    const existing = createDefaultState()
    existing.projects[0] = { ...existing.projects[0], name: 'Existing Product' }
    existing.settings = { ...existing.settings, theme: 'forest-studio', fontSizePx: 32 }
    const originalStore = new StateStore(directory)
    await originalStore.load()
    await originalStore.save(existing)
    await originalStore.flush()

    const core = new ConsoleCore(directory, '0.4.0')
    await core.start()
    try {
      const bootstrap = await core.handle('core.bootstrap', undefined, context) as CoreBootstrapResult
      expect(bootstrap.state.projects[0].name).toBe('Existing Product')
      expect(bootstrap.state.settings).toMatchObject({ theme: 'forest-studio', fontSizePx: 32 })
      expect(bootstrap.stateRevision).toBe(stateRevision(existing))
      expect(bootstrap.health).toMatchObject({ appVersion: '0.4.0', transport: 'unix', tcpListening: false })

      const updated: ConsoleState = structuredClone(bootstrap.state)
      updated.projects[0].name = 'Saved by Core'
      const committed = await core.handle('config.commit', {
        expectedRevision: bootstrap.stateRevision,
        state: updated,
      }, context) as CoreConfigResult
      expect(committed.state.projects[0].name).toBe('Saved by Core')

      await expect(core.handle('config.commit', {
        expectedRevision: bootstrap.stateRevision,
        state: existing,
      }, context)).rejects.toMatchObject({ code: CORE_RPC_ERROR.STALE_STATE })

      const health = await core.handle('core.health', undefined, context) as CoreHealth
      expect(health.stateRevision).toBe(committed.stateRevision)
      await expect(core.handle('remote.health', undefined, context)).rejects.toMatchObject({
        code: CORE_RPC_ERROR.FORBIDDEN_CHANNEL,
      })
      await expect(core.handle('config.get', undefined, gatewayContext)).rejects.toMatchObject({
        code: CORE_RPC_ERROR.FORBIDDEN_CHANNEL,
      })
      await expect(core.handle('remote.health', undefined, gatewayContext)).resolves.toMatchObject({
        online: true,
        protocolVersion: CORE_PROTOCOL_VERSION,
      })
      await expect(core.handle('remote.settings.get', undefined, context)).resolves.toMatchObject({
        phase: 'unconfigured',
        capabilities: { canRemoveWorkstation: false },
      })
      await expect(core.handle('remote.settings.get', undefined, gatewayContext)).rejects.toMatchObject({
        code: CORE_RPC_ERROR.FORBIDDEN_CHANNEL,
      })
    } finally {
      await core.stop()
    }

    const primary = JSON.parse(await fs.readFile(path.join(directory, 'mission-control-state.json'), 'utf8')) as ConsoleState
    const checkpoint = JSON.parse(await fs.readFile(path.join(directory, 'mission-control-state.pre-core-v0.4.json'), 'utf8')) as ConsoleState
    expect(primary.projects[0].name).toBe('Saved by Core')
    expect(checkpoint.projects[0].name).toBe('Existing Product')
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(directory, 'console-core.sqlite'))).mode & 0o777).toBe(0o600)
  })

  it('uses the login runtime directory and never defines a TCP endpoint', async () => {
    const paths = resolveCorePaths('/home/test/.config/agent-console', '/run/user/1000')
    expect(paths.desktopSocketPath).toBe('/run/user/1000/agent-console/desktop/core.sock')
    expect(paths.gatewaySocketPath).toBe('/run/user/1000/agent-console/gateway/core.sock')
    expect(Object.values(paths).some((value) => /(?:^|:)\d{2,5}$/.test(value))).toBe(false)

    const fallback = resolveCorePaths('/home/test/.config/agent-console', 'relative-runtime')
    expect(fallback.desktopSocketPath).toBe('/home/test/.config/agent-console/runtime/desktop/core.sock')
    expect(fallback.gatewaySocketPath).toBe('/home/test/.config/agent-console/runtime/gateway/core.sock')
  })
})
