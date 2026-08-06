import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreInstanceLock } from '../core/services/instance-lock'

const directories: string[] = []

async function lockFixture(): Promise<{ directory: string; lockPath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-lock-'))
  directories.push(directory)
  return { directory, lockPath: path.join(directory, 'core.lock') }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('CoreInstanceLock', () => {
  it('never removes a fresh incomplete lock from another process that is still starting', async () => {
    const { lockPath } = await lockFixture()
    await fs.writeFile(lockPath, '', { mode: 0o600 })
    const lock = new CoreInstanceLock(lockPath)
    await expect(lock.acquire()).rejects.toThrow('still acquiring')
    await expect(fs.stat(lockPath)).resolves.toBeTruthy()
  })

  it('allows only one owner and transfers ownership after a verified release', async () => {
    const { lockPath } = await lockFixture()
    const first = new CoreInstanceLock(lockPath)
    const second = new CoreInstanceLock(lockPath)
    await first.acquire()
    await expect(second.acquire()).rejects.toThrow('already running')
    await first.release()
    await second.acquire()
    await second.release()
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete a replacement lock that no longer belongs to it', async () => {
    const { lockPath } = await lockFixture()
    const lock = new CoreInstanceLock(lockPath)
    await lock.acquire()
    await fs.unlink(lockPath)
    await fs.writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: 'replacement-token-0001' })}\n`, { mode: 0o600 })
    await lock.release()
    expect(await fs.readFile(lockPath, 'utf8')).toContain('replacement-token-0001')
  })
})
