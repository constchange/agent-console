import type { AgentConsoleApi } from '../shared/types'

declare global {
  interface Window {
    agentConsole?: AgentConsoleApi
  }
}

export {}
