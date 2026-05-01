/**
 * MCP commands: mcp --list, mcp <server> <tool>
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import type { ArgumentNode } from '../parser/ast'
import { ok, err } from './types'

const mcpHandler: CommandHandler = {
  name: 'mcp',
  summary: 'MCP tool discovery and invocation',
  helpText: [
    'mcp --list                         List MCP servers',
    'mcp <server> --list                List tools on server',
    'mcp <server> <tool> -h             Show tool schema',
    'mcp <server> <tool> [--flags]      Invoke tool with args',
    '',
    'Examples:',
    '  mcp github create_issue --title "Bug" --body "Details"',
    '  cat data.md | mcp slack send_message --channel "#reports"',
  ].join('\n'),
  category: 'mcp',
  resolvedTools: [],  // dynamic — resolved via resolveToolsFromArgs

  resolveToolsFromArgs(args: ArgumentNode[]): string[] {
    // Extract literal server and tool names: mcp <server> <tool> [--flags...]
    // Skip flag tokens (--list, --title, etc.) — only positional literals matter
    const positionals = args
      .filter((a): a is { type: 'literal'; value: string } =>
        a.type === 'literal' && !a.value.startsWith('-'))
    if (positionals.length >= 2) {
      return [`mcp_${positionals[0].value}_${positionals[1].value}`]
    }
    return []
  },

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // mcp --list — list servers
    if (ctx.flags.list !== undefined && ctx.args.length === 0) {
      return listServers(ctx)
    }

    if (ctx.args.length === 0) return err('mcp: usage: mcp <server> <tool> [--flags]')

    const server = ctx.args[0]

    // mcp <server> --list — list tools on server
    if (ctx.flags.list !== undefined) {
      return listServerTools(server, ctx)
    }

    if (ctx.args.length < 2) return err(`mcp: usage: mcp ${server} <tool> [--flags]`)

    const tool = ctx.args[1]
    const mcpToolName = `mcp_${server}_${tool}`

    // mcp <server> <tool> -h — show tool help/schema
    if (ctx.flags.h !== undefined || ctx.flags.help !== undefined) {
      return showToolHelp(mcpToolName, ctx)
    }

    // Build args from remaining flags
    const toolArgs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(ctx.flags)) {
      if (key === 'h' || key === 'help' || key === 'list') continue
      toolArgs[key] = value
    }

    // Add stdin as body/text/content if present and not already provided
    if (ctx.stdin && !toolArgs.body && !toolArgs.text && !toolArgs.content) {
      toolArgs.content = ctx.stdin
    }

    const result = await ctx.toolRegistry.executeTool(mcpToolName, toolArgs, ctx.workspace)
    if (result.isError) return err(`mcp ${server} ${tool}: ${result.content}`)
    return ok(result.content)
  }
}

function listServers(ctx: CommandContext): CommandResult {
  // List all tools starting with mcp_ and extract server names
  const allTools = ctx.toolRegistry.getAll()
  const servers = new Set<string>()
  for (const tool of allTools) {
    if (tool.name.startsWith('mcp_')) {
      const parts = tool.name.split('_')
      if (parts.length >= 3) {
        servers.add(parts[1])
      }
    }
  }
  if (servers.size === 0) return ok('No MCP servers connected.')
  return ok([...servers].sort().join('\n'))
}

function listServerTools(server: string, ctx: CommandContext): CommandResult {
  const allTools = ctx.toolRegistry.getAll()
  const prefix = `mcp_${server}_`
  const tools = allTools
    .filter(t => t.name.startsWith(prefix))
    .map(t => {
      const toolName = t.name.slice(prefix.length)
      return `${toolName.padEnd(30)} ${t.description.slice(0, 60)}`
    })

  if (tools.length === 0) return ok(`No tools found for server: ${server}`)
  return ok(tools.join('\n'))
}

function showToolHelp(mcpToolName: string, ctx: CommandContext): CommandResult {
  const tool = ctx.toolRegistry.get(mcpToolName)
  if (!tool) return err(`Unknown MCP tool: ${mcpToolName}`)

  const schema = tool.toProviderFormat()
  const lines = [
    schema.description || '(no description)',
    '',
    'Parameters:',
  ]

  const inputSchema = schema.input_schema as Record<string, unknown>
  const props = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((inputSchema.required ?? []) as string[])

  for (const [name, prop] of Object.entries(props)) {
    const req = required.has(name) ? ' (required)' : ''
    const desc = (prop.description as string) ?? ''
    lines.push(`  --${name.padEnd(20)} ${prop.type ?? 'any'}${req} ${desc}`)
  }

  return ok(lines.join('\n'))
}

export const mcpHandlers: CommandHandler[] = [mcpHandler]
