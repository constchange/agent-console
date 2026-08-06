import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConsoleSettings, CoreConnectionState, CoreHealth, UpdateState } from '../shared/types'
import { SettingsEditor } from '../src/components/Editors'

const settings: ConsoleSettings = {
  defaultTerminal: 'auto',
  scanIntervalMs: 2_500,
  compactMode: true,
  fontSizePx: 25,
  theme: 'navy-gold',
}

const coreHealth: CoreHealth = {
  appVersion: '0.4.0',
  protocolVersion: 1,
  startedAt: '2026-08-06T00:00:00.000Z',
  pid: 4_200,
  transport: 'unix',
  stateRevision: 'revision-1',
  structuredCodex: 'deferred',
  tcpListening: false,
}

const coreConnection: CoreConnectionState = {
  phase: 'connected',
  message: 'Console Core is connected over a local Unix socket.',
  coreVersion: '0.4.0',
  protocolVersion: 1,
}

function updateState(overrides: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    currentVersion: '0.4.0',
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    lastCheckedAt: null,
    message: 'Ready to check.',
    installationKind: 'appimage',
    canCheck: true,
    canDownload: false,
    canInstall: false,
    ...overrides,
  }
}

function renderUpdates(state: UpdateState): string {
  return renderToStaticMarkup(
    <SettingsEditor
      settings={settings}
      availableTerminals={[]}
      updateState={state}
      coreHealth={coreHealth}
      coreConnection={coreConnection}
      onSave={vi.fn()}
      onPreview={vi.fn()}
      onClose={vi.fn()}
      onCheckForUpdates={vi.fn()}
      onDownloadUpdate={vi.fn()}
      onInstallUpdate={vi.fn()}
      onOpenReleasesPage={vi.fn()}
    />,
  )
}

describe('application update settings', () => {
  it('shows the local-only Console Core boundary', () => {
    const markup = renderUpdates(updateState({}))

    expect(markup).toContain('Local Console Core')
    expect(markup).toContain('Connected')
    expect(markup).toContain('Unix socket')
    expect(markup).toContain('No TCP listener')
    expect(markup).toContain('restricted to your Linux user')
  })

  it('shows a download action and release notes when an update is available', () => {
    const markup = renderUpdates(updateState({
      phase: 'available',
      availableVersion: '0.4.1',
      releaseNotes: 'Improves terminal discovery.',
      message: 'Agent Console v0.4.1 is available.',
      canCheck: true,
      canDownload: true,
    }))

    expect(markup).toContain('Version 0.4.1 is available')
    expect(markup).toContain('Download update')
    expect(markup).toContain('Improves terminal discovery.')
  })

  it('shows progress while downloading and restart only after verification', () => {
    const downloading = renderUpdates(updateState({
      phase: 'downloading',
      availableVersion: '0.4.1',
      progress: { percent: 42.5, transferred: 42_500_000, total: 100_000_000, bytesPerSecond: 2_000_000 },
      canCheck: false,
    }))
    expect(downloading).toContain('42.5%')
    expect(downloading).toContain('Downloading…')
    expect(downloading).not.toContain('Restart and update')

    const downloaded = renderUpdates(updateState({
      phase: 'downloaded',
      availableVersion: '0.4.1',
      canCheck: false,
      canInstall: true,
    }))
    expect(downloaded).toContain('Restart and update')
  })
})
