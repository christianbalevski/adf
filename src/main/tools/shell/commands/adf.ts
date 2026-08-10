/**
 * adf — generic tool invocation: `adf <tool_name> ['<json>']`.
 *
 * The tool-bus door for tools that have no dedicated shell command
 * (chat_info, fs_transfer, loop_compact, finer timer/meta ops, ...). Parses
 * the JSON input (default {}), dispatches through the protection-gated
 * registry, and prints the raw tool result.
 *
 * SECURITY MODEL
 * - Gating: resolveToolsFromArgs surfaces the literal tool name so the
 *   executor's per-command gate (disabled / HIL approval / on_tool_call)
 *   evaluates it BEFORE execution. A variable/substitution tool name cannot
 *   be resolved statically, so it FAILS CLOSED by throwing from the resolver
 *   — the gate runs before arg resolution, so the dynamic name is refused
 *   before any $VAR/$() is even expanded, and an ungated name can never
 *   reach the registry. (Self-gating at execute time — the mcp pattern —
 *   would work too, but a literal name would then be gated twice and
 *   double-prompt HIL; refusing dynamics keeps one gate and fails plainly.)
 * - Underscore keys: tool-registry.executeTool treats top-level `_full`,
 *   `_authorized`, and `_protection_override` as cross-cutting privilege
 *   params injected only by TRUSTED paths (authorized-script registry
 *   wrapper in commands/code.ts, protection-override HIL flow). Accepting
 *   them from shell JSON would let any agent self-authorize past file/table
 *   protection checks, so ANY top-level key starting with '_' is refused
 *   before the registry is called (future runtime params stay closed too).
 * - adf_shell itself is refused (recursive shell-in-shell).
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import type { ArgumentNode } from '../parser/ast'
import { ok, err } from './types'

/** Static string value of an arg node, or null when it depends on runtime
 *  state (variables / substitutions). Quoted args made only of literal parts
 *  are static too (`adf "fs_read"`). */
function staticArgValue(arg: ArgumentNode): string | null {
  if (arg.type === 'literal') return arg.value
  if (arg.type === 'quoted' && arg.parts.every((p) => p.type === 'literal')) {
    return arg.parts.map((p) => (p as { value: string }).value).join('')
  }
  return null
}

const adfHandler: CommandHandler = {
  name: 'adf',
  summary: 'Invoke any tool by name with JSON input',
  helpText: [
    "adf <tool_name> ['<json>']   Invoke a tool directly with a JSON input object",
    '',
    'The generic tool-bus door: reaches tools that have no dedicated shell',
    'command (chat_info, fs_transfer, loop_compact, ...). Input is ONE JSON',
    "object argument — single-quote it: adf agent_discover '{\"scope\":\"all\"}'.",
    "Omitted input defaults to {}. Fetch a tool's schema first: config tools <name>.",
    '',
    'Rules (violations fail with the reason):',
    '- The tool name must be a literal — variables/substitutions are refused.',
    '- Top-level input keys starting with "_" are reserved for the runtime.',
    '- adf_shell cannot be invoked through adf (recursion) — run the command directly.',
  ].join('\n'),
  category: 'general',
  resolvedTools: [],

  resolveToolsFromArgs(args: ArgumentNode[]): string[] {
    const first = args[0]
    if (!first) return [] // no args → usage error at execute, nothing to gate
    const name = staticArgValue(first)
    if (name === null) {
      // Fail CLOSED: a dynamic tool name can't be gated statically, and adf
      // must never run an ungated name. Thrown (not returned) so the refusal
      // happens at the gate, before any variable/substitution resolves.
      throw new Error("adf: tool name must be a literal — write the tool name directly, e.g. adf chat_info '{}'")
    }
    if (name.startsWith('-')) return [] // -h/--help → help path, no tool
    return [name]
  },

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.flags.h !== undefined || ctx.flags.help !== undefined) return ok(adfHandler.helpText)
    if (ctx.args.length === 0) return err(adfHandler.helpText)

    // Input is ONE quoted JSON argument — anything else is a quoting mistake;
    // fail plainly rather than guessing how to reassemble it.
    const strayFlags = Object.keys(ctx.flags)
    if (strayFlags.length > 0) {
      return err(`adf: unexpected flag -${strayFlags[0].length > 1 ? '-' : ''}${strayFlags[0]} — pass tool input as ONE single-quoted JSON argument: adf <tool> '<json>'`)
    }
    if (ctx.args.length > 2) {
      return err("adf: expected at most one JSON argument — single-quote it so it stays one argument: adf <tool> '<json>'")
    }

    const tool = ctx.args[0]
    if (tool === 'adf_shell') {
      return err('adf: refusing to invoke adf_shell through adf (recursive shell) — run the command directly')
    }

    const raw = ctx.args[1] ?? '{}'
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch (e) {
      return err(`adf: invalid JSON input: ${e instanceof Error ? e.message : String(e)} — single-quote the JSON: adf ${tool} '{"key":"value"}'`)
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return err(`adf: input must be a JSON object, e.g. adf ${tool} '{"key":"value"}'`)
    }

    // Refuse runtime-reserved keys (see SECURITY MODEL above) — never call the
    // tool, never strip-and-continue.
    const reserved = Object.keys(input).filter((k) => k.startsWith('_'))
    if (reserved.length > 0) {
      return err(`adf: input key${reserved.length > 1 ? 's' : ''} ${reserved.map((k) => `"${k}"`).join(', ')} refused — underscore-prefixed params are runtime-injected privileges and cannot be passed from the shell`)
    }

    const result = await ctx.toolRegistry.executeTool(tool, input, ctx.workspace)
    if (result.isError) return err(`adf ${tool}: ${result.content}`)
    return ok(result.content)
  }
}

export const adfHandlers: CommandHandler[] = [adfHandler]
