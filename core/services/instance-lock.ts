import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

const INCOMPLETE_LOCK_GRACE_MS = 30_000

interface LockRecord {
  pid: number
  token: string | null
  processStartTime: string | null
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as { pid?: unknown; token?: unknown; processStartTime?: unknown }
    if (!Number.isInteger(value.pid) || Number(value.pid) < 1) return null
    return {
      pid: Number(value.pid),
      token: typeof value.token === 'string' && value.token.length >= 16 ? value.token : null,
      processStartTime: typeof value.processStartTime === 'string'
        ? value.processStartTime
        : null,
    }
  } catch {
    const legacyPid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(legacyPid) && legacyPid > 0
      ? { pid: legacyPid, token: null, processStartTime: null }
      : null
  }
}

async function readProcessStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 0) return null
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] ?? null
  } catch {
    return null
  }
}

async function processOwnsCoreLock(record: LockRecord): Promise<boolean> {
  if (!processAlive(record.pid)) return false
  if (record.processStartTime) {
    const currentStartTime = await readProcessStartTime(record.pid)
    if (currentStartTime) return currentStartTime === record.processStartTime
    // If procfs cannot prove that a live PID was reused, preserving the lock is
    // safer than starting a second writer. This also covers restricted procfs.
    return true
  }
  // New-format locks carry an unguessable token. On platforms where procfs is
  // unavailable we cannot verify process start time, so a live PID must be
  // treated conservatively as the owner. Legacy PID-only locks still use the
  // command-line check below when it is available.
  if (record.token) return true
  try {
    const commandLine = await fs.readFile(`/proc/${record.pid}/cmdline`, 'utf8')
    return commandLine.split('\u0000').includes('--console-core')
  } catch {
    // If procfs is unavailable, do not risk replacing a lock held by a live
    // process. A stale lock whose PID is no longer alive is handled above.
    return true
  }
}

export class CoreInstanceLock {
  private handle: FileHandle | null = null
  private readonly token = randomUUID()
  private device: number | null = null
  private inode: number | null = null

  constructor(private readonly lockPath: string) {}

  async acquire(): Promise<void> {
    const directory = path.dirname(this.lockPath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600)
        let createdIdentity: { dev: number; ino: number } | null = null
        try {
          const stat = await handle.stat()
          createdIdentity = { dev: stat.dev, ino: stat.ino }
          const processStartTime = await readProcessStartTime(process.pid)
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: this.token, processStartTime })}\n`, 'utf8')
          await handle.sync()
          this.handle = handle
          this.device = stat.dev
          this.inode = stat.ino
          return
        } catch (error) {
          await handle.close().catch(() => undefined)
          await this.removePathIfIdentityMatches(createdIdentity)
          throw error
        }
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
        const stat = await fs.lstat(this.lockPath).catch((readError) => {
          if (errorCode(readError) === 'ENOENT') return null
          throw readError
        })
        if (!stat) continue
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Console Core lock path must be a regular file: ${this.lockPath}`)
        }
        const record = parseLockRecord(await fs.readFile(this.lockPath, 'utf8').catch(() => ''))
        if (record && await processOwnsCoreLock(record)) {
          throw new Error(`Console Core is already running as process ${record.pid}.`)
        }
        if (!record && Date.now() - stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
          throw new Error('Another Console Core process is still acquiring its instance lock.')
        }
        await this.removePathIfIdentityMatches(stat)
      }
    }
    throw new Error('Console Core could not acquire its instance lock.')
  }

  async release(): Promise<void> {
    const handle = this.handle
    const expectedDevice = this.device
    const expectedInode = this.inode
    this.handle = null
    this.device = null
    this.inode = null
    try {
      const stat = await fs.lstat(this.lockPath).catch(() => null)
      if (!stat || stat.dev !== expectedDevice || stat.ino !== expectedInode) return
      const record = parseLockRecord(await fs.readFile(this.lockPath, 'utf8').catch(() => ''))
      if (!record || record.token !== this.token || record.pid !== process.pid) return
      const latest = await fs.lstat(this.lockPath).catch(() => null)
      if (latest && latest.dev === expectedDevice && latest.ino === expectedInode) await fs.unlink(this.lockPath)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async removePathIfIdentityMatches(expected: { dev: number; ino: number } | null): Promise<void> {
    if (!expected) return
    const current = await fs.lstat(this.lockPath).catch(() => null)
    if (current && current.dev === expected.dev && current.ino === expected.ino) {
      await fs.unlink(this.lockPath).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error
      })
    }
  }
}
