import path from 'node:path'

export interface CorePaths {
  runtimeDirectory: string
  socketPath: string
  lockPath: string
  databasePath: string
}

/**
 * Keeps the private IPC endpoint in the per-login runtime directory when one
 * exists. The user-data fallback is still local to the current Linux user and
 * is protected by the server's ownership and permission checks.
 */
export function resolveCorePaths(
  userDataPath: string,
  runtimeRoot = process.env.XDG_RUNTIME_DIR,
): CorePaths {
  const runtimeDirectory = runtimeRoot && path.isAbsolute(runtimeRoot)
    ? path.join(runtimeRoot, 'agent-console')
    : path.join(userDataPath, 'runtime')
  return {
    runtimeDirectory,
    socketPath: path.join(runtimeDirectory, 'core.sock'),
    lockPath: path.join(userDataPath, 'console-core.lock'),
    databasePath: path.join(userDataPath, 'console-core.sqlite'),
  }
}
