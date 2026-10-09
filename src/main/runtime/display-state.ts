import type { AgentState } from '../../shared/types/ipc.types'

/** Map executor internal states to display states for the UI. */
export function toDisplayState(executorState: string): AgentState {
  switch (executorState) {
    case 'thinking':
    case 'tool_use':
      return 'active'
    case 'idle':
      return 'idle'
    case 'awaiting_approval':
    case 'awaiting_ask':
    case 'suspended':
      return 'suspended'
    case 'error':
      return 'error'
    case 'stopped':
      return 'off'
    // ADF display states (pass-through from sys_set_state target)
    case 'active':
    case 'hibernate':
    case 'off':
      return executorState as AgentState
    default:
      return 'off'
  }
}
