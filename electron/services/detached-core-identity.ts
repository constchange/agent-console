import { promises as fs } from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'

interface ProcessIdentity {
  uid: number
  startTime: string
}

interface CoreLockIdentity {
  pid: number
  token: string
  processStartTime: string
}

export interface DetachedCoreIdentityOptions {
  procRoot?: string
  currentUid?: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_LOCK_BYTES = 4_096

function processStartTime(rawStat: string): string | null {
  const commandEnd = rawStat.lastIndexOf(')')
  if (commandEnd < 0) return null
  const value = rawStat.slice(commandEnd + 2).trim().split(/\s+/)[19]
  return value && /^\d+$/.test(value) ? value : null
}

async function readStableProcessIdentity(pid: number, procRoot: string): Promise<ProcessIdentity | null> {
  try {
    const processPath = path.join(procRoot, String(pid))
    const statPath = `${processPath}/stat`
    const [initialDirectory, initialRawStat] = await Promise.all([
      fs.stat(processPath),
      fs.readFile(statPath, 'utf8'),
    ])
    const initialStartTime = processStartTime(initialRawStat)
    if (!initialDirectory.isDirectory() || !initialStartTime) return null

    const [finalDirectory, finalRawStat] = await Promise.all([
      fs.stat(processPath),
      fs.readFile(statPath, 'utf8'),
    ])
    const finalStartTime = processStartTime(finalRawStat)
    if (
      !finalDirectory.isDirectory()
      || !finalStartTime
      || finalStartTime !== initialStartTime
      || finalDirectory.uid !== initialDirectory.uid
    ) return null
    return { uid: finalDirectory.uid, startTime: finalStartTime }
  } catch {
    return null
  }
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function privateRegularFile(stat: Stats, uid: number): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === uid
    && stat.nlink === 1
    && (stat.mode & 0o077) === 0
    && stat.size > 0
    && stat.size <= MAX_LOCK_BYTES
}

async function readPrivateDirectoryIdentity(
  directoryPath: string,
  uid: number,
): Promise<{ dev: number; ino: number } | null> {
  try {
    const initial = await fs.lstat(directoryPath)
    if (
      !initial.isDirectory()
      || initial.isSymbolicLink()
      || initial.uid !== uid
      || (initial.mode & 0o077) !== 0
    ) return null
    const final = await fs.lstat(directoryPath)
    if (
      !final.isDirectory()
      || final.isSymbolicLink()
      || final.uid !== uid
      || (final.mode & 0o077) !== 0
      || !sameFileIdentity(initial, final)
    ) return null
    return { dev: final.dev, ino: final.ino }
  } catch {
    return null
  }
}

function parseCoreLock(raw: string): CoreLockIdentity | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (!Number.isInteger(record.pid) || Number(record.pid) < 2) return null
    if (typeof record.token !== 'string' || !UUID_PATTERN.test(record.token)) return null
    if (typeof record.processStartTime !== 'string' || !/^\d+$/.test(record.processStartTime)) return null
    return {
      pid: Number(record.pid),
      token: record.token,
      processStartTime: record.processStartTime,
    }
  } catch {
    return null
  }
}

async function readStableCoreLock(lockPath: string, uid: number): Promise<CoreLockIdentity | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    const initialPathStat = await fs.lstat(lockPath)
    if (!privateRegularFile(initialPathStat, uid)) return null
    handle = await fs.open(lockPath, 'r')
    const initialHandleStat = await handle.stat()
    if (!privateRegularFile(initialHandleStat, uid) || !sameFileIdentity(initialPathStat, initialHandleStat)) return null

    const raw = await handle.readFile('utf8')
    const [finalHandleStat, finalPathStat] = await Promise.all([handle.stat(), fs.lstat(lockPath)])
    if (
      !privateRegularFile(finalHandleStat, uid)
      || !privateRegularFile(finalPathStat, uid)
      || !sameFileIdentity(initialHandleStat, finalHandleStat)
      || !sameFileIdentity(finalHandleStat, finalPathStat)
      || finalHandleStat.size !== initialHandleStat.size
      || finalHandleStat.mtimeMs !== initialHandleStat.mtimeMs
      || finalHandleStat.ctimeMs !== initialHandleStat.ctimeMs
    ) return null
    return parseCoreLock(raw)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Verifies a detached Core without trusting Electron's mutable Linux process
 * title. Any missing or unstable evidence returns false so callers never send
 * a signal to an uncertain PID.
 */
export async function matchesDetachedCoreIdentity(
  userDataPath: string,
  pid: number,
  options: DetachedCoreIdentityOptions = {},
): Promise<boolean> {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return false
  if (!path.isAbsolute(userDataPath) || !Number.isInteger(pid) || pid < 2) return false

  const uid = options.currentUid ?? process.getuid()
  if (!Number.isInteger(uid) || uid < 0) return false
  const procRoot = options.procRoot ?? '/proc'
  if (!path.isAbsolute(procRoot)) return false
  const initialUserData = await readPrivateDirectoryIdentity(userDataPath, uid)
  if (!initialUserData) return false
  const initialProcess = await readStableProcessIdentity(pid, procRoot)
  if (!initialProcess || initialProcess.uid !== uid) return false

  const lock = await readStableCoreLock(path.join(userDataPath, 'console-core.lock'), uid)
  if (!lock || lock.pid !== pid || lock.processStartTime !== initialProcess.startTime) return false

  const [finalProcess, finalUserData] = await Promise.all([
    readStableProcessIdentity(pid, procRoot),
    readPrivateDirectoryIdentity(userDataPath, uid),
  ])
  if (!finalProcess || !finalUserData) return false
  return sameFileIdentity(initialUserData, finalUserData)
    && finalProcess.uid === uid
    && finalProcess.uid === initialProcess.uid
    && finalProcess.startTime === initialProcess.startTime
}
