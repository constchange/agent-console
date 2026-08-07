import { readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UiLanguage } from '../shared/locales'
import type { ConsoleSettings, CoreConnectionState, CoreHealth, UpdateState } from '../shared/types'
import { SettingsEditor } from '../src/components/Editors'
import { I18nProvider } from '../src/lib/i18n'

const settings: ConsoleSettings = {
  language: 'en',
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

function renderUpdates(state: UpdateState, language: UiLanguage = 'en', overrides: Partial<ConsoleSettings> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider language={language}>
      <SettingsEditor
        settings={{ ...settings, language, ...overrides }}
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
      />
    </I18nProvider>,
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
    expect(markup).toContain('aria-pressed="true">English</button>')
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

  it('renders the Chinese settings copy while preserving release content and technical versions', () => {
    const checkedAt = '2026-08-07T01:02:03.000Z'
    const markup = renderUpdates(updateState({
      phase: 'available',
      availableVersion: '0.4.1',
      releaseNotes: 'Keep this release note verbatim.',
      message: 'Agent Console v0.4.1 is available.',
      lastCheckedAt: checkedAt,
      canDownload: true,
    }), 'zh-CN')

    expect(markup).toContain('界面语言')
    expect(markup).toContain('简体中文')
    expect(markup).toContain('aria-pressed="true">简体中文</button>')
    expect(markup).toContain('本机 Console Core')
    expect(markup).toContain('新版本 0.4.1 可用')
    expect(markup).toContain(new Date(checkedAt).toLocaleString('zh-CN'))
    expect(markup).toContain('Keep this release note verbatim.')
    expect(markup).toContain('v0.4.1')
  })

  it('keeps 50px settings reachable and wires language choices through preview before Save', async () => {
    const markup = renderUpdates(updateState({}), 'en', { fontSizePx: 50 })
    const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
    const source = await readFile(new URL('../src/components/Editors.tsx', import.meta.url), 'utf8')

    expect(markup).toContain('value="50"')
    expect(markup).toContain('Save Settings')
    expect(styles).toMatch(/#root\s*\{[^}]*overflow:\s*auto/s)
    expect(source).toContain("onClick={() => update({ ...draft, language: 'zh-CN' })}")
    expect(source).toContain("onClick={() => update({ ...draft, language: 'en' })}")
    expect(source).toContain('onSave(draft)')
  })
})
