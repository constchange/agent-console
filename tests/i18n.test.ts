import { describe, expect, it } from 'vitest'
import { languageFromLocale } from '../shared/locales'
import { createI18n, hasChineseTranslation } from '../src/lib/i18n'

describe('interface language', () => {
  it('maps every Chinese system locale to Simplified Chinese and otherwise uses English', () => {
    expect(languageFromLocale('zh_CN.UTF-8')).toBe('zh-CN')
    expect(languageFromLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(languageFromLocale('zh-TW')).toBe('zh-CN')
    expect(languageFromLocale('en_US.UTF-8')).toBe('en')
    expect(languageFromLocale('ja-JP')).toBe('en')
  })

  it('translates fixed chrome, interpolated text, and known runtime messages', () => {
    const chinese = createI18n('zh-CN')
    expect(chinese.t('All Projects')).toBe('全部项目')
    expect(chinese.t('{{count}} Agents', { count: 3 })).toBe('3 个 Agent')
    expect(chinese.message('Agent Console v0.5.1 is available.')).toBe('Agent Console v0.5.1 可用。')
    expect(chinese.message('You already have the latest version, v0.5.1.')).toBe('当前已是最新版本 v0.5.1。')
    expect(chinese.message('Review terminal focused')).toBe('Review 的终端已聚焦')
    expect(chinese.message('Core request config.commit timed out after 15000 ms.')).toBe('Core 请求 config.commit 在 15000 毫秒后超时。')

    const english = createI18n('en')
    expect(english.t('{{count}} Agents', { count: 3 })).toBe('3 Agents')
    expect(english.message('Agent Console v0.5.1 is available.')).toBe('Agent Console v0.5.1 is available.')
  })

  it('formats time spans for the selected language without changing raw content', () => {
    const chinese = createI18n('zh-CN')
    expect(chinese.formatDuration(3_725)).toBe('1小时 2分钟')
    expect(chinese.formatPercent(7.42)).toBe('7.4%')
    expect(chinese.message('用户自定义输出')).toBe('用户自定义输出')
  })

  it('contains translations for the core language controls', () => {
    for (const source of ['Interface language', 'Simplified Chinese', 'English', 'Save Settings']) {
      expect(hasChineseTranslation(source), source).toBe(true)
    }
  })

  it('contains translations for fixed Remote runtime, authentication, and Doctor messages', () => {
    const remoteMessages = [
      'Sign in to enable remote control.',
      'Authentication has not started.',
      'The operating-system keyring is unavailable.',
      'Authentication will retry when the network is available.',
      'Finish password recovery before enabling remote control.',
      'Check your email to confirm the new account.',
      'Choose a new password before remote control can resume.',
      'Signed in securely.',
      'Confirm your email before enabling remote control.',
      'Remote authorization, the local Gateway, the tunnel, and the public HTTPS health check are ready.',
      'Local Gateway service is not active.',
      'HTTPS tunnel service is not active.',
      'Local Gateway service is disabled.',
      'HTTPS tunnel service is disabled.',
      'The public HTTPS endpoint reached this Gateway and its private Core health bridge.',
      'The public HTTPS health check did not reach a healthy Gateway and Core.',
      'Public reachability must be verified outside the credential-holding Core.',
      'Email address is invalid.',
      'Password is invalid.',
      'nickname is invalid.',
      'No signup email is awaiting verification.',
      'Mobile Remote is not armed in the private runtime configuration.',
      'Enable Mobile Remote before pairing a device.',
      'Agent not found.',
      'Pair and synchronize at least one active device first.',
      'The pairing has not been claimed with a confirmation code.',
      'Remote settings phase is invalid.',
      'Gateway PID is invalid.',
      'Remote device platform is invalid.',
      'Remote device state is invalid.',
      'Pairing stage is invalid.',
      'Pairing QR image is invalid.',
      'Remote check ID is invalid.',
      'Remote check state is invalid.',
      'The Core connection closed before the request completed.',
      'Connect to Core before sending a request.',
      'Agent Console is closing; no new changes were accepted.',
      'Agent Console is restarting to install the update; no new changes were accepted.',
      'Console Core reconnected before this change could be saved. The desktop must resynchronize first.',
      'Invalid Console Core state revision.',
      'Console Core reconnected before the desktop finished resynchronizing.',
      'Console Core changed again before the desktop finished resynchronizing.',
      'The saved configuration changed in another client.',
      'The local Core version is incompatible with this desktop version.',
      'Nickname is invalid.',
      'Workstation name is invalid.',
      'Invalid Agent ID',
    ]

    for (const source of remoteMessages) expect(hasChineseTranslation(source), source).toBe(true)

    const chinese = createI18n('zh-CN')
    expect(chinese.message(remoteMessages[9])).toContain('Gateway')
    expect(chinese.message(remoteMessages[10])).toBe('本机 Gateway 服务未运行。')
    expect(chinese.message(remoteMessages[14])).toContain('私有 Core')
  })
})
