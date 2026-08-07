export const UI_LANGUAGES = ['en', 'zh-CN'] as const

export type UiLanguage = typeof UI_LANGUAGES[number]

export function languageFromLocale(locale: string | null | undefined): UiLanguage {
  const normalized = locale?.trim().replaceAll('_', '-').toLowerCase() ?? ''
  return normalized === 'zh' || normalized.startsWith('zh-') ? 'zh-CN' : 'en'
}
