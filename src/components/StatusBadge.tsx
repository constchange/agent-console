import type { AgentStatus } from '../../shared/types'
import { STATUS_META } from '../lib/format'
import { useI18n } from '../lib/i18n'

interface StatusBadgeProps {
  status: AgentStatus
  compact?: boolean
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  const meta = STATUS_META[status]
  const { t } = useI18n()
  const label = t(meta.label)
  return (
    <span
      className={`status-badge ${compact ? 'status-badge--compact' : ''}`}
      style={{ '--status-color': meta.color, '--status-glow': meta.glow } as React.CSSProperties}
      title={label}
    >
      <span className="status-dot" />
      {!compact && <span>{label}</span>}
    </span>
  )
}
