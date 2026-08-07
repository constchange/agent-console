import { createHash } from 'node:crypto'
import { requireOpaqueId, requireUuid } from '../../shared/remote-validation'

export function grantOutboxEntityId(deviceId: string, agentId: string): string {
  const device = requireUuid(deviceId, 'Device ID')
  const agent = requireOpaqueId(agentId, 'Agent ID')
  return `grant-${createHash('sha256').update(`${device}\n${agent}`, 'utf8').digest('hex')}`
}
