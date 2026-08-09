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

/** Marker to retrieve the unwrapped registry from an authorizedRegistry Proxy,
 *  so a nested script re-wraps the TRUE base rather than inheriting the parent's
 *  wrapped registry (which would leak _authorized into an unauthorized child). */
const UNWRAP = Symbol('baseRegistry')

/** The unwrapped registry behind an authorizedRegistry Proxy (or the registry
 *  itself if it isn't wrapped). */
function baseRegistry(registry: ToolRegistry): ToolRegistry {
  return (registry as unknown as Record<symbol, ToolRegistry>)[UNWRAP] ?? registry
}

/** Wrap a registry so an authorized .sh script's DIRECT tool calls inject
 *  `_authorized: true` (bypassing file/table protection like the UI). Safe:
 *  shell handlers build tool inputs from parsed flags (never passthrough), so
 *  the agent cannot forge `_authorized` via a command flag; and delegating
 *  tools (sys_lambda/sys_code) are excluded so authorization does not leak into
 *  nested, agent-editable code files. */
function authorizedRegistry(registry: ToolRegistry): ToolRegistry {
  const base = baseRegistry(registry) // never double-wrap
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === UNWRAP) return target
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
    'node -p "<expr>"     Evaluate expression and print its value',
    '',
    'The code runs in a sandboxed environment with access to adf.* methods.',
    'Top-level await is supported in both -e code and -p expressions.',
  ].join('\n'),
  category: 'code',
  resolvedTools: ['sys_code'],
  valueFlags: new Set(['e', 'p']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // -e/-p flags consume the next arg as their value (declared in valueFlags)
    // Also handle the case where the flag parser consumed it as a string
    let code: string | undefined
    let printExpr = false
    if (typeof ctx.flags.p === 'string') {
      code = ctx.flags.p
      printExpr = true
    } else if (typeof ctx.flags.e === 'string') {
      code = ctx.flags.e
    } else if (ctx.args.length > 0) {
      // Fallback: if -e wasn't parsed correctly, join remaining args as code
      code = ctx.args.join(' ')
    }
    if (!code) return err('node: usage: node -e "<code>" or node -p "<expr>"')

    if (printExpr) {
      // node -p: evaluate the expression and print its value, like real node.
      // The sandbox wrapper is already async, so top-level await in the
      // expression works via the async-arrow indirection; the outer await
      // also unwraps a promise-valued expression before printing.
      code =
        'const __p_value = await (async () => (\n' + code + '\n))(); ' +
        'console.log(typeof __p_value === "string" ? __p_value : (JSON.stringify(__p_value, null, 2) ?? String(__p_value)))'
    }

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

/** Coerce a shell-flag string into the scalar a lambda most likely expects:
 *  integers/decimals → number, true/false → boolean, everything else stays a
 *  string. Kept deliberately conservative — no null/JSON parsing — so values
 *  like zip codes or ids don't silently change type. Use --args for exact JSON. */
function coerceArgValue(v: string | boolean): unknown {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  // Plain integer/decimal that round-trips exactly (avoids id/zip mangling from
  // leading zeros, +, exponents, or precision loss on huge numbers).
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) {
    const n = Number(v)
    if (Number.isFinite(n) && String(n) === v) return n
  }
  return v
}

/** Fold arbitrary `--key value` flags (everything except the reserved `--args`)
 *  into a plain args object, coercing scalars and preserving repeated flags as
 *  arrays. This is what lets `./job.ts run --count 3 --tag a --tag b` deliver
 *  { count: 3, tag: ['a','b'] } to the function. */
function flagsToArgs(flags: Record<string, string | boolean | string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(flags)) {
    if (key === 'args') continue // reserved for explicit JSON
    out[key] = Array.isArray(val) ? val.map(coerceArgValue) : coerceArgValue(val)
  }
  return out
}

const scriptHandler: CommandHandler = {
  name: './',
  summary: 'Execute VFS script or lambda',
  helpText: [
    './<path>                       Execute script, calls main()',
    './<path> <function>            Call specific function',
    './<path> <fn> --key value      Named args → { key: "value" } (repeat a flag → array)',
    './<path> <fn> --args \'{}\'      Exact JSON args (nested objects/arrays, precise types)',
    'echo "data" | ./<path>         Pass stdin as { stdin: "data" }',
    '',
    'Named --key flags are coerced: 3 → number, true/false → boolean, else string.',
    '--args (JSON) and --key flags merge; named flags win on key collision.',
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

    // Base args from explicit --args JSON (if any), then overlay named --key
    // flags. Named flags win on collision so a caller can tweak one key of a
    // JSON blob inline.
    let base: Record<string, unknown> = {}
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
      base = parsed as Record<string, unknown>
    }
    const named = flagsToArgs(ctx.flags)
    const merged = { ...base, ...named }

    if (Object.keys(merged).length > 0) {
      // Stdin (if piped) is exposed alongside named args unless overridden.
      input.args = ctx.stdin ? { stdin: ctx.stdin, ...merged } : merged
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
  // Wrap the UNWRAPPED base registry keyed on THIS script's own authorization —
  // never inherit the parent's wrapped registry, or an unauthorized child would
  // still get _authorized injected into its tool calls.
  const base = baseRegistry(ctx.toolRegistry)
  const toolRegistry = gate.authorized ? authorizedRegistry(base) : base

  const { parse } = await import('../parser/parser')
  const { executeNode, MAX_SHELL_DEPTH } = await import('../executor/pipeline-executor')
  const depth = (ctx.depth ?? 0) + 1
  if (depth > MAX_SHELL_DEPTH) {
    return err(`./${path}: script nesting too deep (${MAX_SHELL_DEPTH}) — possible infinite recursion`)
  }
  try {
    const ast = parse(source)
    return await executeNode(ast, ctx.stdin || '', {
      workspace: ctx.workspace,
      toolRegistry,
      config: ctx.config,
      env: ctx.env,
      gate,
      signal: ctx.signal, // forward abort so a cancelled shell stops the script
      depth,
    })
  } catch (e) {
    return err(`./${path}: parse error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export const codeHandlers: CommandHandler[] = [nodeHandler, scriptHandler]
