/**
 * Shell command: meta — read/write adf_meta key-value pairs.
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'
import { META_PROTECTION_LEVELS } from '../../../../shared/types/adf-v02.types'

const metaHandler: CommandHandler = {
  name: 'meta',
  summary: 'Read and write adf_meta key-value pairs',
  helpText: [
    'meta list                           List all key-value pairs (with protection)',
    'meta get <key>                      Get value for a key',
    'meta set <key> <value> [protection] Set a key-value pair (agent keys only)',
    'meta delete <key>                   Delete a key (agent keys only)',
    '',
    'Protection levels: none (default), readonly, increment',
    'Protection is set at creation and cannot be changed by the agent.',
  ].join('\n'),
  category: 'identity',
  resolvedTools: ['sys_get_meta', 'sys_set_meta', 'sys_delete_meta'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const sub = ctx.args[0] ?? 'list'

    switch (sub) {
      case 'get': {
        if (!ctx.args[1]) return err('meta get: missing key')
        const result = await ctx.toolRegistry.executeTool('sys_get_meta', { key: ctx.args[1] }, ctx.workspace)
        if (result.isError) return err(`meta: ${result.content}`)
        return ok(result.content)
      }

      case 'set': {
        if (!ctx.args[1] || ctx.args[2] === undefined) return err('meta set: usage: meta set <key> <value> [protection]')
        const lastArg = ctx.args[ctx.args.length - 1]
        const isProtection = ctx.args.length > 3 && (META_PROTECTION_LEVELS as readonly string[]).includes(lastArg)
        const value = isProtection ? ctx.args.slice(2, -1).join(' ') : ctx.args.slice(2).join(' ')
        const protection = isProtection ? lastArg : undefined
        const toolInput: Record<string, string> = { key: ctx.args[1], value }
        if (protection) toolInput.protection = protection
        const result = await ctx.toolRegistry.executeTool('sys_set_meta', toolInput, ctx.workspace)
        if (result.isError) return err(`meta: ${result.content}`)
        return ok(result.content)
      }

      case 'delete': {
        if (!ctx.args[1]) return err('meta delete: missing key')
        const result = await ctx.toolRegistry.executeTool('sys_delete_meta', { key: ctx.args[1] }, ctx.workspace)
        if (result.isError) return err(`meta: ${result.content}`)
        return ok(result.content)
      }

      case 'list': {
        const result = await ctx.toolRegistry.executeTool('sys_get_meta', {}, ctx.workspace)
        if (result.isError) return err(`meta: ${result.content}`)
        return ok(result.content)
      }

      default:
        return err(`meta: unknown subcommand "${sub}". Use: get, set, list, delete`)
    }
  }
}

export const metaHandlers: CommandHandler[] = [metaHandler]
