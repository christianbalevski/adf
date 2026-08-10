/**
 * Pipeline executor: walks AST, streams string buffers between stages.
 *
 * - ChainNode: recursive with &&/||/; semantics
 * - PipelineNode: each stage gets stdin string, produces stdout string
 * - Redirects: > → fs_write, >> → read+append+write, < → fs_read as initial stdin
 */

import type { ShellNode, PipelineNode, CommandNode, ArgumentNode, RedirectNode } from '../parser/ast'
import { classifyRedirectTarget, unsupportedDevTargetMessage } from '../parser/parser'
import type { CommandResult, CommandContext } from '../commands/types'
import { EXIT, err } from '../commands/types'
import type { AdfWorkspace } from '../../../adf/adf-workspace'
import type { ToolRegistry } from '../../tool-registry'
import type { AgentConfig } from '@shared/types/adf-v02.types'
import { resolveWithDefault, type EnvironmentResolver } from './environment'
import { parseBracedExpansion } from '../parser/tokenizer'
import { getCommand } from '../commands/index'
import type { McpClientManager } from '../../mcp/mcp-client-manager'
import { shellReadFile } from '../commands/fs-read-helper'
import { evaluateCommand, enforceToolGate, evaluateToolNames, notifyToolCallObservers } from './preflight'
import type { ShellGate } from '../commands/types'

/** Normalize a path for VFS: strip leading ./ and / */
function vfsPath(p: string): string {
  if (p === '.' || p === './' || p === '/') return ''
  return p.replace(/^\.\//, '').replace(/^\//, '')
}

export interface ExecutorContext {
  workspace: AdfWorkspace
  toolRegistry: ToolRegistry
  /** Config snapshot. Refreshed from getConfig (or gate.getConfig) before EACH
   *  command executes, so a mid-script `config set` (sys_update_config →
   *  onConfigChanged → provider update) is visible to later commands in the
   *  SAME invocation — the gate must never evaluate an invocation-start
   *  snapshot. */
  config: AgentConfig
  /** Live config source. When present, executeCommand re-reads it per command.
   *  Re-entry sites (scripts, xargs) rebuild the context from CommandContext
   *  and don't forward this field — they inherit freshness via gate.getConfig,
   *  which IS forwarded. */
  getConfig?: () => AgentConfig
  env: EnvironmentResolver
  mcpClientManager?: McpClientManager | null
  /** Abort signal for timeout/cancellation. Checked between pipeline stages. */
  signal?: AbortSignal
  /** Permission gate. When present, every command is checked before dispatch;
   *  this is the single choke point that gates scripts, xargs, $() and
   *  trigger/timer commands — not just the interactive ShellTool path. */
  gate?: ShellGate
  /** Re-entry nesting depth (scripts/xargs), to bound runaway recursion. */
  depth?: number
}

/** Max script/xargs re-entry depth before aborting (runaway-recursion guard). */
export const MAX_SHELL_DEPTH = 50

/**
 * Per-command permission check. Returns a blocking CommandResult (exit 126
 * disabled / 130 approval-denied or intercepted) or null to proceed.
 * Authorized scripts bypass disabled + approval (UI-equivalent privilege) but
 * still fire on_tool_call interception (that's an observer, not a permission).
 */
async function guardCommand(
  cmd: CommandNode,
  ctx: ExecutorContext
): Promise<{ blocked: CommandResult | null; observed: string[] }> {
  const gate = ctx.gate
  if (!gate) return { blocked: null, observed: [] }

  // The only permission boundary is the tools a command resolves to — there is
  // no separate command-name gate. Pure text/data commands (jq, sort, tr, ...)
  // resolve to no tools and run freely.
  const evalr = evaluateCommand(cmd, ctx.config)
  const blocked = await enforceToolGate(evalr, gate, ctx.config, gate.command ?? cmd.name)
  // on_tool_call matches are observers, fired by the caller AFTER the command
  // runs — a blocked command never ran, so it reports nothing.
  return { blocked, observed: blocked ? [] : evalr.intercepted }
}

/** Execute a parsed ShellNode */
export async function executeNode(
  node: ShellNode,
  stdin: string,
  ctx: ExecutorContext
): Promise<CommandResult> {
  // Check for abort between chain stages
  if (ctx.signal?.aborted) {
    return err('shell: aborted', 130)
  }

  if (node.kind === 'pipeline') {
    return executePipeline(node, stdin, ctx)
  }

  // ChainNode: the parser emits right-nested trees (`a && (b ; c)`), so
  // evaluating the tree recursively skips too much on failure — bash runs
  // `c` in `a && b ; c` even when `a` fails. Flatten to a sequence and
  // evaluate left-to-right with bash skip semantics: `&&` skips the next
  // pipeline when the last executed exit code is nonzero, `||` when zero,
  // `;` never skips. Exit code is the last executed pipeline's.
  const sequence: Array<{ op: '&&' | '||' | ';' | null; pipeline: PipelineNode }> = []
  {
    let op: '&&' | '||' | ';' | null = null
    let cur: ShellNode = node
    while (cur.kind === 'chain') {
      sequence.push({ op, pipeline: cur.left })
      op = cur.operator
      cur = cur.right
    }
    sequence.push({ op, pipeline: cur as PipelineNode })
  }

  const combine = (left: CommandResult, right: CommandResult): CommandResult => {
    const media = [...(left.media ?? []), ...(right.media ?? [])]
    // A turn-ending command anywhere in the chain ends the turn; the LAST
    // target state wins, mirroring repeated sys_set_state calls in one turn.
    const endTurn = left.end_turn || right.end_turn
    const targetState = right.target_state ?? left.target_state
    return {
      exit_code: right.exit_code,
      stdout: left.stdout && right.stdout
        ? left.stdout + '\n' + right.stdout
        : left.stdout || right.stdout,
      stderr: left.stderr && right.stderr
        ? left.stderr + '\n' + right.stderr
        : left.stderr || right.stderr,
      ...(media.length > 0 ? { media } : {}),
      ...(endTurn ? { end_turn: true } : {}),
      ...(targetState ? { target_state: targetState } : {}),
    }
  }

  let acc: CommandResult | null = null
  let lastExit = 0
  let nextStdin = stdin // only the first pipeline receives the incoming stdin
  for (const { op, pipeline } of sequence) {
    if (ctx.signal?.aborted) {
      return err('shell: aborted', 130)
    }
    if (op === '&&' && lastExit !== 0) continue
    if (op === '||' && lastExit === 0) continue
    const result = await executePipeline(pipeline, nextStdin, ctx)
    nextStdin = ''
    lastExit = result.exit_code
    acc = acc ? combine(acc, result) : result
  }
  return acc ?? { exit_code: 0, stdout: '', stderr: '' }
}

/** Execute a pipeline: stream buffers between stages */
async function executePipeline(
  pipeline: PipelineNode,
  initialStdin: string,
  ctx: ExecutorContext
): Promise<CommandResult> {
  if (pipeline.stages.length === 0) {
    return { exit_code: 0, stdout: '', stderr: '' }
  }

  let currentStdin = initialStdin
  let lastResult: CommandResult = { exit_code: 0, stdout: '', stderr: '' }
  const media: NonNullable<CommandResult['media']> = []
  // Side effects survive later stages: `state idle | tee log.txt` still ends
  // the turn even though tee's own result carries nothing.
  let endTurn = false
  let targetState: string | undefined
  const finish = (result: CommandResult): CommandResult => ({
    ...result,
    ...(media.length > 0 ? { media } : {}),
    ...(endTurn ? { end_turn: true } : {}),
    ...(targetState ? { target_state: targetState } : {}),
  })

  for (const cmd of pipeline.stages) {
    // Check for abort between pipeline stages
    if (ctx.signal?.aborted) {
      return err('shell: aborted', 130)
    }
    lastResult = await executeCommand(cmd, currentStdin, ctx)
    ctx.env.setLastExitCode(lastResult.exit_code) // $?
    if (lastResult.media) media.push(...lastResult.media)
    if (lastResult.end_turn) {
      endTurn = true
      targetState = lastResult.target_state ?? targetState
    }
    // Bash pipelines do NOT stop on a stage's ordinary nonzero exit — every
    // stage runs, data flows through, and the pipeline's status is the LAST
    // stage's. Only CONTROL-plane failures (gate denial 126/130, not-found
    // 127, timeout 124) halt the pipeline so their message surfaces. This keeps
    // idioms like `grep -c x | sed …` working while a failed grep still exits 1.
    //
    // Exception: when the stage EXPLICITLY routed its stderr away (2>&1 dup
    // into the pipe, 2>file, 2>/dev/null) the message cannot be lost by
    // continuing — the agent chose its destination — so bash semantics apply
    // and later stages run (each is gated on its own; the refused stage still
    // never executed). This is what lets `rm x 2>&1 | cat` deliver the gate
    // message through the pipe.
    if (PIPELINE_FATAL_CODES.has(lastResult.exit_code) && lastResult.stderr !== '') {
      return finish(lastResult)
    }
    currentStdin = lastResult.stdout
  }

  return finish(lastResult)
}

/** Exit codes that halt a pipeline (control-plane, not ordinary failure):
 *  124 timeout, 126 disabled, 127 command-not-found, 130 gate/interception. */
const PIPELINE_FATAL_CODES = new Set([124, 126, 127, 130])

/** Shell reserved words: control flow the parser doesn't support — fail with
 *  a clear message instead of "command not found". */
const RESERVED_CONTROL_WORDS = new Set([
  'for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi',
  'do', 'done', 'case', 'esac', 'select', 'function',
])

/** Execute a single command */
async function executeCommand(
  cmd: CommandNode,
  stdin: string,
  ctx: ExecutorContext
): Promise<CommandResult> {
  const name = cmd.name

  // Refresh config from the live provider before ANY per-command decision.
  // Within one adf_shell invocation, `config set ... && rm file` must see the
  // flipped flags on `rm`: sys_update_config's onConfigChanged fan-out has
  // already updated the provider by the time the next command runs, so reading
  // the invocation-start snapshot here made the gate lie (exit 126 on tools
  // the agent just enabled). gate.getConfig is the fallback because scripts
  // and xargs rebuild the context but forward the gate.
  const liveConfig = ctx.getConfig ?? ctx.gate?.getConfig
  if (liveConfig) {
    ctx = { ...ctx, config: liveConfig() }
  }

  // Reserved control-flow words in command position: honest error, exit 2
  if (RESERVED_CONTROL_WORDS.has(name)) {
    return err(`${name}: control flow is not supported in adf_shell — use xargs, or a .js script for loops`, 2)
  }

  // Help short-circuits BEFORE the permission gate: printing usage is
  // harmless and must work even when the command's tools are disabled.
  // Only a LITERAL first arg qualifies — variables/substitutions would need
  // pre-gate resolution, which must never happen.
  const firstArg = cmd.args[0]
  if (firstArg?.type === 'literal' && (firstArg.value === '-h' || firstArg.value === '--help')) {
    const helpHandler = getCommand(name)
    if (helpHandler) {
      return { exit_code: 0, stdout: helpHandler.helpText, stderr: '' }
    }
  }

  // Permission gate — the single choke point for disabled/HIL/on_tool_call.
  // Runs before arg resolution, so a denied outer command never triggers its
  // $() substitutions; allowed substitutions recurse here and are gated too.
  // A refusal still flows through the command's redirect machinery (with
  // strict no-side-effect target resolution) so scripts can capture WHY the
  // command was refused — see applyGateFailureRedirects.
  const { blocked, observed } = await guardCommand(cmd, ctx)
  if (blocked) return applyGateFailureRedirects(blocked, cmd, ctx)

  /** Notify on_tool_call observers once the command has actually run. */
  const observe = (result: CommandResult): CommandResult => {
    if (observed.length > 0 && ctx.gate) {
      notifyToolCallObservers(observed, ctx.gate, ctx.config, ctx.gate.command ?? cmd.name)
    }
    return result
  }

  // Prefix assignments: VAR=val cmd → command-scoped env overlay; a bare
  // assignment (no command) sets the session variable. Resolved AFTER the
  // gate so a denied command never runs its assignment substitutions.
  if (cmd.assignments?.length) {
    const vars: Record<string, string> = {}
    for (const a of cmd.assignments) {
      const parts = await Promise.all(a.value.map(p => resolveArg(p, ctx)))
      vars[a.name] = parts.join('')
    }
    if (!name) {
      for (const [k, v] of Object.entries(vars)) ctx.env.export(k, v)
      return { exit_code: 0, stdout: '', stderr: '' }
    }
    ctx = { ...ctx, env: ctx.env.withOverlay(vars) }
  }

  // Resolve redirect targets (after the gate — a denied command never runs
  // its target's $() substitutions). Runtime-resolved targets get the same
  // special-device treatment as static ones: /dev/null discards, and
  // /dev/stdout|stderr fail plainly BEFORE the command runs — never a VFS
  // file named after a device. Everything else keeps its resolved path.
  const redirects: RedirectNode[] = []
  for (const r of cmd.redirects) {
    if (r.type === 'dup' || r.type === 'discard') {
      redirects.push(r)
      continue
    }
    let target = r.target
    if (target === undefined && r.targetNode) {
      target = await resolveArg(r.targetNode, ctx)
    }
    if (target === undefined) continue // parser guarantees a target; defensive
    const special = classifyRedirectTarget(target)
    if (special === 'null') {
      redirects.push({ type: 'discard', fd: r.type === 'in' ? 0 : r.fd ?? 1 })
      continue
    }
    if (special) {
      return err(`${name}: ${unsupportedDevTargetMessage(special)}`, 2)
    }
    redirects.push({ ...r, target })
  }

  // Handle input redirects: < file → read file as stdin; < /dev/null → empty
  for (const r of redirects) {
    if (r.type === 'in' && r.target !== undefined) {
      const [redirectContent, redirectErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(r.target))
      if (redirectErr) {
        return err(`${name}: ${redirectErr}`)
      }
      stdin = redirectContent
    }
    if (r.type === 'discard' && r.fd === 0) {
      stdin = ''
    }
  }

  // Handle heredoc as stdin. Unquoted delimiters expand $VAR like bash;
  // quoted delimiters (<<'EOF') keep the body literal.
  if (cmd.heredoc) {
    stdin = cmd.heredoc.quoted
      ? cmd.heredoc.content
      : expandHeredocVars(cmd.heredoc.content, ctx.env)
  }

  // Resolve arguments
  const resolvedArgs = await resolveArgs(cmd.args, ctx)

  // Check for help flag (post-resolution — covers `cmd $FLAG` where FLAG=-h)
  if (resolvedArgs.length > 0 && (resolvedArgs[0] === '-h' || resolvedArgs[0] === '--help')) {
    const handler = getCommand(name)
    if (handler) {
      return { exit_code: 0, stdout: handler.helpText, stderr: '' }
    }
  }

  // Special: echo command (builtin, not dispatched to tool)
  if (name === 'echo') {
    // Check for -e flag (interpret escape sequences) and -n flag (no trailing newline)
    let args = resolvedArgs
    let interpretEscapes = false
    let noTrailingNewline = false
    // Strip -e and -n flags from the start of args
    while (args.length > 0 && (args[0] === '-e' || args[0] === '-n' || args[0] === '-en' || args[0] === '-ne')) {
      if (args[0].includes('e')) interpretEscapes = true
      if (args[0].includes('n')) noTrailingNewline = true
      args = args.slice(1)
    }
    let output = args.join(' ')
    if (interpretEscapes) {
      output = output
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\')
    }
    if (!noTrailingNewline) output += '\n'
    return observe(await applyRedirects({ exit_code: 0, stdout: output, stderr: '' }, redirects, ctx))
  }

  // Special: ./ scripts — route to code handler
  if (name.startsWith('./') || name.startsWith('/')) {
    const handler = getCommand('./')
    if (handler) {
      const cmdCtx = buildCommandContext([name, ...resolvedArgs], stdin, ctx, handler.valueFlags)
      const result = await handler.execute(cmdCtx)
      return observe(await applyRedirects(result, redirects, ctx))
    }
    return err(`${name}: command not found`, EXIT.NOT_FOUND)
  }

  // Look up command handler
  const handler = getCommand(name)
  if (!handler) {
    return err(`${name}: command not found`, EXIT.NOT_FOUND)
  }

  // Parse flags from resolved args
  const cmdCtx = buildCommandContext(resolvedArgs, stdin, ctx, handler.valueFlags)

  // Execute
  const result = await handler.execute(cmdCtx)

  // Apply output redirects
  return observe(await applyRedirects(result, redirects, ctx))
}

/** Resolve argument nodes to string values. Unquoted literals containing
 *  glob characters expand against the VFS (possibly into several args). */
async function resolveArgs(
  args: ArgumentNode[],
  ctx: ExecutorContext
): Promise<string[]> {
  const result: string[] = []

  for (const arg of args) {
    if (arg.type === 'literal' && hasGlobChars(arg.value)) {
      result.push(...expandGlob(arg.value, ctx))
      continue
    }
    result.push(await resolveArg(arg, ctx))
  }

  return result
}

/** Resolve a single argument node */
async function resolveArg(
  arg: ArgumentNode,
  ctx: ExecutorContext
): Promise<string> {
  switch (arg.type) {
    case 'literal':
      return arg.value

    case 'variable':
      return resolveWithDefault(ctx.env, arg.name, arg.op, arg.word)

    case 'substitution': {
      const result = await executePipeline(arg.pipeline, '', ctx)
      return result.stdout.replace(/\n$/, '') // strip trailing newline like bash
    }

    case 'quoted': {
      const parts = await Promise.all(arg.parts.map(p => resolveArg(p, ctx)))
      return parts.join('')
    }
  }
}

/** Expand $VAR / ${VAR} / ${VAR:-def} / $? in an unquoted-delimiter heredoc
 *  body (bash expands unless the tag was quoted: <<'EOF'). Command
 *  substitution inside heredocs is not expanded. */
function expandHeredocVars(content: string, env: EnvironmentResolver): string {
  return content.replace(
    /\\\$|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\?/g,
    (m, braced, name) => {
      if (m === '\\$') return '$'
      if (m === '$?') return env.resolve('?')
      if (braced !== undefined) {
        const exp = parseBracedExpansion(braced)
        return resolveWithDefault(env, exp.name, exp.op, exp.word)
      }
      return env.resolve(name)
    }
  )
}

// --- Glob expansion ---

/** Unquoted words containing these need glob expansion */
function hasGlobChars(s: string): boolean {
  return /[*?]/.test(s) || /\[.+\]/.test(s)
}

/** Convert a glob pattern to a RegExp. `*` and `?` never cross `/`
 *  (segment-wise like bash); [...] classes supported ([!...] negates). */
function globToRegExp(pattern: string): RegExp {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      // find the closing ] (a ] right after [ or [! is literal)
      let j = i + 1
      if (pattern[j] === '!' || pattern[j] === '^') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) {
        re += '\\[' // unmatched [ is literal
        continue
      }
      let cls = pattern.slice(i + 1, j)
      if (cls.startsWith('!')) cls = '^' + cls.slice(1)
      re += '[' + cls.replace(/\\/g, '\\\\') + ']'
      i = j
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
  }
  return new RegExp(re + '$')
}

/** Expand a glob pattern against workspace file paths (plus implicit
 *  directory prefixes, so `du imported/*` sees subdirectories). No match →
 *  the literal pattern passes through (bash default, not nullglob). */
function expandGlob(pattern: string, ctx: ExecutorContext): string[] {
  if (typeof ctx.workspace.listFiles !== 'function') return [pattern]
  let paths: string[]
  try {
    paths = ctx.workspace.listFiles().map(f => f.path)
  } catch {
    return [pattern]
  }
  const candidates = new Set<string>()
  for (const p of paths) {
    candidates.add(p)
    // implicit directories: a/b/c.txt → a, a/b
    let idx = p.indexOf('/')
    while (idx !== -1) {
      candidates.add(p.slice(0, idx))
      idx = p.indexOf('/', idx + 1)
    }
  }
  const regex = globToRegExp(vfsPath(pattern))
  const matches = [...candidates]
    .filter(c => regex.test(c))
    .sort()
    // A matched file named like a flag (-x) must not be parsed as one, nor
    // skew arg-based tool resolution — prefix ./ like bash users do manually
    // (vfsPath strips it again before any file access).
    .map(m => (m.startsWith('-') ? './' + m : m))
  return matches.length > 0 ? matches : [pattern]
}

/** Parse positional args and flags from resolved string args.
 *  Single-char flags are boolean by default. Only flags listed in
 *  valueFlags consume the next arg as their value. Long flags (--foo)
 *  always consume the next non-flag arg as their value. */
function buildCommandContext(
  resolvedArgs: string[],
  stdin: string,
  ctx: ExecutorContext,
  valueFlags?: Set<string>
): CommandContext {
  const args: string[] = []
  const flags: Record<string, string | boolean | string[]> = {}

  let i = 0
  while (i < resolvedArgs.length) {
    const a = resolvedArgs[i]
    if (a === '--') {
      // Everything after -- is positional
      for (let j = i + 1; j < resolvedArgs.length; j++) {
        args.push(resolvedArgs[j])
      }
      break
    } else if (a.startsWith('--')) {
      let key = a.slice(2)
      // Handle --key=value format (e.g., --include=*.md)
      const eqIdx = key.indexOf('=')
      if (eqIdx !== -1) {
        const eqVal = key.slice(eqIdx + 1)
        key = key.slice(0, eqIdx)
        if (eqVal) {
          // --key=value in one arg
          flags[key] = eqVal
          i++
        } else {
          // --key= with empty value, consume next arg
          if (i + 1 < resolvedArgs.length && !resolvedArgs[i + 1].startsWith('-')) {
            flags[key] = resolvedArgs[i + 1]
            i += 2
          } else {
            flags[key] = true
            i++
          }
        }
      } else if (i + 1 < resolvedArgs.length && !resolvedArgs[i + 1].startsWith('-')) {
        // Long flags: consume next non-flag arg as value
        const val = resolvedArgs[i + 1]
        // Support repeated flags as arrays
        const existing = flags[key]
        if (existing !== undefined) {
          if (Array.isArray(existing)) {
            existing.push(val)
          } else if (typeof existing === 'string') {
            flags[key] = [existing, val]
          }
        } else {
          flags[key] = val
        }
        i += 2
      } else {
        flags[key] = true
        i++
      }
    } else if (a.startsWith('-') && a.length >= 2 && a[1] !== '-') {
      if (a.length === 2) {
        const key = a.slice(1)
        // Single short flag: boolean unless declared as value-taking
        if (valueFlags?.has(key) && i + 1 < resolvedArgs.length && !resolvedArgs[i + 1].startsWith('-')) {
          const val = resolvedArgs[i + 1]
          const existing = flags[key]
          if (existing !== undefined) {
            if (Array.isArray(existing)) {
              existing.push(val)
            } else if (typeof existing === 'string') {
              flags[key] = [existing, val]
            }
          } else {
            flags[key] = val
          }
          i += 2
        } else {
          flags[key] = true
          i++
        }
      } else if (valueFlags?.has(a[1])) {
        // Attached value on a value-taking short flag: -A2 → A=2, -d',' → d=','
        flags[a[1]] = a.slice(2)
        i++
      } else {
        // Combined short flags: -la → -l -a (all boolean)
        for (let c = 1; c < a.length; c++) {
          flags[a[c]] = true
        }
        i++
      }
    } else {
      args.push(a)
      i++
    }
  }

  return {
    stdin,
    args,
    flags,
    rawArgs: resolvedArgs,
    workspace: ctx.workspace,
    toolRegistry: ctx.toolRegistry,
    config: ctx.config,
    env: ctx.env,
    gate: ctx.gate,
    authorized: ctx.gate?.authorized,
    signal: ctx.signal,
    depth: ctx.depth,
  }
}

/** Resolve a redirect-target node WITHOUT side effects: literals, plain
 *  variables (incl. ${VAR:-def} — the default word is a literal string), and
 *  quoted compositions of those. Command substitutions return null — running
 *  one for a REFUSED command would execute arbitrary commands pre-gate. */
function staticResolveTarget(node: ArgumentNode, env: EnvironmentResolver): string | null {
  switch (node.type) {
    case 'literal':
      return node.value
    case 'variable':
      return resolveWithDefault(env, node.name, node.op, node.word)
    case 'quoted': {
      let out = ''
      for (const p of node.parts) {
        const s = staticResolveTarget(p, env)
        if (s === null) return null
        out += s
      }
      return out
    }
    case 'substitution':
      return null
  }
}

/**
 * Route a gate refusal (disabled 126 / approval-denied or intercepted 130)
 * through the SAME redirect machinery as ordinary command output, so a script
 * can capture WHY a command was refused (`rm x 2>err.txt`, `rm x 2>&1 | cat`)
 * instead of only seeing $?=126.
 *
 * Redirect-opened rule (matches bash, and matches `false 2>f` here): file
 * redirects are OPENED — created/truncated via fs_write — even though the
 * command itself never ran. A gate-126 with `2>f` creates f containing the
 * gate message; with `>f` it creates f empty. One rule for every failure mode.
 *
 * Safety constraints — the command was REFUSED, so nothing gated may run:
 * - Targets are resolved statically only (literals/variables); a target
 *   containing a command substitution is NOT resolved (that would execute
 *   commands on behalf of a denied stage) — the redirect is dropped, the
 *   message stays on the envelope stderr, and a note says so.
 * - Honoring `>`/`2>` needs fs_write. Preflight lists redirect-implied
 *   fs_write in the command's resolved tools, so the write is gated
 *   separately from the refused tool: if fs_write is itself disabled / needs
 *   approval / is intercepted (and the run is not an authorized script), the
 *   file redirects are dropped and the message falls back to the envelope
 *   stderr — never silently lost, never written through a closed gate.
 * - `< file` input redirects are skipped entirely (nothing consumes stdin,
 *   and resolving them would invoke fs_read for a refused command).
 * - `2>/dev/null` still discards the message — deliberate discard is the
 *   agent's contract, same as for any other command.
 */
async function applyGateFailureRedirects(
  blocked: CommandResult,
  cmd: CommandNode,
  ctx: ExecutorContext,
): Promise<CommandResult> {
  if (cmd.redirects.length === 0) return blocked

  const notes: string[] = []
  const redirects: RedirectNode[] = []
  for (const r of cmd.redirects) {
    if (r.type === 'in') continue
    if (r.type === 'dup' || r.type === 'discard') {
      redirects.push(r)
      continue
    }
    let target = r.target
    if (target === undefined && r.targetNode) {
      const resolved = staticResolveTarget(r.targetNode, ctx.env)
      if (resolved === null) {
        notes.push('adf_shell: note: redirect target with command substitution was not resolved for the refused command; error kept on stderr')
        continue
      }
      target = resolved
    }
    if (target === undefined) continue
    const special = classifyRedirectTarget(target)
    if (special === 'null') {
      redirects.push({ type: 'discard', fd: r.fd ?? 1 })
      continue
    }
    if (special) {
      // /dev/stdout|stderr is unsupported — but don't mask the gate exit code
      // with a fresh error; keep the message on the envelope stderr.
      notes.push(`adf_shell: note: ${unsupportedDevTargetMessage(special)}; error kept on stderr`)
      continue
    }
    redirects.push({ ...r, target })
  }

  // File redirects require fs_write, gated separately from the refused tool.
  const isFileRedirect = (r: RedirectNode) =>
    (r.type === 'out' || r.type === 'append') && r.target !== undefined
  let observeWrite: string[] = []
  if (redirects.some(isFileRedirect) && !ctx.gate?.authorized) {
    const ev = Array.isArray(ctx.config.tools)
      ? evaluateToolNames(['fs_write'], ctx.config)
      : { disabled: [], approvalRequired: [], intercepted: [], resolvedTools: [] }
    // Only PERMISSIONS drop the redirect. An on_tool_call match on fs_write is
    // an observer, not a gate — dropping the write for it would silently lose
    // the very message this path exists to preserve.
    if (ev.disabled.length > 0 || ev.approvalRequired.length > 0) {
      for (let i = redirects.length - 1; i >= 0; i--) {
        if (isFileRedirect(redirects[i])) redirects.splice(i, 1)
      }
      notes.push('adf_shell: note: file redirect not honored (fs_write is not permitted); error kept on stderr')
    } else {
      observeWrite = ev.intercepted
    }
  }

  // Notes are appended AFTER the redirects run so they land on the envelope
  // stderr (they explain why something was NOT captured — capturing them
  // would defeat the point).
  const res = await applyRedirects(blocked, redirects, ctx)
  if (observeWrite.length > 0 && ctx.gate) {
    notifyToolCallObservers(observeWrite, ctx.gate, ctx.config, ctx.gate.command ?? cmd.name)
  }
  if (notes.length === 0) return res
  const noteText = notes.join('\n')
  return { ...res, stderr: res.stderr ? `${res.stderr}\n${noteText}` : noteText }
}

/** Apply output redirects: dup (2>&1), discard (/dev/null), > file, >> file.
 *  Takes the RESOLVED redirect list built in executeCommand (targets are
 *  plain strings; special devices already converted to discard or rejected). */
async function applyRedirects(
  result: CommandResult,
  redirects: RedirectNode[],
  ctx: ExecutorContext
): Promise<CommandResult> {
  let res = result

  // fd duplication first: `2>&1` means "stderr goes where stdout goes", so
  // the merge must happen before a file redirect captures the stream — this
  // makes both `cmd 2>&1 | head` and `cmd > f 2>&1` behave.
  for (const r of redirects) {
    if (r.type !== 'dup') continue
    if (r.fd === 2 && r.targetFd === 1) {
      const sep = res.stdout && !res.stdout.endsWith('\n') && res.stderr ? '\n' : ''
      res = { ...res, stdout: res.stdout + sep + res.stderr, stderr: '' }
    } else if (r.fd === 1 && r.targetFd === 2) {
      const sep = res.stderr && !res.stderr.endsWith('\n') && res.stdout ? '\n' : ''
      res = { ...res, stderr: res.stderr + sep + res.stdout, stdout: '' }
    }
    // other fd pairs (3>&1, 2>&2, ...): no backing fd table — no-op
  }

  for (const r of redirects) {
    if (r.type === 'discard') {
      // /dev/null — drop the stream (fd 0 is handled pre-execution)
      if (r.fd === 2) res = { ...res, stderr: '' }
      else if (r.fd !== 0) res = { ...res, stdout: '' }
      continue
    }
    if ((r.type === 'out' || r.type === 'append') && r.target !== undefined) {
      // Atomic append: fs_write append mode does the read-modify-write under
      // the per-file lock, so `>>` can't clobber a concurrent edit.
      const content = r.fd === 2 ? res.stderr : res.stdout
      await ctx.toolRegistry.executeTool('fs_write', {
        mode: r.type === 'append' ? 'append' : 'write',
        path: vfsPath(r.target),
        content
      }, ctx.workspace)
      res = r.fd === 2 ? { ...res, stderr: '' } : { ...res, stdout: '' }
    }
  }
  return res
}
