import type { RemoteSafeSnapshot, RuntimeSnapshot } from '../shared/types'
import type { PersistedTask } from './services/task-ledger'

/**
 * Future network code may consume only this DTO, never RuntimeSnapshot or ConsoleState.
 * It intentionally omits commands, paths, PIDs, pane ids, logs, output and process args.
 */
export function createRemoteSafeSnapshot(
  snapshot: RuntimeSnapshot,
  tasks: PersistedTask[],
): RemoteSafeSnapshot {
  const taskByAgent = new Map(tasks.filter((task) => task.present).map((task) => [task.agentId, task]))
  return {
    capturedAt: snapshot.capturedAt,
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      projectId: agent.projectId,
      name: agent.name,
      emoji: agent.emoji,
      color: agent.color,
      kind: agent.kind,
      status: agent.status,
      updatedAt: agent.lastUpdated,
      taskId: taskByAgent.get(agent.id)?.id ?? null,
    })),
  }
}
