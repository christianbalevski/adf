/**
 * Timer commands: at, crontab
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'

/** Parse duration string (30s, 5m, 1h, 2d) to milliseconds */
function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return null
  const [, num, unit] = match
  const n = parseInt(num, 10)
  switch (unit) {
    case 's': return n * 1000
    case 'm': return n * 60 * 1000
    case 'h': return n * 60 * 60 * 1000
    case 'd': return n * 24 * 60 * 60 * 1000
    default: return null
  }
}

const atHandler: CommandHandler = {
  name: 'at',
  summary: 'Schedule a timer',
  helpText: [
    'at "<iso_time>" <lambda>         One-shot at absolute time',
    'at --delay <duration> <lambda>   One-shot after delay (30s, 5m, 1h, 2d)',
    'at --every <duration> <lambda>   Recurring interval',
    'at --cron "<expr>" <lambda>      Cron expression (5-field)',
    '',
    'Options:',
    '  --scope system                 System scope (default: agent)',
    '  --payload "<data>"             Attach payload string',
  ].join('\n'),
  category: 'timers',
  resolvedTools: ['sys_set_timer'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const scope = (ctx.flags.scope as string) ?? 'agent'
    const payload = ctx.flags.payload as string | undefined
    const delay = ctx.flags.delay as string | undefined
    const every = ctx.flags.every as string | undefined
    const cron = ctx.flags.cron as string | undefined

    // Lambda is the last positional arg
    const lambda = ctx.args[ctx.args.length - 1]
    if (!lambda) return err('at: missing lambda path')

    const input: Record<string, unknown> = { scope }
    if (payload) input.payload = payload

    if (delay) {
      const ms = parseDuration(delay)
      if (ms === null) return err(`at: invalid duration: ${delay}`)
      input.schedule = { type: 'delay', delay_ms: ms }
      input.lambda = lambda
    } else if (every) {
      const ms = parseDuration(every)
      if (ms === null) return err(`at: invalid duration: ${every}`)
      input.schedule = { type: 'interval', every_ms: ms }
      input.lambda = lambda
    } else if (cron) {
      input.schedule = { type: 'cron', cron }
      input.lambda = lambda
    } else if (ctx.args.length >= 2) {
      // Absolute time: at "<iso_time>" <lambda>
      const isoTime = ctx.args[0]
      const ms = new Date(isoTime).getTime()
      if (isNaN(ms)) return err(`at: invalid ISO time: ${isoTime}`)
      input.schedule = { type: 'once', at: ms }
      input.lambda = lambda
    } else {
      return err('at: specify --delay, --every, --cron, or an ISO time')
    }

    const result = await ctx.toolRegistry.executeTool('sys_set_timer', input, ctx.workspace)
    if (result.isError) return err(`at: ${result.content}`)
    return ok(result.content)
  }
}

const crontabHandler: CommandHandler = {
  name: 'crontab',
  summary: 'Manage timers',
  helpText: [
    'crontab -l           List all timers',
    'crontab -d <id>      Delete a timer',
  ].join('\n'),
  category: 'timers',
  resolvedTools: ['sys_list_timers', 'sys_delete_timer'],
  valueFlags: new Set(['d']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.flags.l !== undefined) {
      const result = await ctx.toolRegistry.executeTool('sys_list_timers', {}, ctx.workspace)
      if (result.isError) return err(`crontab: ${result.content}`)
      return ok(result.content)
    }

    if (ctx.flags.d !== undefined) {
      const timerId = typeof ctx.flags.d === 'string' ? ctx.flags.d : ctx.args[0]
      if (!timerId) return err('crontab -d: missing timer ID')
      const result = await ctx.toolRegistry.executeTool('sys_delete_timer', { timer_id: timerId }, ctx.workspace)
      if (result.isError) return err(`crontab: ${result.content}`)
      return ok(result.content)
    }

    return err('crontab: use -l to list or -d <id> to delete')
  }
}

export const timerHandlers: CommandHandler[] = [atHandler, crontabHandler]
