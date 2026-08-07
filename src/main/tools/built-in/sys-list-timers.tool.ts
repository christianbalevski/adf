import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { Timer } from '../../../shared/types/adf-v02.types'

const InputSchema = z.object({
  include_expired: z.boolean().optional().describe(
    'Also list expired (completed) timers. Completed timers are kept as history instead of deleted. Default: false — only active timers.'
  )
})

/**
 * List scheduled timers for this agent.
 */
export class GetTimersTool implements Tool {
  readonly name = 'sys_list_timers'
  readonly description = 'List scheduled timers. Returns timer IDs, schedule type, next fire time, run count, and payloads. Completed timers are kept with an expired flag; pass include_expired: true to see them.'
  readonly inputSchema = InputSchema
  readonly category = 'timer' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { include_expired } = (input ?? {}) as z.infer<typeof InputSchema>
    try {
      const all = workspace.getTimers()
      const active = all.filter((t) => !t.expired)
      const expired = all.filter((t) => t.expired)

      if (active.length === 0 && (!include_expired || expired.length === 0)) {
        return {
          content: include_expired
            ? '(no timers scheduled, no expired timers)'
            : `(no timers scheduled)${expired.length > 0 ? ` — ${expired.length} expired timer${expired.length !== 1 ? 's' : ''} kept as history; pass include_expired: true to list them` : ''}`,
          isError: false
        }
      }

      const now = Date.now()
      const sections: string[] = []
      if (active.length > 0) {
        sections.push(`Scheduled timers:\n\n${active.map((t) => this.formatTimer(t, now)).join('\n\n')}`)
      } else {
        sections.push('(no active timers scheduled)')
      }
      if (include_expired && expired.length > 0) {
        sections.push(`Expired timers (completed, kept as history):\n\n${expired.map((t) => this.formatTimer(t, now)).join('\n\n')}`)
      } else if (!include_expired && expired.length > 0) {
        sections.push(`(${expired.length} expired timer${expired.length !== 1 ? 's' : ''} not shown — pass include_expired: true to list them)`)
      }

      return {
        content: sections.join('\n\n'),
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

    let line: string
    if (t.expired) {
      const completedAt = t.last_fired_at ?? t.next_wake_at
      line = `ID: ${t.id} ${badge}${lockBadge} [expired]\n   Completed: ${new Date(completedAt).toISOString()} (${this.formatDelay(now - completedAt)} ago)`
      if (t.run_count > 0) line += `\n   Total runs: ${t.run_count}`
    } else {
      const delayMs = t.next_wake_at - now
      const status = delayMs <= 0 ? ' [due]' : ` (in ${this.formatDelay(delayMs)})`
      line = `ID: ${t.id} ${badge}${lockBadge}\n   Next fire: ${new Date(t.next_wake_at).toISOString()}${status}`
      if (t.schedule.mode !== 'once') {
        line += `\n   Runs: ${t.run_count}`
      }
      if (t.last_fired_at) {
        line += `\n   Last fired: ${new Date(t.last_fired_at).toISOString()}`
      }
    }

    const payloadStr = t.payload ? `\n   Payload: ${t.payload}` : ''
    line += payloadStr

    // End conditions
    if (!t.expired && (t.schedule.mode === 'interval' || t.schedule.mode === 'cron')) {
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
