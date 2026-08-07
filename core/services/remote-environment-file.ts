import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_REMOTE_ENVIRONMENT_BYTES = 64 * 1024

/**
 * Returns the conventional remote.env only when systemd can safely read it.
 * Missing and insecure files are both fail-closed: the Core starts without
 * Remote credentials so the desktop can still expose repair instructions.
 */
export async function privateRemoteEnvironmentFile(configHome: string): Promise<string | null> {
  if (!path.isAbsolute(configHome)) return null
  const candidate = path.join(configHome, 'agent-console', 'remote', 'remote.env')
  let stat
  try {
    stat = await fs.lstat(candidate)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null
  if ((stat.mode & 0o777) !== 0o600) return null
  if (stat.size <= 0 || stat.size > MAX_REMOTE_ENVIRONMENT_BYTES) return null
  for (const directory of [
    path.join(configHome, 'agent-console'),
    path.join(configHome, 'agent-console', 'remote'),
  ]) {
    let directoryStat
    try {
      directoryStat = await fs.lstat(directory)
    } catch {
      return null
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
    if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) return null
    if ((directoryStat.mode & 0o022) !== 0) return null
  }
  return candidate
}
