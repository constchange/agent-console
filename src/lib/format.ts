import type { AgentKind, AgentStatus } from '../../shared/types'
import { createI18n, type I18n } from './i18n'

export const STATUS_META: Record<AgentStatus, { label: string; color: string; glow: string }> = {
  running: { label: 'Running', color: '#3ddc97', glow: 'rgba(61, 220, 151, .18)' },
  thinking: { label: 'Thinking', color: '#5aa9ff', glow: 'rgba(90, 169, 255, .18)' },
  waiting: { label: 'Waiting', color: '#f2bb54', glow: 'rgba(242, 187, 84, .18)' },
  idle: { label: 'Idle', color: '#8b98aa', glow: 'rgba(139, 152, 170, .12)' },
  finished: { label: 'Finished', color: '#56c8c0', glow: 'rgba(86, 200, 192, .16)' },
  error: { label: 'Error', color: '#ff6577', glow: 'rgba(255, 101, 119, .18)' },
  stopped: { label: 'Stopped', color: '#586272', glow: 'rgba(88, 98, 114, .12)' },
  offline: { label: 'Offline', color: '#4b5563', glow: 'rgba(75, 85, 99, .10)' },
}

export const KIND_LABEL: Record<AgentKind, string> = {
  codex: 'Codex CLI',
  terminal: 'Terminal',
  backend: 'Backend',
  worker: 'Worker',
  python: 'Python',
  node: 'Node',
  docker: 'Docker',
  tmux: 'tmux',
  process: 'Process',
}

const ENGLISH_I18N = createI18n('en')

export function formatDuration(seconds: number, i18n: I18n = ENGLISH_I18N): string {
  return i18n.formatDuration(seconds)
}

export function formatPercent(value: number, i18n: I18n = ENGLISH_I18N): string {
  return i18n.formatPercent(value)
}

export function shortPath(value: string, i18n: I18n = ENGLISH_I18N): string {
  if (!value) return i18n.t('Not set')
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 3) return value
  return `…/${parts.slice(-3).join('/')}`
}

export function timeLabel(value: string, i18n: I18n = ENGLISH_I18N): string {
  return i18n.formatTime(value)
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

export function uniqueId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${uuid}`
}
