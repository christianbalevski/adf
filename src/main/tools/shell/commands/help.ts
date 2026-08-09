/**
 * Help command — global listing and per-command -h handling.
 */

import type { CommandHandler, CommandContext, CommandResult, CommandCategory } from './types'
import { ok } from './types'
import { getAllCommands } from './index'

const CATEGORY_ORDER: CommandCategory[] = [
  'filesystem', 'text', 'data', 'messaging', 'network',
  'timers', 'code', 'process', 'identity', 'mcp', 'general'
]

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  filesystem: 'Filesystem',
  text: 'Text',
  data: 'Data',
  messaging: 'Messaging',
  network: 'Network',
  timers: 'Timers',
  code: 'Code',
  process: 'Process',
  identity: 'Identity',
  mcp: 'MCP',
  general: 'General',
}

export const helpHandler: CommandHandler = {
  name: 'help',
  summary: 'List all commands or get help for a specific command',
  helpText: [
    'help              List all available commands grouped by category',
    'help <command>    Show detailed help for a command',
    '<command> -h      Same as help <command>',
  ].join('\n'),
  category: 'general',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // help <command> — show specific command help
    if (ctx.args.length > 0) {
      const { getCommand } = await import('./index')
      const handler = getCommand(ctx.args[0])
      if (handler) {
        return ok(handler.helpText)
      }
      return ok(`Unknown command: ${ctx.args[0]}`)
    }

    // Global help listing
    const commands = getAllCommands()
    const grouped = new Map<CommandCategory, CommandHandler[]>()

    for (const cmd of commands) {
      if (cmd.name === 'help') continue
      const list = grouped.get(cmd.category) ?? []
      list.push(cmd)
      grouped.set(cmd.category, list)
    }

    const lines: string[] = []
    for (const cat of CATEGORY_ORDER) {
      const cmds = grouped.get(cat)
      if (!cmds || cmds.length === 0) continue
      const label = CATEGORY_LABELS[cat].padEnd(12)
      const names = cmds.map(c => {
        const aliases = c.aliases ? ` (${c.aliases.join(', ')})` : ''
        return c.name + aliases
      }).join(', ')
      lines.push(`${label} ${names}`)
    }

    lines.push('')
    lines.push('jq is real jq 1.8.2; sort/uniq/wc/cut/tr are real GNU coreutils (WASM).')
    lines.push('Use <command> -h for details. `config tools [name]` shows tool schemas.')
    lines.push('Run saved scripts: ./script.sh (shell) or ./script.ts (lambda).')
    lines.push('Pipelines exit with the LAST stage\'s code (no pipefail) — to branch on a')
    lines.push('failed/gated producer, use `cmd 2>err.txt; echo $?` rather than piping it.')

    return ok(lines.join('\n'))
  }
}
