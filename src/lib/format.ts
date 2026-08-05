import type { AgentKind, AgentStatus } from '../../shared/types'

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

export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '—'
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0.0%'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

export function shortPath(value: string): string {
  if (!value) return 'Not set'
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 3) return value
  return `…/${parts.slice(-3).join('/')}`
}

export function timeLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
