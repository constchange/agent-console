import type { RuntimeAgent, RuntimeSnapshot } from '../shared/types'
import type {
  RemoteAgentDetail,
  RemoteAgentStatus,
  RemoteAgentView,
  RemoteApprovalView,
  RemoteCapabilities,
  RemoteDashboard,
  RemoteEventCursor,
  RemoteTaskView,
} from '../shared/remote-protocol'
import type { PersistedApproval, PersistedTask } from './services/task-ledger'

export type RemoteCapabilityResolver = (task: PersistedTask | null) => RemoteCapabilities

function cleanDisplay(value: string, fallback: string, max: number): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean || fallback).slice(0, max)
}

export function remoteTaskView(task: PersistedTask): RemoteTaskView {
  return {
    id: task.id,
    agentId: task.agentId,
    adapter: task.adapter,
    status: task.status,
    summary: task.summary,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: task.version,
    active: task.active,
  }
}

function remoteAgentStatus(agent: RuntimeAgent, task: PersistedTask | null): RemoteAgentStatus {
  if (task?.status === 'needs_input' || task?.status === 'needs_approval') return 'needs_attention'
  if (task?.status === 'failed' || agent.status === 'error') return 'problem'
  if (task?.status === 'completed' || agent.status === 'finished') return 'completed'
  if (!task?.active && ['offline', 'stopped'].includes(agent.status)) return 'offline'
  return 'working'
}

function agentView(
  agent: RuntimeAgent,
  task: PersistedTask | null,
  capabilities: RemoteCapabilityResolver,
): RemoteAgentView {
  return {
    id: agent.id,
    projectId: agent.projectId,
    name: cleanDisplay(agent.name, 'Agent', 100),
    emoji: cleanDisplay(agent.emoji, '●', 12),
    color: /^#[a-f0-9]{6}$/i.test(agent.color) ? agent.color : '#8b98a9',
    status: remoteAgentStatus(agent, task),
    updatedAt: agent.lastUpdated,
    task: task ? remoteTaskView(task) : null,
    capabilities: capabilities(task),
  }
}

export function createRemoteDashboard(
  snapshot: RuntimeSnapshot,
  tasks: PersistedTask[],
  cursor: RemoteEventCursor,
  capabilities: RemoteCapabilityResolver,
): RemoteDashboard {
  const activeByAgent = new Map(
    tasks.filter((task) => task.active).map((task) => [task.agentId, task]),
  )
  return {
    capturedAt: snapshot.capturedAt,
    agents: snapshot.agents.map((agent) => agentView(
      agent,
      activeByAgent.get(agent.id) ?? null,
      capabilities,
    )),
    cursor,
  }
}

export function createRemoteAgentDetail(
  snapshot: RuntimeSnapshot,
  tasks: PersistedTask[],
  approvals: PersistedApproval[],
  cursor: RemoteEventCursor,
  capabilities: RemoteCapabilityResolver,
  agentId: string,
): RemoteAgentDetail | null {
  const agent = snapshot.agents.find((item) => item.id === agentId)
  if (!agent) return null
  const task = tasks.find((item) => item.agentId === agentId && item.active) ?? null
  return {
    agent: agentView(agent, task, capabilities),
    approvals: task
      ? approvals.filter((approval) => approval.taskId === task.id).map(remoteApprovalView)
      : [],
    cursor,
  }
}

export function remoteApprovalView(approval: PersistedApproval): RemoteApprovalView {
  return {
    id: approval.id,
    taskId: approval.taskId,
    status: approval.status,
    promptSummary: approval.promptSummary,
    decisionSummary: approval.decisionSummary,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    expiresAt: approval.expiresAt,
  }
}
