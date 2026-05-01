/**
 * Networking commands: curl, wget
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'

const curlHandler: CommandHandler = {
  name: 'curl',
  aliases: ['wget'],
  summary: 'HTTP requests',
  helpText: [
    'curl <url>                   GET request',
    'curl -X POST -d \'data\' <url> POST with body',
    'curl -H "Header: Value" <url> Custom headers',
    'curl -o <path> <url>         Download to file',
    '',
    'Options:',
    '  -X <method>                HTTP method',
    '  -H <header>                Add header (repeatable)',
    '  -d <data>                  Request body',
    '  -o <path>                  Save output to VFS file',
    '  -O <path>                  Same as -o (wget compat)',
  ].join('\n'),
  category: 'network',
  resolvedTools: ['sys_fetch'],
  valueFlags: new Set(['X', 'H', 'd', 'o', 'O']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const url = ctx.args[ctx.args.length - 1]
    if (!url) return err('curl: missing URL')

    const method = (ctx.flags.X as string) ?? (ctx.flags.d ? 'POST' : 'GET')
    const body = ctx.flags.d as string | undefined
    const outputPath = (ctx.flags.o ?? ctx.flags.O) as string | undefined

    // Parse headers
    const headers: Record<string, string> = {}
    const headerFlag = ctx.flags.H
    if (headerFlag) {
      const headerList = Array.isArray(headerFlag) ? headerFlag : [headerFlag as string]
      for (const h of headerList) {
        const colonIdx = h.indexOf(':')
        if (colonIdx > 0) {
          headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim()
        }
      }
    }

    // Use stdin as body if -d not specified and stdin present
    const requestBody = body ?? (ctx.stdin || undefined)

    const input: Record<string, unknown> = {
      url,
      method: method.toUpperCase(),
    }
    if (Object.keys(headers).length > 0) input.headers = headers
    if (requestBody) input.body = requestBody

    const result = await ctx.toolRegistry.executeTool('sys_fetch', input, ctx.workspace)
    if (result.isError) return err(`curl: ${result.content}`)

    // Save to file if -o specified
    if (outputPath) {
      await ctx.toolRegistry.executeTool('fs_write', {
        mode: 'write',
        path: outputPath,
        content: result.content
      }, ctx.workspace)
      return ok('')
    }

    return ok(result.content)
  }
}

export const networkingHandlers: CommandHandler[] = [curlHandler]
