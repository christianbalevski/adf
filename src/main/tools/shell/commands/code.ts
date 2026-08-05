/**
 * Code execution commands: node -e, ./<script>, .sh scripts
 */

import type { CommandHandler, CommandContext, CommandResult, ShellGate } from './types'
import { ok, err } from './types'
import { shellReadFile } from './fs-read-helper'
import type { ToolRegistry } from '../../tool-registry'

/** Tools that run OTHER agent-editable code files, each of which governs its
 *  own authorization. An authorized .sh must NOT inject _authorized into these
 *  — otherwise it becomes a channel to run arbitrary (freely-rewritable) child
 *  code with the parent's privilege. They re-derive auth from their own source. */
const CODE_DELEGATING_TOOLS = new Set(['sys_lambda', 'sys_code', 'sys_create_adf'])

/** Wrap a registry so an authorized .sh script's DIRECT tool calls inject
 *  `_authorized: true` (bypassing file/table protection like the UI). Safe:
 *  shell handlers build tool inputs from parsed flags (never passthrough), so
 *  the agent cannot forge `_authorized` via a command flag; and delegating
 *  tools (sys_lambda/sys_code) are excluded so authorization does not leak into
 *  nested, agent-editable code files. */
function authorizedRegistry(registry: ToolRegistry): ToolRegistry {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === 'executeTool') {
        return (name: string, input: unknown, ws: unknown) => {
          const injected = CODE_DELEGATING_TOOLS.has(name)
            ? (input as Record<string, unknown>)
            : { ...((input as Record<string, unknown>) ?? {}), _authorized: true }
          return (target.executeTool as (...a: unknown[]) => unknown)(name, injected, ws)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

const nodeHandler: CommandHandler = {
  name: 'node',
  summary: 'Execute inline JavaScript/TypeScript',
  helpText: [
    'node -e "<code>"     Execute inline code via sys_code',
    '',
    'The code runs in a sandboxed environment with access to adf.* methods.',
  ].join('\n'),
  category: 'code',
  resolvedTools: ['sys_code'],
  valueFlags: new Set(['e']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // -e flag consumes the next arg as its value (declared in valueFlags)
    // Also handle the case where the flag parser consumed it as a string
    let code: string | undefined
    if (typeof ctx.flags.e === 'string') {
      code = ctx.flags.e
    } else if (ctx.args.length > 0) {
      // Fallback: if -e wasn't parsed correctly, join remaining args as code
      code = ctx.args.join(' ')
    }
    if (!code) return err('node: usage: node -e "<code>"')

    // Inject agent environment variables into process.env so code can
    // access $AGENT_NAME etc. via process.env.AGENT_NAME
    const envVars = ctx.env.listAll()
    if (envVars.length > 0) {
      const assignments = envVars
        .map(v => `process.env[${JSON.stringify(v.key)}] = ${JSON.stringify(v.value)};`)
        .join(' ')
      code = assignments + ' ' + code
    }

    const result = await ctx.toolRegistry.executeTool('sys_code', { code }, ctx.workspace)
    if (result.isError) return err(`node: ${result.content}`)
    return ok(result.content)
  }
}

const scriptHandler: CommandHandler = {
  name: './',
  summary: 'Execute VFS script or lambda',
  helpText: [
    './<path>                    Execute script, calls main()',
    './<path> <function>         Call specific function',
    './<path> <fn> --args \'{}\'   Call with JSON args',
    'echo "data" | ./<path>      Pass stdin as first argument',
    '',
    '.sh files: parsed as one script — heredocs and multi-line chains work;',
    '           bash-like: failures do not stop the script unless chained with &&',
    '.ts/.js files: dispatch to sys_lambda',
  ].join('\n'),
  category: 'code',
  resolvedTools: ['sys_lambda'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // The script path comes as the first arg (pipeline-executor puts the
    // full command name including ./ as args[0])
    const scriptPath = ctx.args[0]
    if (!scriptPath) return err('./: missing script path')

    // Normalize path
    const path = scriptPath.startsWith('./') ? scriptPath.slice(2) : scriptPath

    // Handle .sh files: read and execute line-by-line
    if (path.endsWith('.sh')) {
      return executeShellScript(path, ctx)
    }

    // TypeScript/JavaScript: use sys_lambda. Its schema wants { source, args }
    // where source is "path[:function]" and args is an OBJECT (not an array).
    const fnName = ctx.args[1]
    const argsStr = ctx.flags.args as string | undefined

    const input: Record<string, unknown> = { source: fnName ? `${path}:${fnName}` : path }
    if (argsStr) {
      let parsed: unknown
      try {
        parsed = JSON.parse(argsStr)
      } catch {
        return err(`./: invalid JSON args: ${argsStr}`)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return err(`./: --args must be a JSON object, e.g. --args '{"key":"value"}'`)
      }
      input.args = parsed
    } else if (ctx.stdin) {
      // Piped stdin is delivered to the function as { stdin: "<data>" }.
      input.args = { stdin: ctx.stdin }
    }

    const result = await ctx.toolRegistry.executeTool('sys_lambda', input, ctx.workspace)
    if (result.isError) return err(`./${path}: ${result.content}`)
    return ok(result.content)
  }
}

/** Execute a .sh file: whole-file parse (newlines separate commands like `;`,
 *  so heredocs, comments, and && chains all work — bash-like semantics: a
 *  failing command does NOT stop the script unless chained with &&). */
async function executeShellScript(path: string, ctx: CommandContext): Promise<CommandResult> {
  const [scriptContent, readErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, path)
  if (readErr !== null) return err(`./${path}: ${readErr}`)

  // Strip shebang; the tokenizer treats remaining # lines as comments
  const source = scriptContent.replace(/^#![^\n]*\n?/, '')

  // A .sh script inherits the caller's gate so its commands stay gated (this
  // is what closed the ungated-script bypass). If the script FILE is
  // authorized (a human authorized it, same as a .ts lambda), its commands
  // bypass disabled/HIL and protection — authorized:true + _authorized on
  // tool calls. Writing to the file deauthorizes it (adf_files.authorized=0).
  // Authorization is per-FILE: a script is authorized only if its own file is
  // authorized — it does NOT inherit the caller's authorization. Otherwise an
  // authorized launcher could run arbitrary agent-rewritable child scripts with
  // its privilege. (Writing a file deauthorizes it, so this is fail-safe.)
  let authorized = false
  try { authorized = ctx.workspace.isFileAuthorized(path) } catch { /* default false */ }
  const gate: ShellGate = { ...(ctx.gate ?? {}), authorized }
  const toolRegistry = gate.authorized ? authorizedRegistry(ctx.toolRegistry) : ctx.toolRegistry

  const { parse } = await import('../parser/parser')
  const { executeNode } = await import('../executor/pipeline-executor')
  try {
    const ast = parse(source)
    return await executeNode(ast, ctx.stdin || '', {
      workspace: ctx.workspace,
      toolRegistry,
      config: ctx.config,
      env: ctx.env,
      gate,
    })
  } catch (e) {
    return err(`./${path}: parse error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export const codeHandlers: CommandHandler[] = [nodeHandler, scriptHandler]
