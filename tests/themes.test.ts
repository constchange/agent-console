import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../shared/types'
import { DEFAULT_THEME, THEMES } from '../src/lib/themes'

describe('appearance themes', () => {
  it('exposes every supported theme exactly once', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(THEME_IDS)
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length)
  })

  it('uses the requested navy, ivory, and gold system by default', () => {
    expect(DEFAULT_THEME.id).toBe('navy-gold')
    expect(DEFAULT_THEME.swatches).toContain('#0b2342')
    expect(DEFAULT_THEME.swatches).toContain('#c7a24b')
  })

  it('keeps every theme preview complete', () => {
    for (const theme of THEMES) {
      expect(theme.name.length).toBeGreaterThan(0)
      expect(theme.description.length).toBeGreaterThan(20)
      expect(theme.swatches).toHaveLength(4)
      for (const swatch of theme.swatches) expect(swatch).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})
