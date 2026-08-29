import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { CronExpressionParser } from 'cron-parser'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { TimerSchedule } from '../../../shared/types/adf-v02.types'
import { MAIN_LOOP } from '../../adf/derive-loop-config'

const ScheduleOnceSchema = z.object({
  type: z.literal('once'),
  at: z.number().int().positive().describe('Fire at this Unix timestamp (ms).')
}).passthrough()

const ScheduleDelaySchema = z.object({
  type: z.literal('delay'),
  delay_ms: z.number().int().positive().describe('Fire once after this many ms from now.')
}).passthrough()

const ScheduleIntervalSchema = z.object({
  type: z.literal('interval'),
  every_ms: z.number().int().positive().describe('Recurring interval (ms).'),
  start_at: z.number().int().positive().optional().describe('First fire time (Unix ms). Default: now + every_ms.'),
  end_at: z.number().int().positive().optional().describe('Stop recurring after this time (Unix ms).'),
  max_runs: z.number().int().positive().optional().describe('Stop recurring after this many fires.')
}).passthrough()

const ScheduleCronSchema = z.object({
  type: z.literal('cron'),
  cron: z.string().describe('5-field cron expression (min hour dom month dow).'),
  end_at: z.number().int().positive().optional().describe('Stop recurring after this time (Unix ms).'),
  max_runs: z.number().int().positive().optional().describe('Stop recurring after this many fires.')
}).passthrough()

const ScheduleSchema = z.discriminatedUnion('type', [
  ScheduleOnceSchema, ScheduleDelaySchema, ScheduleIntervalSchema, ScheduleCronSchema
])

const InputSchema = z.object({
  schedule: ScheduleSchema.describe('Timer schedule. Set type to "once", "delay", "interval", or "cron" and include the fields for that type.'),
  payload: z.string().optional()
    .describe('Payload delivered when timer fires. When scope includes "agent", this becomes the user message in your next turn — write it as plain text instructions to your future self (e.g. "Check on the data import and report progress to the user").'),
  scope: z.array(z.enum(['system', 'agent'])).min(1).default(['system'])
    .describe('Who handles the timer. "agent" — fires as a turn in your LLM loop with the payload as your prompt. "system" — executes the lambda/script without an LLM turn. Use both to run a lambda AND get an LLM turn.'),
  lambda: z.string().optional()
    .describe('Source path for system scope execution. JS/TS lambda: "path/file.ts:functionName" (receives the event object). Shell script: "path/file.sh" — runs line-by-line in the shell with event context as env vars ($EVENT_TYPE, $TIMER_ID, ...).'),
  warm: z.boolean().optional()
    .describe('Keep the lambda sandbox worker alive between invocations for faster re-execution.'),
  locked: z.boolean().optional()
    .describe('Lock this timer so it cannot be deleted or modified by agents. Only a human can unlock it.')
})

/**
 * Schedule a timer with once, interval, or cron mode.
 */
export class SetTimerTool implements Tool {
  readonly name = 'sys_set_timer'
  readonly description =
    'Schedule a timer. Set schedule.type to "once" (absolute time), "delay" (relative), "interval" (recurring), or "cron". Returns timer ID and schedule details.'
  readonly inputSchema = InputSchema
  readonly category = 'timer' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const now = Date.now()
    const sched = parsed.schedule

    const denied = SetTimerTool.checkSideLoopScope(workspace, parsed)
    if (denied) return denied

    try {
      let schedule: TimerSchedule
      let nextWakeAt: number
      let description: string

      switch (sched.type) {
        case 'once': {
          if (sched.at <= now) {
            return { content: `Timer 'at' must be in the future. Current time: ${now}, provided: ${sched.at}`, isError: true }
          }
          schedule = { mode: 'once', at: sched.at }
          nextWakeAt = sched.at
          description = `[once] fires at ${new Date(sched.at).toISOString()} (${this.formatDelay(sched.at - now)})`
          break
        }
        case 'delay': {
          const at = now + sched.delay_ms
          schedule = { mode: 'once', at }
          nextWakeAt = at
          description = `[once] fires in ${this.formatDelay(sched.delay_ms)}`
          break
        }
        case 'interval': {
          nextWakeAt = sched.start_at ?? (now + sched.every_ms)
          if (nextWakeAt <= now) {
            return { content: `start_at must be in the future. Current time: ${now}, provided: ${nextWakeAt}`, isError: true }
          }
          schedule = {
            mode: 'interval',
            every_ms: sched.every_ms,
            ...(sched.start_at !== undefined && { start_at: sched.start_at }),
            ...(sched.end_at !== undefined && { end_at: sched.end_at }),
            ...(sched.max_runs !== undefined && { max_runs: sched.max_runs })
          }
          description = `[interval: ${this.formatDelay(sched.every_ms)}] next fire in ${this.formatDelay(nextWakeAt - now)}`
          if (sched.max_runs) description += ` | max ${sched.max_runs} runs`
          if (sched.end_at) description += ` | ends ${new Date(sched.end_at).toISOString()}`
          break
        }
        case 'cron': {
          try {
            const interval = CronExpressionParser.parse(sched.cron, { currentDate: new Date(now) })
            nextWakeAt = interval.next().getTime()
          } catch (err) {
            return { content: `Invalid cron expression: ${String(err)}`, isError: true }
          }
          schedule = {
            mode: 'cron',
            cron: sched.cron,
            ...(sched.end_at !== undefined && { end_at: sched.end_at }),
            ...(sched.max_runs !== undefined && { max_runs: sched.max_runs })
          }
          description = `[cron: ${sched.cron}] next fire at ${new Date(nextWakeAt).toISOString()} (${this.formatDelay(nextWakeAt - now)})`
          if (sched.max_runs) description += ` | max ${sched.max_runs} runs`
          if (sched.end_at) description += ` | ends ${new Date(sched.end_at).toISOString()}`
          break
        }
      }

      const id = workspace.addTimer(schedule, nextWakeAt, parsed.payload, parsed.scope, parsed.lambda, parsed.warm, parsed.locked)

      return {
        content: `Timer set successfully.\nID: ${id}\nScope: ${JSON.stringify(parsed.scope)}\n${description}${parsed.locked ? '\nLocked: true' : ''}${parsed.lambda ? `\nLambda: ${parsed.lambda}` : ''}${parsed.payload ? `\nPayload: ${parsed.payload}` : ''}`,
        isError: false
      }
    } catch (error) {
      return {
        content: `Failed to set timer: ${String(error)}`,
        isError: true
      }
    }
  }

  /**
   * The one hard loop boundary: a side loop may not create a system-scope
   * lambda timer (docs/design/agent-loops-mvp.md §2.3, SEC-2/5), nor a `locked`
   * timer of any kind.
   *
   * System-scope timers fire through the single agent-wide
   * `SystemScopeHandler`, which is keyed by file authorization and not by loop
   * — so a lambda a side loop scheduled would later execute under *main's*
   * unattenuated authority, out from under the loop's derived config. Per-loop
   * `SystemScopeHandler` routing (capability-follows-provenance) is F2.
   *
   * Scoped as narrowly as the risk: it is the LAMBDA that is refused, not the
   * timer. `scope: ['system']` with no lambda is already a documented no-op
   * ("no lambda — skipped", `trigger-evaluator.ts`), and it is this tool's
   * default value, so refusing it would break plain wake timers for every side
   * loop. Plain `agent`-scope wake/message timers are untouched: a loop
   * schedules a wake and runs its code inline during the resulting turn,
   * through its own attenuated `AdfCallHandler`. The workspace facade already
   * forces the `loop` stamp on whatever is written.
   *
   * `locked: true` is refused for the same shape of reason. A locked timer is
   * an OWNER assertion — `sys_delete_timer` refuses to remove one on every
   * agent path, main's included — so a side loop that set one would have
   * created a recurring, un-revocable injection into the agent that not even
   * main can clear. Locking is operator-only from a side loop.
   */
  private static checkSideLoopScope(
    workspace: AdfWorkspace,
    parsed: z.infer<typeof InputSchema>
  ): ToolResult | null {
    const loop = workspace.getLoopName()
    if (loop === MAIN_LOOP) return null

    if (parsed.locked === true) {
      return {
        content:
          `Loop "${loop}" cannot set a locked timer — locked timers are operator-only from side loops. ` +
          'A lock makes the timer undeletable by any agent path, including main, so a side loop cannot be ' +
          'the one to create it. Set the timer without "locked", or ask the owner (through main, with ' +
          'loop_send) if it genuinely has to be permanent.',
        isError: true
      }
    }

    if (!parsed.lambda) return null

    return {
      content:
        `Loop "${loop}" cannot schedule a lambda timer. A lambda runs in the system scope, through the agent-wide ` +
        "system handler, under the main loop's authority rather than this loop's — so it is reserved for main. " +
        'Schedule the timer with scope ["agent"] and a payload instead, and run the same code inline during the ' +
        'turn it gives you. Note that such a timer wakes THIS loop only when the agent config has an on_timer ' +
        'target naming it; without that target it does not reach you. If it truly needs main\'s authority, ' +
        'ask main with loop_send.',
      isError: true
    }
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
