/**
 * Types that may cross the authenticated Gateway boundary.
 *
 * Keep this module independent from the desktop/runtime types: those contain
 * commands, paths, process identifiers, tmux names and raw output.
 */

export type RemoteTaskAdapter = 'codex-structured' | 'tmux-compatibility' | 'process-monitor'

export type RemoteTaskStatus =
  | 'starting'
  | 'running'
  | 'needs_input'
  | 'needs_approval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'recovering'
  | 'unknown'

export type RemoteAgentStatus = 'working' | 'needs_attention' | 'problem' | 'completed' | 'offline'

export type RemoteApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

export interface RemoteCapabilities {
  view: boolean
  viewEvents: boolean
  message: boolean
  approve: boolean
  interrupt: boolean
}

export interface RemoteTaskView {
  id: string
  agentId: string
  adapter: RemoteTaskAdapter
  status: RemoteTaskStatus
  summary: string
  createdAt: string
  updatedAt: string
  version: number
  active: boolean
}

export interface RemoteAgentView {
  id: string
  projectId: string
  name: string
  emoji: string
  color: string
  status: RemoteAgentStatus
  updatedAt: string
  task: RemoteTaskView | null
  capabilities: RemoteCapabilities
}

export interface RemoteApprovalView {
  id: string
  taskId: string
  status: RemoteApprovalStatus
  promptSummary: string
  decisionSummary: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export interface RemoteEvent {
  seq: number
  taskId: string | null
  taskVersion: number | null
  type: string
  status: string
  summary: string
  createdAt: string
}

export interface RemoteEventCursor {
  streamId: string
  oldestAvailableSeq: number
  latestSeq: number
}

export interface RemoteDashboard {
  capturedAt: string
  agents: RemoteAgentView[]
  cursor: RemoteEventCursor
}

export interface RemoteAgentDetail {
  agent: RemoteAgentView
  approvals: RemoteApprovalView[]
  cursor: RemoteEventCursor
}

export interface RemoteEventsParams {
  afterSeq: number
  limit?: number
  taskId?: string
  streamId?: string
}

export interface RemoteEventsResult extends RemoteEventCursor {
  events: RemoteEvent[]
  resetRequired: boolean
}

export interface RemoteWriteEnvelope {
  requestId: string
  actor: {
    userId: string
    deviceId: string
  }
  issuedAt: string
  expiresAt: string
  taskId: string
  expectedTaskVersion: number
}

export interface RemoteTaskMessageParams extends RemoteWriteEnvelope {
  message: string
}

export type RemoteTaskInterruptParams = RemoteWriteEnvelope

export interface RemoteApprovalDecisionParams extends RemoteWriteEnvelope {
  approvalId: string
  decision: 'approve' | 'reject'
}

export type RemoteActionOutcome = 'completed' | 'failed' | 'unknown'

export interface RemoteActionResult {
  ok: boolean
  requestId: string
  taskId: string
  taskVersion: number
  action: string
  message: string
  duplicate: boolean
  outcome: RemoteActionOutcome
}

export interface RemoteHealth {
  online: true
  appVersion: string
  protocolVersion: number
  startedAt: string
}
