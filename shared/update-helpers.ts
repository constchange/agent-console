import type { InstallationKind } from './types'

export interface ReleaseNoteItem {
  version: string
  note: string | null
}

export function normalizeReleaseNotes(value: string | ReleaseNoteItem[] | null | undefined): string | null {
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? text.slice(0, 12_000) : null
  }

  if (!Array.isArray(value)) return null

  const text = value
    .map((item) => {
      const note = item.note?.trim()
      if (!note) return null
      return `v${item.version}\n${note}`
    })
    .filter((item): item is string => Boolean(item))
    .join('\n\n')
    .trim()

  return text ? text.slice(0, 12_000) : null
}

export function friendlyUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.toLowerCase()

  if (message.includes('401') || message.includes('403') || message.includes('authentication')) {
    return 'The update channel is private or unavailable. Your current version is unchanged.'
  }
  if (message.includes('404') || message.includes('latest-linux.yml') || message.includes('no published versions')) {
    return 'No published update channel was found yet. Your current version is unchanged.'
  }
  if (
    message.includes('enotfound') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('network') ||
    message.includes('timed out') ||
    message.includes('timeout')
  ) {
    return 'Could not reach the update server. Check your connection and try again.'
  }
  return 'The update could not be completed. Your current version is safe and unchanged.'
}

export function installationKindLabel(kind: InstallationKind): string {
  const labels: Record<InstallationKind, string> = {
    appimage: 'AppImage',
    deb: 'Linux deb',
    rpm: 'Linux rpm',
    pacman: 'Linux package',
    development: 'Development preview',
    unknown: 'Desktop package',
  }
  return labels[kind]
}
