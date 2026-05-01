import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { Timer } from '../../../shared/types/adf-v02.types'

const InputSchema = z.object({})

/**
 * List all scheduled timers for this agent.
 */
export class GetTimersTool implements Tool {
  readonly name = 'sys_list_timers'
  readonly description = 'List all scheduled timers. Returns timer IDs, schedule type, next fire time, run count, and payloads.'
  readonly inputSchema = InputSchema
  readonly category = 'timer' as const

  async execute(_input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    try {
      const timers = workspace.getTimers()

      if (timers.length === 0) {
        return {
          content: '(no timers scheduled)',
          isError: false
        }
      }

      const now = Date.now()
      const lines = timers.map((t) => this.formatTimer(t, now))

      return {
        content: `Scheduled timers:\n\n${lines.join('\n\n')}`,
        isError: false
      }
    } catch (error) {
      return {
        content: `Failed to get timers: ${String(error)}`,
        isError: true
      }
    }
  }

  private formatTimer(t: Timer, now: number): string {
    const delayMs = t.next_wake_at - now
    const status = delayMs <= 0 ? ' [expired]' : ` (in ${this.formatDelay(delayMs)})`

    let badge: string
    switch (t.schedule.mode) {
      case 'once':
        badge = '[once]'
        break
      case 'interval':
        badge = `[interval: ${this.formatDelay(t.schedule.every_ms)}]`
        break
      case 'cron':
        badge = `[cron: ${t.schedule.cron}]`
        break
    }

    const lockBadge = t.locked ? ' [locked]' : ''

    let line = `ID: ${t.id} ${badge}${lockBadge}\n   Next fire: ${new Date(t.next_wake_at).toISOString()}${status}`

    if (t.schedule.mode !== 'once') {
      line += `\n   Runs: ${t.run_count}`
    }

    if (t.last_fired_at) {
      line += `\n   Last fired: ${new Date(t.last_fired_at).toISOString()}`
    }

    const payloadStr = t.payload ? `\n   Payload: ${t.payload}` : ''
    line += payloadStr

    // End conditions
    if (t.schedule.mode === 'interval' || t.schedule.mode === 'cron') {
      if (t.schedule.end_at) {
        line += `\n   Ends at: ${new Date(t.schedule.end_at).toISOString()}`
      }
      if (t.schedule.max_runs) {
        line += `\n   Max runs: ${t.schedule.max_runs}`
      }
    }

    return line
  }

  private formatDelay(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`
    if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`
    return `${(ms / 86400000).toFixed(1)}d`
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
