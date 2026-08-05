import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConsoleSettings, UpdateState } from '../shared/types'
import { SettingsEditor } from '../src/components/Editors'

const settings: ConsoleSettings = {
  defaultTerminal: 'auto',
  scanIntervalMs: 2_500,
  compactMode: true,
  fontSizePx: 25,
  theme: 'navy-gold',
}

function updateState(overrides: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    currentVersion: '0.3.1',
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
  it('shows a download action and release notes when an update is available', () => {
    const markup = renderUpdates(updateState({
      phase: 'available',
      availableVersion: '0.3.2',
      releaseNotes: 'Improves terminal discovery.',
      message: 'Agent Console v0.3.2 is available.',
      canCheck: true,
      canDownload: true,
    }))

    expect(markup).toContain('Version 0.3.2 is available')
    expect(markup).toContain('Download update')
    expect(markup).toContain('Improves terminal discovery.')
  })

  it('shows progress while downloading and restart only after verification', () => {
    const downloading = renderUpdates(updateState({
      phase: 'downloading',
      availableVersion: '0.3.2',
      progress: { percent: 42.5, transferred: 42_500_000, total: 100_000_000, bytesPerSecond: 2_000_000 },
      canCheck: false,
    }))
    expect(downloading).toContain('42.5%')
    expect(downloading).toContain('Downloading…')
    expect(downloading).not.toContain('Restart and update')

    const downloaded = renderUpdates(updateState({
      phase: 'downloaded',
      availableVersion: '0.3.2',
      canCheck: false,
      canInstall: true,
    }))
    expect(downloaded).toContain('Restart and update')
  })
})
