import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { renderCoreServiceUnit } from '../../core/services/core-service-unit'
import { compareReleaseVersions } from '../../core/services/release-version'

const execFileAsync = promisify(execFile)
const SERVICE_NAME = 'agent-console-core.service'

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

export interface CoreServiceState {
  mode: 'systemd-user' | 'detached-fallback' | 'development'
  unitPath: string | null
  launchExecutable: string
}

function environmentDirectory(variable: string, fallback: string): string {
  const value = process.env[variable]
  return value && path.isAbsolute(value) ? value : fallback
}

async function durableReplace(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${process.pid}-${Date.now()}.tmp`
  try {
    await fs.copyFile(source, temporary)
    await fs.chmod(temporary, 0o700)
    const handle = await fs.open(temporary, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, destination)
    await syncDirectory(path.dirname(destination))
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function writeIfChanged(filePath: string, contents: string, mode: number): Promise<boolean> {
  const current = await fs.readFile(filePath, 'utf8').catch(() => null)
  if (current === contents) return false
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode, flag: 'wx' })
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

export class CoreServiceManager {
  private launchExecutable = process.execPath
  private launchPrefix: string[] = []
  private serviceState: CoreServiceState | null = null

  constructor(private readonly userDataPath: string) {}

  async installAndStart(): Promise<CoreServiceState> {
    await this.resolveLaunchTarget()
    // Hermetic integration checks opt into the detached path before this
    // method writes or starts any user-systemd unit.
    const forceDetached = process.env.AGENT_CONSOLE_FORCE_DETACHED_CORE === '1'
    if (!app.isPackaged || forceDetached) {
      this.spawnDetached()
      this.serviceState = {
        mode: app.isPackaged ? 'detached-fallback' : 'development',
        unitPath: null,
        launchExecutable: this.launchExecutable,
      }
      return this.serviceState
    }

    const configHome = environmentDirectory('XDG_CONFIG_HOME', path.join(os.homedir(), '.config'))
    const unitPath = path.join(configHome, 'systemd', 'user', SERVICE_NAME)
    const changed = await writeIfChanged(unitPath, renderCoreServiceUnit(this.launchExecutable, this.userDataPath), 0o600)
    try {
      if (changed) await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 5_000 })
      await execFileAsync('systemctl', ['--user', 'enable', '--now', SERVICE_NAME], { timeout: 8_000 })
      if (changed) await execFileAsync('systemctl', ['--user', 'restart', SERVICE_NAME], { timeout: 10_000 })
      this.serviceState = { mode: 'systemd-user', unitPath, launchExecutable: this.launchExecutable }
    } catch (error) {
      if (await this.systemdServiceIsActive()) {
        this.serviceState = { mode: 'systemd-user', unitPath, launchExecutable: this.launchExecutable }
        return this.serviceState
      }
      if (await this.userSystemdIsAvailable()) throw error
      this.spawnDetached()
      this.serviceState = { mode: 'detached-fallback', unitPath, launchExecutable: this.launchExecutable }
    }
    return this.serviceState
  }

  async restart(corePid?: number | null): Promise<void> {
    if (this.serviceState?.mode === 'systemd-user') {
      await execFileAsync('systemctl', ['--user', 'restart', SERVICE_NAME], { timeout: 10_000 })
      return
    }
    if (corePid && await this.matchesDetachedCore(corePid)) {
      process.kill(corePid, 'SIGTERM')
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && await this.matchesDetachedCore(corePid)) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (await this.matchesDetachedCore(corePid)) {
        throw new Error('The previous detached Console Core did not stop safely.')
      }
    }
    this.spawnDetached()
  }

  async ensureRunning(corePid?: number | null): Promise<void> {
    if (this.serviceState?.mode === 'systemd-user') {
      await execFileAsync('systemctl', ['--user', 'start', SERVICE_NAME], { timeout: 8_000 })
      return
    }
    if (corePid && await this.matchesDetachedCore(corePid)) return
    this.spawnDetached()
  }

  async stop(): Promise<void> {
    if (this.serviceState?.mode === 'systemd-user') {
      await execFileAsync('systemctl', ['--user', 'stop', SERVICE_NAME], { timeout: 10_000 }).catch(() => undefined)
    }
  }

  private async resolveLaunchTarget(): Promise<void> {
    this.launchExecutable = process.execPath
    this.launchPrefix = []
    if (!app.isPackaged) {
      this.launchPrefix = [app.getAppPath()]
      return
    }
    const appImage = process.env.APPIMAGE
    if (!appImage) return
    const dataHome = environmentDirectory('XDG_DATA_HOME', path.join(os.homedir(), '.local', 'share'))
    const installDirectory = path.join(dataHome, 'agent-console', 'app')
    const stablePath = path.join(installDirectory, 'Agent-Console.AppImage')
    const markerPath = path.join(installDirectory, 'version')
    const marker = await fs.readFile(markerPath, 'utf8').catch(() => '')
    const stableExists = await fs.stat(stablePath).then(() => true, () => false)
    const runningStableCopy = path.resolve(appImage) === path.resolve(stablePath)
    const installedVersion = marker.trim()
    const mayReplaceStable = !installedVersion || compareReleaseVersions(app.getVersion(), installedVersion) >= 0
    if (!stableExists || !runningStableCopy && mayReplaceStable && installedVersion !== app.getVersion()) {
      await durableReplace(appImage, stablePath)
      await writeIfChanged(markerPath, `${app.getVersion()}\n`, 0o600)
    } else if (runningStableCopy && installedVersion !== app.getVersion()) {
      await writeIfChanged(markerPath, `${app.getVersion()}\n`, 0o600)
    }
    this.launchExecutable = stablePath
  }

  private spawnDetached(): void {
    const integrationDiagnostics = process.env.AGENT_CONSOLE_FORCE_DETACHED_CORE === '1'
    const child = spawn(
      this.launchExecutable,
      [
        ...this.launchPrefix,
        '--console-core',
        `--console-core-user-data=${this.userDataPath}`,
        '--disable-gpu',
        ...(integrationDiagnostics ? ['--no-sandbox'] : []),
      ],
      {
        detached: true,
        stdio: integrationDiagnostics ? ['ignore', 'inherit', 'inherit'] : 'ignore',
        env: { ...process.env, AGENT_CONSOLE_CORE_FALLBACK: '1' },
      },
    )
    if (integrationDiagnostics) {
      child.on('error', (error) => console.error('Detached Console Core process failed to launch:', error))
      child.on('exit', (code, signal) => {
        if (code !== 0) console.error(`Detached Console Core exited with code ${String(code)} and signal ${String(signal)}.`)
      })
    }
    child.unref()
  }

  private async matchesDetachedCore(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid < 2) return false
    try {
      const stat = await fs.stat(`/proc/${pid}`)
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false
      const commandLine = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\u0000').filter(Boolean)
      return commandLine.includes('--console-core')
        && commandLine.includes(`--console-core-user-data=${this.userDataPath}`)
    } catch {
      return false
    }
  }

  private async systemdServiceIsActive(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'systemctl',
        ['--user', 'show', SERVICE_NAME, '--property=ActiveState', '--value'],
        { timeout: 3_000 },
      )
      return ['active', 'activating', 'reloading'].includes(stdout.trim())
    } catch {
      return false
    }
  }

  private async userSystemdIsAvailable(): Promise<boolean> {
    try {
      await execFileAsync('systemctl', ['--user', 'show-environment'], { timeout: 3_000 })
      return true
    } catch {
      return false
    }
  }
}
