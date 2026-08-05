import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { ActionResult, InstallationKind, UpdateState } from '../../shared/types'
import { friendlyUpdateError, normalizeReleaseNotes } from '../../shared/update-helpers'

type StateListener = (state: UpdateState) => void

const AUTOMATIC_CHECK_DELAY_MS = 15_000
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

function detectInstallationKind(): InstallationKind {
  if (!app.isPackaged) return 'development'
  if (process.env.APPIMAGE) return 'appimage'

  try {
    const packageType = readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim().toLowerCase()
    if (packageType === 'deb' || packageType === 'rpm' || packageType === 'pacman') return packageType
  } catch {
    // AppImage packages do not need the package-type marker. Unknown builds remain checkable.
  }

  return 'unknown'
}

function updateInfoPatch(info: UpdateInfo) {
  return {
    availableVersion: info.version,
    releaseName: info.releaseName?.trim() || null,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    releaseDate: info.releaseDate || null,
  }
}

function normalizedProgress(info: ProgressInfo) {
  return {
    percent: Math.min(100, Math.max(0, Math.round(info.percent * 10) / 10)),
    bytesPerSecond: Math.max(0, Math.round(info.bytesPerSecond)),
    transferred: Math.max(0, Math.round(info.transferred)),
    total: Math.max(0, Math.round(info.total)),
  }
}

export class UpdateManager {
  private state: UpdateState
  private readonly listeners = new Set<StateListener>()
  private initialTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private checkPromise: Promise<UpdateState> | null = null
  private downloadPromise: Promise<UpdateState> | null = null

  constructor() {
    const installationKind = detectInstallationKind()
    const enabled = app.isPackaged
    this.state = {
      phase: enabled ? 'idle' : 'disabled',
      currentVersion: app.getVersion(),
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      progress: null,
      lastCheckedAt: null,
      message: enabled
        ? 'Agent Console can check the stable release channel for updates.'
        : 'Update checks are available in packaged AppImage and deb builds.',
      installationKind,
      canCheck: enabled,
      canDownload: false,
      canInstall: false,
    }

    if (enabled) this.configureUpdater()
  }

  get current(): UpdateState {
    return structuredClone(this.state)
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (!app.isPackaged || this.initialTimer || this.intervalTimer) return

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null
      void this.check(false)
    }, AUTOMATIC_CHECK_DELAY_MS)
    this.initialTimer.unref()

    this.intervalTimer = setInterval(() => void this.check(false), AUTOMATIC_CHECK_INTERVAL_MS)
    this.intervalTimer.unref()
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.initialTimer = null
    this.intervalTimer = null
  }

  async check(manual = true): Promise<UpdateState> {
    if (!app.isPackaged) return this.current
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') return this.current
    if (this.checkPromise) return this.checkPromise

    this.checkPromise = this.performCheck(manual).finally(() => {
      this.checkPromise = null
    })
    return this.checkPromise
  }

  async download(): Promise<UpdateState> {
    if (this.state.phase !== 'available') return this.current
    if (this.downloadPromise) return this.downloadPromise

    this.setState({
      phase: 'downloading',
      progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
      message: `Downloading Agent Console v${this.state.availableVersion ?? ''}…`,
    })

    this.downloadPromise = autoUpdater.downloadUpdate()
      .then(() => {
        if (this.state.phase === 'downloading') {
          this.setState({
            phase: 'downloaded',
            progress: { ...(this.state.progress ?? { bytesPerSecond: 0, transferred: 0, total: 0 }), percent: 100 },
            message: 'The update is ready. Restart Agent Console to finish installing it.',
          })
        }
        return this.current
      })
      .catch((error) => {
        console.error('Agent Console update download failed', error)
        this.setState({ phase: 'error', message: friendlyUpdateError(error), progress: null })
        return this.current
      })
      .finally(() => {
        this.downloadPromise = null
      })

    return this.downloadPromise
  }

  install(): ActionResult {
    if (this.state.phase !== 'downloaded') {
      return { ok: false, action: 'not-ready', message: 'Download the update before installing it.' }
    }

    setTimeout(() => autoUpdater.quitAndInstall(false, true), 250).unref()
    return { ok: true, action: 'installing', message: 'Agent Console will restart and finish the update.' }
  }

  private configureUpdater(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.autoRunAppAfterInstall = true
    autoUpdater.allowPrerelease = false
    autoUpdater.fullChangelog = true

    autoUpdater.on('checking-for-update', () => {
      this.setState({ phase: 'checking', message: 'Checking the stable release channel…' })
    })
    autoUpdater.on('update-available', (info) => {
      this.setState({
        phase: 'available',
        ...updateInfoPatch(info),
        progress: null,
        message: `Agent Console v${info.version} is available.`,
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.setState({
        phase: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        progress: null,
        message: `You already have the latest version, v${app.getVersion()}.`,
      })
    })
    autoUpdater.on('download-progress', (info) => {
      const progress = normalizedProgress(info)
      this.setState({
        phase: 'downloading',
        progress,
        message: `Downloading v${this.state.availableVersion ?? ''} — ${progress.percent.toFixed(1)}%`,
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.setState({
        phase: 'downloaded',
        ...updateInfoPatch(info),
        progress: { ...(this.state.progress ?? { bytesPerSecond: 0, transferred: 0, total: 0 }), percent: 100 },
        message: 'The update is ready. Restart Agent Console to finish installing it.',
      })
    })
    autoUpdater.on('error', (error) => {
      console.error('Agent Console updater failed', error)
      this.setState({ phase: 'error', message: friendlyUpdateError(error), progress: null })
    })
  }

  private async performCheck(_manual: boolean): Promise<UpdateState> {
    this.setState({
      phase: 'checking',
      progress: null,
      lastCheckedAt: new Date().toISOString(),
      message: 'Checking the stable release channel…',
    })

    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        this.setState({
          phase: 'error',
          message: 'The updater is not available for this package. Your current version is unchanged.',
        })
      } else if (this.state.phase === 'checking') {
        this.setState(result.isUpdateAvailable
          ? {
              phase: 'available',
              ...updateInfoPatch(result.updateInfo),
              message: `Agent Console v${result.updateInfo.version} is available.`,
            }
          : {
              phase: 'up-to-date',
              message: `You already have the latest version, v${app.getVersion()}.`,
            })
      }
    } catch (error) {
      console.error('Agent Console update check failed', error)
      if (this.state.phase !== 'error') this.setState({ phase: 'error', message: friendlyUpdateError(error), progress: null })
    }

    return this.current
  }

  private setState(patch: Partial<UpdateState>): void {
    const next = { ...this.state, ...patch }
    next.canCheck = app.isPackaged && !['checking', 'downloading', 'downloaded'].includes(next.phase)
    next.canDownload = next.phase === 'available'
    next.canInstall = next.phase === 'downloaded'
    this.state = next
    for (const listener of this.listeners) listener(this.current)
  }
}
