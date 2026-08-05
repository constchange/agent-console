import type { AgentStatus } from '../../shared/types'
import { STATUS_META } from '../lib/format'

interface StatusBadgeProps {
  status: AgentStatus
  compact?: boolean
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  const meta = STATUS_META[status]
  return (
    <span
      className={`status-badge ${compact ? 'status-badge--compact' : ''}`}
      style={{ '--status-color': meta.color, '--status-glow': meta.glow } as React.CSSProperties}
      title={meta.label}
    >
      <span className="status-dot" />
      {!compact && <span>{meta.label}</span>}
    </span>
  )
}
