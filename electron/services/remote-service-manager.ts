import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  REMOTE_GATEWAY_SERVICE_NAME,
  REMOTE_TUNNEL_SERVICE_NAME,
  renderGatewayServiceUnit,
  renderTunnelServiceUnit,
} from '../../core/services/remote-service-unit'

const execFileAsync = promisify(execFile)
const PRIVATE_FILE_MAX_BYTES = 1024 * 1024
const TRUSTED_RUNTIME_RESOURCE_MAX_BYTES = 1024 * 1024

function environmentDirectory(variable: string, fallback: string): string {
  const value = process.env[variable]
  if (!value) return fallback
  if (!path.isAbsolute(value)
    || path.normalize(value) !== value
    || Buffer.byteLength(value, 'utf8') > 4_096
    || /[\0\r\n]/.test(value)) {
    throw new Error(`${variable} must be one normalized absolute directory.`)
  }
  return value
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(code)) throw error
  } finally {
    await handle.close()
  }
}

async function writeIfChanged(filePath: string, contents: string): Promise<boolean> {
  const current = await fs.readFile(filePath, 'utf8').catch(() => null)
  if (current === contents) return false
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await fs.open(temporary, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, filePath)
    await syncDirectory(path.dirname(filePath))
    return true
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function sameFile(first: { dev: number | bigint; ino: number | bigint }, second: { dev: number | bigint; ino: number | bigint }): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

function currentUserOwns(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

async function ensurePrivateRuntimeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !currentUserOwns(stat.uid)) {
    throw new Error(`Remote runtime directory must be one real directory owned by the current user: ${directory}`)
  }
  await fs.chmod(directory, 0o700)
}

async function readTrustedPackagedResource(filePath: string, label: string): Promise<Buffer> {
  const parent = await fs.lstat(path.dirname(filePath))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o022) {
    throw new Error(`${label} parent must be a non-writable packaged directory.`)
  }
  const allowedOwner = (uid: number) => uid === 0 || currentUserOwns(uid)
  if (!allowedOwner(parent.uid)) throw new Error(`${label} parent has an unexpected owner.`)

  const before = await fs.lstat(filePath)
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || !allowedOwner(before.uid)
    || before.mode & 0o022
    || before.size <= 0
    || before.size > TRUSTED_RUNTIME_RESOURCE_MAX_BYTES) {
    throw new Error(`${label} is not one trusted packaged regular file.`)
  }

  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()
      || opened.nlink !== 1
      || !sameFile(before, opened)
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while it was being opened.`)
    }
    const contents = await handle.readFile()
    const after = await handle.stat()
    if (!sameFile(opened, after)
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || contents.length !== opened.size) {
      throw new Error(`${label} changed while it was being read.`)
    }
    return contents
  } finally {
    await handle.close()
  }
}

function shellQuote(value: string): string {
  if (/\0|\r|\n/.test(value)) throw new Error('Remote launcher values must be one line.')
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function writeManagedRuntimeFile(filePath: string, contents: Buffer | string, mode: number): Promise<boolean> {
  await ensurePrivateRuntimeDirectory(path.dirname(filePath))
  const existing = await fs.lstat(filePath).catch((error) => {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isFile()
    || existing.isSymbolicLink()
    || existing.nlink !== 1
    || !currentUserOwns(existing.uid))) {
    throw new Error(`Refusing to replace an unsafe Remote runtime file: ${filePath}`)
  }
  if (existing && existing.size <= TRUSTED_RUNTIME_RESOURCE_MAX_BYTES) {
    const current = await fs.readFile(filePath)
    const desired = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8')
    if (current.equals(desired)) {
      await fs.chmod(filePath, mode)
      return false
    }
  }

  const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, contents, { mode, flag: 'wx' })
    const handle = await fs.open(temporary, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, filePath)
    await fs.chmod(filePath, mode)
    await syncDirectory(path.dirname(filePath))
    return true
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function assertOwnedRegularFile(filePath: string, label: string, privateMode: boolean): Promise<void> {
  const stat = await fs.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be one regular file, not a link.`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`)
  }
  if (privateMode && (stat.mode & 0o077) !== 0) throw new Error(`${label} must use mode 0600 or stricter.`)
  if (!privateMode && (stat.mode & 0o022) !== 0) throw new Error(`${label} must not be writable by group or other users.`)
  if (stat.size <= 0 || stat.size > PRIVATE_FILE_MAX_BYTES) throw new Error(`${label} has an invalid size.`)
}

async function assertTrustedRuntimeExecutable(filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new Error('Remote service executable must be one normalized absolute path.')
  }
  const [parent, stat] = await Promise.all([
    fs.lstat(path.dirname(filePath)),
    fs.lstat(filePath),
  ])
  const allowedOwner = (uid: number) => uid === 0 || currentUserOwns(uid)
  if (!parent.isDirectory()
    || parent.isSymbolicLink()
    || !allowedOwner(parent.uid)
    || (parent.mode & 0o022) !== 0) {
    throw new Error('Remote service executable parent is not a trusted runtime directory.')
  }
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || !allowedOwner(stat.uid)
    || (stat.mode & 0o022) !== 0
    || (stat.mode & 0o111) === 0
    || stat.size <= 0) {
    throw new Error('Remote service executable is not one trusted executable regular file.')
  }
}

export async function assertPrivateRegularFile(filePath: string, label: string): Promise<void> {
  return assertOwnedRegularFile(filePath, label, true)
}

export interface RemoteServiceManagerOptions {
  appExecutable: string
  launcher: string
  packagedRemoteDirectory: string
  remoteEnvironmentFile: string
  gatewaySocketPath: string
  desktopCoreSocketPath: string
  sshKeyPath: string
  sshPublicKeyPath: string
  knownHostsPath: string
  applicationReadOnlyPath?: string | null
  systemdUserDirectory?: string
}

export interface RemoteServiceStatus {
  gateway: 'active' | 'inactive' | 'failed' | 'unknown'
  tunnel: 'active' | 'inactive' | 'failed' | 'unknown'
  gatewayUnitPath: string
  tunnelUnitPath: string
}

export class RemoteServiceManager {
  readonly gatewayUnitPath: string
  readonly tunnelUnitPath: string

  constructor(private readonly options: RemoteServiceManagerOptions) {
    const configHome = environmentDirectory('XDG_CONFIG_HOME', path.join(os.homedir(), '.config'))
    const userUnitDirectory = options.systemdUserDirectory ?? path.join(configHome, 'systemd', 'user')
    this.gatewayUnitPath = path.join(userUnitDirectory, REMOTE_GATEWAY_SERVICE_NAME)
    this.tunnelUnitPath = path.join(userUnitDirectory, REMOTE_TUNNEL_SERVICE_NAME)
  }

  async prepare(): Promise<void> {
    await this.installRuntimeResources()
    await this.installUnits()
  }

  private async installRuntimeResources(): Promise<void> {
    const packagedRoot = path.resolve(this.options.packagedRemoteDirectory)
    if (!path.isAbsolute(this.options.packagedRemoteDirectory)
      || path.normalize(this.options.packagedRemoteDirectory) !== this.options.packagedRemoteDirectory) {
      throw new Error('Packaged Remote resource directory must be one normalized absolute path.')
    }
    const launcher = path.resolve(this.options.launcher)
    if (!path.isAbsolute(this.options.launcher) || path.normalize(this.options.launcher) !== this.options.launcher) {
      throw new Error('Remote service launcher must be one normalized absolute path.')
    }
    await assertTrustedRuntimeExecutable(this.options.appExecutable)
    const runtimeRoot = path.dirname(path.dirname(launcher))
    const installedCli = path.join(runtimeRoot, 'cli', 'agent-console-remote.mjs')
    const packagedCli = path.join(packagedRoot, 'cli', 'agent-console-remote.mjs')
    const cliContents = await readTrustedPackagedResource(packagedCli, 'Packaged Remote CLI')
    await ensurePrivateRuntimeDirectory(runtimeRoot)
    // Install the CLI first. A crash before the launcher rename leaves the old
    // launcher usable; a completed launcher always names a durable CLI path.
    await writeManagedRuntimeFile(installedCli, cliContents, 0o700)
    const launcherContents = `#!/bin/sh\nset -eu\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(this.options.appExecutable)} ${shellQuote(installedCli)} "$@"\n`
    await writeManagedRuntimeFile(launcher, launcherContents, 0o700)
  }

  async installUnits(): Promise<{ changed: boolean }> {
    await Promise.all([
      assertPrivateRegularFile(this.options.remoteEnvironmentFile, 'Remote environment file'),
      assertPrivateRegularFile(this.options.sshKeyPath, 'Dedicated SSH private key'),
      assertOwnedRegularFile(this.options.sshPublicKeyPath, 'Dedicated SSH public key', false),
      assertPrivateRegularFile(this.options.knownHostsPath, 'Dedicated SSH known_hosts file'),
    ])
    const gatewayUnit = renderGatewayServiceUnit({
      executable: this.options.appExecutable,
      remoteEnvironmentFile: this.options.remoteEnvironmentFile,
      gatewaySocketPath: this.options.gatewaySocketPath,
      desktopCoreSocketPath: this.options.desktopCoreSocketPath,
      applicationReadOnlyPath: this.options.applicationReadOnlyPath,
    })
    const tunnelUnit = renderTunnelServiceUnit({
      launcher: this.options.launcher,
      remoteEnvironmentFile: this.options.remoteEnvironmentFile,
      sshKeyPath: this.options.sshKeyPath,
      sshPublicKeyPath: this.options.sshPublicKeyPath,
      knownHostsPath: this.options.knownHostsPath,
      applicationReadOnlyPath: this.options.applicationReadOnlyPath,
    })
    const [gatewayChanged, tunnelChanged] = await Promise.all([
      writeIfChanged(this.gatewayUnitPath, gatewayUnit),
      writeIfChanged(this.tunnelUnitPath, tunnelUnit),
    ])
    if (gatewayChanged || tunnelChanged) await this.systemctl('daemon-reload')
    return { changed: gatewayChanged || tunnelChanged }
  }

  async enable(): Promise<RemoteServiceStatus> {
    await this.prepare()
    try {
      await this.systemctl('enable', '--now', REMOTE_GATEWAY_SERVICE_NAME)
      await this.systemctl('enable', '--now', REMOTE_TUNNEL_SERVICE_NAME)
    } catch (error) {
      await this.systemctl('disable', '--now', REMOTE_TUNNEL_SERVICE_NAME).catch(() => undefined)
      await this.systemctl('disable', '--now', REMOTE_GATEWAY_SERVICE_NAME).catch(() => undefined)
      throw error
    }
    return this.status()
  }

  async disable(): Promise<RemoteServiceStatus> {
    const failures: unknown[] = []
    // Stop the public route first. Still attempt the Gateway stop if the tunnel
    // command fails, but never hide either failure from the desktop controller.
    await this.systemctl('disable', '--now', REMOTE_TUNNEL_SERVICE_NAME).catch((error) => failures.push(error))
    await this.systemctl('disable', '--now', REMOTE_GATEWAY_SERVICE_NAME).catch((error) => failures.push(error))
    const status = await this.status()
    if (failures.length > 0) throw new AggregateError(failures, 'One or more Remote services could not be stopped.')
    return status
  }

  async restartGateway(): Promise<RemoteServiceStatus> {
    await this.systemctl('restart', REMOTE_GATEWAY_SERVICE_NAME)
    return this.status()
  }

  async status(): Promise<RemoteServiceStatus> {
    const [gateway, tunnel] = await Promise.all([
      this.serviceState(REMOTE_GATEWAY_SERVICE_NAME),
      this.serviceState(REMOTE_TUNNEL_SERVICE_NAME),
    ])
    return { gateway, tunnel, gatewayUnitPath: this.gatewayUnitPath, tunnelUnitPath: this.tunnelUnitPath }
  }

  async uninstall(): Promise<void> {
    await this.disable()
    await Promise.all([
      fs.rm(this.gatewayUnitPath, { force: true }),
      fs.rm(this.tunnelUnitPath, { force: true }),
    ])
    await this.systemctl('daemon-reload')
    await this.systemctl('reset-failed', REMOTE_GATEWAY_SERVICE_NAME, REMOTE_TUNNEL_SERVICE_NAME).catch(() => undefined)
  }

  private async serviceState(serviceName: string): Promise<RemoteServiceStatus['gateway']> {
    try {
      const { stdout } = await this.systemctl('show', serviceName, '--property=ActiveState', '--value')
      const value = stdout.trim()
      if (value === 'active' || value === 'activating' || value === 'reloading') return 'active'
      if (value === 'failed') return 'failed'
      return 'inactive'
    } catch {
      return 'unknown'
    }
  }

  private async systemctl(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('systemctl', ['--user', ...args], { timeout: 15_000, maxBuffer: 1024 * 1024 })
  }
}
