import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { matchesDetachedCoreIdentity } from '../electron/services/detached-core-identity'

let directory = ''
const testPid = 12_345
const testStartTime = '987654321'

function testUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

function procRoot(): string {
  return path.join(directory, 'proc')
}

function options(): { procRoot: string; currentUid: number } {
  return { procRoot: procRoot(), currentUid: testUid() }
}

async function writeLock(value: unknown, mode = 0o600): Promise<void> {
  await fs.writeFile(path.join(directory, 'console-core.lock'), `${JSON.stringify(value)}\n`, { mode })
}

async function validLock(): Promise<Record<string, unknown>> {
  return {
    pid: testPid,
    token: randomUUID(),
    processStartTime: testStartTime,
  }
}

describe('detached Core process identity', () => {
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-detached-identity-'))
    await fs.chmod(directory, 0o700)
    const processDirectory = path.join(procRoot(), String(testPid))
    await fs.mkdir(processDirectory, { recursive: true })
    const fields = ['S', ...Array.from({ length: 18 }, () => '0'), testStartTime, '0']
    await fs.writeFile(path.join(processDirectory, 'stat'), `${testPid} (test core) ${fields.join(' ')}\n`)
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('matches a private stable lock to the same-UID process and start time', async () => {
    await writeLock(await validLock())
    expect(await matchesDetachedCoreIdentity(directory, testPid, options())).toBe(process.platform === 'linux')
  })

  it('rejects malformed, mismatched, or non-private lock records', async () => {
    const record = await validLock()
    for (const invalid of [
      { ...record, pid: testPid + 1 },
      { ...record, token: 'not-a-random-token' },
      { ...record, processStartTime: '0' },
      { pid: testPid },
    ]) {
      await writeLock(invalid)
      expect(await matchesDetachedCoreIdentity(directory, testPid, options())).toBe(false)
    }

    await writeLock(record, 0o644)
    await fs.chmod(path.join(directory, 'console-core.lock'), 0o644)
    expect(await matchesDetachedCoreIdentity(directory, testPid, options())).toBe(false)
  })

  it('rejects a symlink even when its target contains an otherwise valid record', async () => {
    const target = path.join(directory, 'target.lock')
    await fs.writeFile(target, `${JSON.stringify(await validLock())}\n`, { mode: 0o600 })
    await fs.symlink(target, path.join(directory, 'console-core.lock'))
    expect(await matchesDetachedCoreIdentity(directory, testPid, options())).toBe(false)
  })

  it('rejects hard-linked locks and a non-private or symlinked user-data directory', async () => {
    const target = path.join(directory, 'target.lock')
    await fs.writeFile(target, `${JSON.stringify(await validLock())}\n`, { mode: 0o600 })
    await fs.link(target, path.join(directory, 'console-core.lock'))
    expect(await matchesDetachedCoreIdentity(directory, testPid, options())).toBe(false)

    await fs.rm(path.join(directory, 'console-core.lock'))
    await writeLock(await validLock())
    await fs.chmod(directory, 0o755)
    expect(await matchesDetachedCoreIdentity(directory, testPid, options())).toBe(false)

    await fs.chmod(directory, 0o700)
    const linkPath = `${directory}-link`
    await fs.symlink(directory, linkPath)
    try {
      expect(await matchesDetachedCoreIdentity(linkPath, testPid, options())).toBe(false)
    } finally {
      await fs.rm(linkPath, { force: true })
    }
  })

  it('rejects a missing lock and an uncertain PID', async () => {
    expect(await matchesDetachedCoreIdentity(directory, testPid, options())).toBe(false)
    expect(await matchesDetachedCoreIdentity(directory, -1, options())).toBe(false)
  })
})
