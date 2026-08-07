import type { AgentKind, AgentStatus, ProcessInfo } from '../../shared/types'

const TERMINAL_COMMANDS = [
  'gnome-terminal-server',
  'gnome-terminal',
  'kitty',
  'ghostty',
  'konsole',
  'xfce4-terminal',
  'xterm',
]

export function classifyProcess(command: string, args: string): AgentKind | null {
  const comm = command.toLowerCase()
  const line = `${command} ${args}`.toLowerCase()

  if (line.includes('agent-console') || line.includes('agent console')) return null
  if (TERMINAL_COMMANDS.some((terminal) => comm === terminal || comm.endsWith(`/${terminal}`))) {
    return 'terminal'
  }
  if (comm === 'codex' || /(^|[\s/])codex([\s]|$)/.test(line)) return 'codex'
  if (/\b(celery|rq worker|bullmq|sidekiq|worker\.py|worker\.js)\b/.test(line)) return 'worker'
  if (/\b(uvicorn|gunicorn|hypercorn|flask run|manage\.py runserver|nest start|next dev|vite|npm run (dev|start|serve))\b/.test(line)) {
    return 'backend'
  }
  if (comm === 'docker' || comm === 'dockerd' || comm === 'containerd') return 'docker'
  if (comm === 'tmux' || line.startsWith('tmux ')) return 'tmux'
  if (/^python([0-9.]*)?$/.test(comm)) return 'python'
  if (comm === 'node' || comm === 'nodejs' || comm === 'bun' || comm === 'deno') return 'node'
  return null
}

export function inferStatus(
  processInfo: ProcessInfo | null,
  lastOutput: string,
  kind: AgentKind,
  statusOverride?: AgentStatus | null,
  activityAt = 0,
): AgentStatus {
  if (statusOverride) return statusOverride
  if (!processInfo) return 'offline'

  const tail = lastOutput.trim().split('\n').slice(-8).join('\n').toLowerCase()
  const errorTail = tail.replace(/(?:没有|并无|未|不存在)(?:发生|发现)?(?:任何)?(?:致命|严重)?错误/g, '')
  if (processInfo.processState.includes('Z')) return 'error'
  if (
    /\b(fatal|panic|uncaught exception|unhandled rejection)\b|traceback \(most recent call last\)|致命错误|严重错误|未捕获异常|未处理(?:的)?(?:异常|拒绝)|(?:任务|执行|构建|测试)失败|(?:共\s*)?[1-9]\d*\s*(?:个|项|例)?\s*(?:测试|用例)?失败|失败\s*[1-9]\d*\s*(?:个|项|例)?|发生错误|连接被拒绝/.test(errorTail)
  ) {
    return 'error'
  }
  if (
    /waiting (for|on) (user|approval|input)|approve this|confirmation required|press enter|do you want to|would you like me to|\[y\/n\]|\(y\/n\)|等待(?:用户|你|您的)?(?:输入|确认|批准|审批|授权)|请(?:输入|确认|批准|审批|授权)|需要(?:输入|确认|批准|审批|授权)|是否(?:继续|执行|允许)|按(?:下)?回车/.test(
      tail,
    )
  ) {
    return 'waiting'
  }
  if (/\b(thinking|reasoning|analyzing|working|exploring|searching|generating)\b|正在(?:思考|推理|分析|工作|探索|搜索|查找|生成|检查|读取|修改|构建|测试)/.test(tail)) {
    return 'thinking'
  }
  const negatesCompletion = /(?:尚未|还未|并未|并非|不是|未能|没有)(?:做到|达到)?全部(?:检查|测试)?通过/.test(tail)
  if (!negatesCompletion && /\b(task )?(finished|completed successfully)\b|(?:任务|工作|操作|构建|测试)(?:已完成|成功完成)|全部(?:检查|测试)?通过/.test(tail)) return 'finished'

  const secondsSinceActivity = activityAt > 0 ? Date.now() / 1000 - activityAt : Number.POSITIVE_INFINITY
  if (kind === 'codex' && secondsSinceActivity < 20) return 'thinking'
  if (processInfo.processState.startsWith('R') || processInfo.cpu >= 1) return 'running'
  if (kind === 'backend' || kind === 'worker' || kind === 'docker') return 'running'
  return 'idle'
}

export function suggestedPresentation(kind: AgentKind): { emoji: string; color: string } {
  switch (kind) {
    case 'codex':
      return { emoji: '◆', color: '#55a6ff' }
    case 'backend':
      return { emoji: '⬡', color: '#a478ff' }
    case 'worker':
      return { emoji: '⚙', color: '#f6b94b' }
    case 'python':
      return { emoji: 'Py', color: '#4fb8a8' }
    case 'node':
      return { emoji: 'JS', color: '#7abf66' }
    case 'docker':
      return { emoji: '▣', color: '#3b9eff' }
    case 'tmux':
      return { emoji: '▤', color: '#54c79b' }
    case 'terminal':
      return { emoji: '>_', color: '#8b98a9' }
    default:
      return { emoji: '●', color: '#8b98a9' }
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
