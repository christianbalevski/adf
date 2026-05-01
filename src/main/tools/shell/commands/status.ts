/**
 * Status and builtin commands: ps, kill, wait, whoami, config, status,
 * env, export, pwd, date, true, false, sleep
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'

const psHandler: CommandHandler = {
  name: 'ps',
  summary: 'List tasks',
  helpText: [
    'ps                   List pending/running tasks',
    'ps --all             List all tasks (including completed)',
  ].join('\n'),
  category: 'process',
  resolvedTools: ['db_query'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const all = !!ctx.flags.all
    const sql = all
      ? 'SELECT id, tool, status, origin, created_at FROM adf_tasks ORDER BY created_at DESC'
      : "SELECT id, tool, status, origin, created_at FROM adf_tasks WHERE status IN ('pending', 'running') ORDER BY created_at DESC"

    const result = await ctx.toolRegistry.executeTool('db_query', { sql }, ctx.workspace)
    if (result.isError) return err(`ps: ${result.content}`)
    return ok(result.content || 'No tasks.')
  }
}

const killHandler: CommandHandler = {
  name: 'kill',
  summary: 'Cancel a task',
  helpText: 'kill <task_id>       Cancel a pending/running task',
  category: 'process',
  resolvedTools: ['db_execute'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('kill: missing task ID')
    const taskId = ctx.args[0]

    const result = await ctx.toolRegistry.executeTool('db_execute', {
      sql: `UPDATE adf_tasks SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'running')`,
      params: [taskId]
    }, ctx.workspace)
    if (result.isError) return err(`kill: ${result.content}`)
    return ok(`Task ${taskId} cancelled.`)
  }
}

const waitHandler: CommandHandler = {
  name: 'wait',
  summary: 'Wait for a task to complete',
  helpText: 'wait <task_id>       Block until task reaches terminal state',
  category: 'process',
  resolvedTools: ['db_query'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('wait: missing task ID')
    const taskId = ctx.args[0]
    const maxWait = 30_000
    const start = Date.now()
    const pollInterval = 500

    while (Date.now() - start < maxWait) {
      const result = await ctx.toolRegistry.executeTool('db_query', {
        sql: `SELECT status FROM adf_tasks WHERE id = ?`,
        params: [taskId]
      }, ctx.workspace)
      if (result.isError) return err(`wait: ${result.content}`)

      try {
        const parsed = JSON.parse(result.content)
        const rows = Array.isArray(parsed) ? parsed : parsed?.rows ?? []
        if (rows.length > 0) {
          const status = rows[0]?.status ?? rows[0]
          if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            return ok(`Task ${taskId}: ${status}`)
          }
        }
      } catch {
        // Try plain text match
        if (result.content.includes('completed') || result.content.includes('failed') || result.content.includes('cancelled')) {
          return ok(result.content)
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    return err(`wait: timed out after ${maxWait / 1000}s`)
  }
}

const whoamiHandler: CommandHandler = {
  name: 'whoami',
  summary: 'Show agent identity',
  helpText: 'whoami               Display name, DID, state, description, owner',
  category: 'identity',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const config = ctx.config
    const lines = [
      `Name:        ${config.name ?? 'unknown'}`,
      `State:       ${config.state ?? 'unknown'}`,
      `Description: ${config.description ?? ''}`,
    ]

    // Try to get DID from identity
    try {
      const did = ctx.env.resolve('AGENT_DID')
      if (did) lines.splice(1, 0, `DID:         ${did}`)
    } catch { /* ignore */ }

    return ok(lines.join('\n'))
  }
}

const configHandler: CommandHandler = {
  name: 'config',
  summary: 'View or update agent config',
  helpText: [
    'config               Show full agent configuration',
    'config set <path> <value>  Update a config field',
  ].join('\n'),
  category: 'identity',
  resolvedTools: ['sys_get_config', 'sys_update_config'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args[0] === 'set' && ctx.args.length >= 3) {
      const path = ctx.args[1]
      let value: unknown = ctx.args[2]
      // Try to parse as JSON
      try { value = JSON.parse(ctx.args[2]) } catch { /* keep as string */ }

      const result = await ctx.toolRegistry.executeTool('sys_update_config', {
        path, value
      }, ctx.workspace)
      if (result.isError) return err(`config: ${result.content}`)
      return ok(result.content)
    }

    const result = await ctx.toolRegistry.executeTool('sys_get_config', {}, ctx.workspace)
    if (result.isError) return err(`config: ${result.content}`)
    return ok(result.content)
  }
}

const statusHandler: CommandHandler = {
  name: 'status',
  summary: 'Show agent status summary',
  helpText: 'status               State, token usage, budget remaining',
  category: 'identity',
  resolvedTools: ['sys_get_config'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const config = ctx.config
    const lines = [
      `Agent:     ${config.name ?? 'unknown'}`,
      `State:     ${config.state ?? 'unknown'}`,
      `Model:     ${config.model?.provider ?? ''}/${config.model?.model_id ?? ''}`,
      `Autonomy:  ${config.autonomous ? 'enabled' : 'disabled'}`,
    ]
    if (config.limits?.token_budget) {
      lines.push(`Budget:    ${config.limits.token_budget} tokens`)
    }
    return ok(lines.join('\n'))
  }
}

const envHandler: CommandHandler = {
  name: 'env',
  summary: 'List environment variables',
  helpText: 'env                  List all environment variables (sensitive values redacted)',
  category: 'identity',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const vars = ctx.env.listAll()
    if (vars.length === 0) return ok('No environment variables set.')

    const lines = vars.map(v => {
      const redacted = v.source === 'identity' ? '***' : v.value
      return `${v.key}=${redacted}`
    })
    return ok(lines.join('\n'))
  }
}

const exportHandler: CommandHandler = {
  name: 'export',
  summary: 'Set an environment variable',
  helpText: [
    'export KEY=value     Write to adf_identity (plain, non-encrypted)',
    'export KEY="value"   Same with quoted value',
  ].join('\n'),
  category: 'identity',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('export: usage: export KEY=value')
    const assignment = ctx.args.join(' ')
    const eqIdx = assignment.indexOf('=')
    if (eqIdx <= 0) return err('export: invalid format. Use KEY=value')

    const key = assignment.slice(0, eqIdx).trim()
    let value = assignment.slice(eqIdx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // Write to session env
    ctx.env.export(key, value)

    // Also persist to adf_identity
    try {
      ctx.workspace.setIdentity(key.toLowerCase(), value)
    } catch { /* identity write failure is non-fatal for export */ }

    return ok(`${key}=${value}`)
  }
}

const pwdHandler: CommandHandler = {
  name: 'pwd',
  summary: 'Print working directory',
  helpText: 'pwd                  Always / (VFS root)',
  category: 'identity',
  resolvedTools: [],
  async execute(ctx: CommandContext): Promise<CommandResult> {
    return ok('/')
  }
}

const dateHandler: CommandHandler = {
  name: 'date',
  summary: 'Print current date/time',
  helpText: [
    'date                 Print current date/time (ISO 8601)',
    'date +<format>       Strftime-style: %Y, %m, %d, %H, %M, %S, %s',
  ].join('\n'),
  category: 'identity',
  resolvedTools: [],
  async execute(ctx: CommandContext): Promise<CommandResult> {
    const now = new Date()
    const fmt = ctx.args[0]
    if (fmt && fmt.startsWith('+')) {
      const pattern = fmt.slice(1)
      const pad = (n: number) => String(n).padStart(2, '0')
      const result = pattern
        .replace(/%Y/g, String(now.getFullYear()))
        .replace(/%m/g, pad(now.getMonth() + 1))
        .replace(/%d/g, pad(now.getDate()))
        .replace(/%H/g, pad(now.getHours()))
        .replace(/%M/g, pad(now.getMinutes()))
        .replace(/%S/g, pad(now.getSeconds()))
        .replace(/%s/g, String(Math.floor(now.getTime() / 1000)))
      return ok(result)
    }
    return ok(now.toISOString())
  }
}

const trueHandler: CommandHandler = {
  name: 'true',
  summary: 'Return success (exit 0)',
  helpText: 'true                 Always exits 0',
  category: 'general',
  resolvedTools: [],
  async execute(): Promise<CommandResult> {
    return { exit_code: 0, stdout: '', stderr: '' }
  }
}

const falseHandler: CommandHandler = {
  name: 'false',
  summary: 'Return failure (exit 1)',
  helpText: 'false                Always exits 1',
  category: 'general',
  resolvedTools: [],
  async execute(): Promise<CommandResult> {
    return { exit_code: 1, stdout: '', stderr: '' }
  }
}

const sleepHandler: CommandHandler = {
  name: 'sleep',
  summary: 'Pause for N seconds',
  helpText: 'sleep <seconds>      Pause execution',
  category: 'general',
  resolvedTools: [],
  async execute(ctx: CommandContext): Promise<CommandResult> {
    const secs = parseFloat(ctx.args[0] ?? '0')
    if (isNaN(secs) || secs < 0) return err('sleep: invalid duration')
    const ms = Math.min(secs * 1000, 60_000) // cap at 60s
    await new Promise(resolve => setTimeout(resolve, ms))
    return ok('')
  }
}

export const statusHandlers: CommandHandler[] = [
  psHandler, killHandler, waitHandler, whoamiHandler,
  configHandler, statusHandler, envHandler, exportHandler,
  pwdHandler, dateHandler, trueHandler, falseHandler, sleepHandler,
]
