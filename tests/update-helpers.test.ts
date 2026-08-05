import { describe, expect, it } from 'vitest'
import { friendlyUpdateError, installationKindLabel, normalizeReleaseNotes } from '../shared/update-helpers'

describe('update helpers', () => {
  it('combines a full changelog into readable plain text', () => {
    expect(normalizeReleaseNotes([
      { version: '0.3.0', note: 'Adds one-click application updates.' },
      { version: '0.2.2', note: 'Improves editor focus stability.' },
    ])).toBe('v0.3.0\nAdds one-click application updates.\n\nv0.2.2\nImproves editor focus stability.')
  })

  it('does not expose raw network errors to the interface', () => {
    expect(friendlyUpdateError(new Error('GET latest-linux.yml returned 404'))).toContain('No published update channel')
    expect(friendlyUpdateError(new Error('connect ENOTFOUND api.github.com'))).toContain('Could not reach')
    expect(friendlyUpdateError(new Error('403 token=should-not-appear'))).not.toContain('token=')
  })

  it('uses friendly package names', () => {
    expect(installationKindLabel('appimage')).toBe('AppImage')
    expect(installationKindLabel('deb')).toBe('Linux deb')
  })
})
