/**
 * Environment variable resolution for the shell.
 *
 * System vars: $AGENT_NAME, $AGENT_DID, $AGENT_STATE, $PWD
 * Event context: $EVENT_TYPE, $MSG_ID, $MSG_FROM, $MSG_CHANNEL, $TIMER_ID, $TIMER_PAYLOAD, etc.
 * Identity: falls through to adf_identity for secrets
 */

import type { AdfWorkspace } from '../../../adf/adf-workspace'
import type { AgentConfig } from '@shared/types/adf-v02.types'
import type { AdfEventDispatch } from '@shared/types/adf-event.types'
import type {
  InboxEventData, TimerEventData, TaskCreateEventData, TaskCompleteEventData,
  FileChangeEventData, ToolCallEventData, LlmCallEventData,
} from '@shared/types/adf-event.types'

export class EnvironmentResolver {
  private systemVars: Record<string, string>
  private eventVars: Record<string, string> = {}
  private exportedVars: Record<string, string> = {}
  private workspace: AdfWorkspace

  constructor(config: AgentConfig, workspace: AdfWorkspace) {
    this.workspace = workspace
    this.systemVars = {
      AGENT_NAME: config.name ?? '',
      AGENT_STATE: config.state ?? 'active',
      PWD: '/',
    }
    // AGENT_DID is resolved lazily from identity
  }

  /** Set event context variables from AdfEventDispatch */
  setTriggerContext(dispatch: AdfEventDispatch): void {
    this.eventVars = {}
    const { event } = dispatch
    this.eventVars.EVENT_TYPE = event.type

    if (event.type === 'inbox' && event.data) {
      const d = event.data as InboxEventData
      this.eventVars.MSG_ID = d.message.id
      this.eventVars.MSG_FROM = d.message.from
      if (d.message.source) this.eventVars.MSG_CHANNEL = d.message.source
    } else if (event.type === 'timer' && event.data) {
      const d = event.data as TimerEventData
      this.eventVars.TIMER_ID = String(d.timer.id)
      if (d.timer.payload) this.eventVars.TIMER_PAYLOAD = d.timer.payload
    } else if (event.type === 'task_create' && event.data) {
      const d = event.data as TaskCreateEventData
      this.eventVars.TASK_ID = d.task.id
      this.eventVars.TASK_TOOL = d.task.tool
      this.eventVars.TASK_STATUS = d.task.status
    } else if (event.type === 'task_complete' && event.data) {
      const d = event.data as TaskCompleteEventData
      this.eventVars.TASK_ID = d.task.id
      this.eventVars.TASK_STATUS = d.task.status
    } else if (event.type === 'tool_call' && event.data) {
      const d = event.data as ToolCallEventData
      this.eventVars.TASK_ID = '' // tool_call has no task ID on ToolCallEventData
    } else if (event.type === 'file_change' && event.data) {
      const d = event.data as FileChangeEventData
      this.eventVars.CHANGED_PATH = d.path
    } else if (event.type === 'llm_call' && event.data) {
      const d = event.data as LlmCallEventData
      this.eventVars.LLM_PROVIDER = d.provider
      this.eventVars.LLM_MODEL = d.model
      this.eventVars.LLM_SOURCE = d.source
      this.eventVars.LLM_INPUT_TOKENS = String(d.input_tokens)
      this.eventVars.LLM_OUTPUT_TOKENS = String(d.output_tokens)
      this.eventVars.LLM_DURATION_MS = String(d.duration_ms)
      this.eventVars.LLM_STOP_REASON = d.stop_reason
      if (d.cost_usd !== undefined) this.eventVars.LLM_COST_USD = String(d.cost_usd)
    }
  }

  /** Set a variable via export KEY=VALUE */
  export(key: string, value: string): void {
    this.exportedVars[key] = value
  }

  /** Resolve a variable name to its value */
  resolve(name: string): string {
    // 1. Exported vars (session scope)
    if (name in this.exportedVars) return this.exportedVars[name]

    // 2. Event context vars
    if (name in this.eventVars) return this.eventVars[name]

    // 3. System vars
    if (name in this.systemVars) return this.systemVars[name]

    // 4. AGENT_DID special case
    if (name === 'AGENT_DID') {
      try {
        return this.workspace.getIdentity('did') ?? ''
      } catch { return '' }
    }

    // 5. Fall through to adf_identity
    try {
      const val = this.workspace.getIdentity(name.toLowerCase())
      if (val) return val
    } catch { /* identity not found */ }

    return ''
  }

  /** List all environment variables (for `env` command). Redacts sensitive values. */
  listAll(): Array<{ key: string; value: string; source: string }> {
    const result: Array<{ key: string; value: string; source: string }> = []

    // System vars
    for (const [k, v] of Object.entries(this.systemVars)) {
      result.push({ key: k, value: v, source: 'system' })
    }

    // Event vars
    for (const [k, v] of Object.entries(this.eventVars)) {
      result.push({ key: k, value: v, source: 'event' })
    }

    // Exported vars
    for (const [k, v] of Object.entries(this.exportedVars)) {
      result.push({ key: k, value: v, source: 'export' })
    }

    return result
  }
}
