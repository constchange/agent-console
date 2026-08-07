import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderCoreServiceUnit } from '../core/services/core-service-unit'
import { CoreServiceManager, type CoreServiceState } from '../electron/services/core-service-manager'

const execFileMock = vi.hoisted(() => vi.fn((
  _file: string,
  _args: readonly string[],
  _options: unknown,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => callback(null, '', '')))

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '0.5.0' } }))

let fixture: string | null = null
const originalConfigHome = process.env.XDG_CONFIG_HOME

afterEach(async () => {
  execFileMock.mockClear()
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalConfigHome
  if (fixture) await rm(fixture, { recursive: true, force: true })
  fixture = null
})

describe('Core Remote environment refresh', () => {
  it('restarts Core even when the rendered unit path and bytes are unchanged', async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), 'agent-console-core-refresh-'))
    process.env.XDG_CONFIG_HOME = fixture
    const unitPath = path.join(fixture, 'systemd', 'user', 'agent-console-core.service')
    const userDataPath = path.join(fixture, 'user-data')
    const executable = '/opt/Agent Console/agent-console'
    await mkdir(path.dirname(unitPath), { recursive: true })
    await writeFile(unitPath, renderCoreServiceUnit(executable, userDataPath, null), { mode: 0o600 })

    const manager = new CoreServiceManager(userDataPath)
    const internals = manager as unknown as {
      launchExecutable: string
      serviceState: CoreServiceState
    }
    internals.launchExecutable = executable
    internals.serviceState = { mode: 'systemd-user', unitPath, launchExecutable: executable }

    await manager.refreshRemoteEnvironment()

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      '--user',
      'restart',
      'agent-console-core.service',
    ])
  })
})
