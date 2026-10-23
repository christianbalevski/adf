// Agent-defined commands join the ordinary TUI registry. Shell names keep
// precedence; /command <name> reaches registrations that collide with them.
import * as rulesNs from '../../../shared/utils/agent-commands'
import * as displayNs from '../../../shared/utils/skills-panel'
import type { AgentCommand } from '../../../shared/types/adf-v02.types'
import { cjs } from '../interop'
import { parseSlash, type CommandRegistry } from './registry'
import type { CommandContext, SlashCommand } from './types'

const { validateAgentCommands, parseAuthorizeToken } = cjs(rulesNs)
const { sanitizeDisplayText } = cjs(displayNs)

export function validAgentCommands(value: unknown): AgentCommand[] {
  if (!Array.isArray(value)) return []
  const invalid = new Set(validateAgentCommands(value).map(issue => issue.index))
  return value.slice(0, 64).filter((_, index) => !invalid.has(index))
}

function registered(ctx: Pick<CommandContext, 'state' | 'agentId'>): AgentCommand[] {
  return validAgentCommands(ctx.agentId ? ctx.state().agents[ctx.agentId]?.config?.commands : undefined)
}

async function run(ctx: CommandContext, name: string, args: string): Promise<void> {
  if (!ctx.agentId) {
    ctx.print(ctx.stoppedKey ? `Agent is off. Start it, then run /${name} again.` : 'Select an agent first.', 'warn')
    return
  }
  await ctx.actions.runAgentCommand(ctx.agentId, ctx.loop, name, args)
}

/** Split just the registration name. Preserve raw arguments for the shared parser. */
function namedArgs(rest: string): { name: string; args: string } | undefined {
  const match = rest.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/)
  return match ? { name: match[1], args: match[2] ?? '' } : undefined
}

export const agentCommand: SlashCommand = {
  name: 'command',
  args: '<name> [args]',
  description: 'Run an agent lambda command; add !authorize for one authorized run',
  agentCommand: '*',
  complete: (partial, scope) => registered(scope).filter(command => command.name.startsWith(partial)).map(command => command.name),
  run: async ctx => {
    const input = namedArgs(ctx.rest)
    if (!input) { ctx.print('Usage: /command <name> [args] [!authorize]', 'warn'); return }
    await run(ctx, input.name, input.args)
  },
}

export function withAgentCommands(base: CommandRegistry, value: unknown): CommandRegistry {
  const dynamic = validAgentCommands(value).filter(command => !base.find(command.name)).map((command): SlashCommand => ({
    name: command.name,
    args: sanitizeDisplayText(command.usage) || undefined,
    description: `${sanitizeDisplayText(command.description)}${command.locked ? ' [locked]' : ''}`,
    view: 'chat',
    agentCommand: command.name,
    run: ctx => run(ctx, command.name, ctx.rest),
  }))
  return { ...base, commands: [...base.commands, ...dynamic], find: name => base.find(name) ?? dynamic.find(command => command.name === name.toLowerCase()) }
}

/** Used by the prompt to show elevation before Enter, including /command. */
export function isAuthorizedCommandInput(text: string, registry: CommandRegistry): boolean {
  const parsed = parseSlash(text)
  const name = parsed && registry.find(parsed.name)?.agentCommand
  if (!parsed || !name) return false
  const args = name === '*' ? namedArgs(parsed.rest)?.args : parsed.rest
  return args !== undefined && parseAuthorizeToken(args).authorize
}

export function hasCommandArguments(rest: string): boolean {
  return parseAuthorizeToken(rest).args.length > 0
}
