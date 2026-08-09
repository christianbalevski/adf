/**
 * Pipeline executor: walks AST, streams string buffers between stages.
 *
 * - ChainNode: recursive with &&/||/; semantics
 * - PipelineNode: each stage gets stdin string, produces stdout string
 * - Redirects: > → fs_write, >> → read+append+write, < → fs_read as initial stdin
 */

import type { ShellNode, PipelineNode, CommandNode, ArgumentNode } from '../parser/ast'
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
import { evaluateCommand, enforceToolGate } from './preflight'
import type { ShellGate } from '../commands/types'

/** Normalize a path for VFS: strip leading ./ and / */
function vfsPath(p: string): string {
  if (p === '.' || p === './' || p === '/') return ''
  return p.replace(/^\.\//, '').replace(/^\//, '')
}

export interface ExecutorContext {
  workspace: AdfWorkspace
  toolRegistry: ToolRegistry
  config: AgentConfig
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
async function guardCommand(cmd: CommandNode, ctx: ExecutorContext): Promise<CommandResult | null> {
  const gate = ctx.gate
  if (!gate) return null

  // The only permission boundary is the tools a command resolves to — there is
  // no separate command-name gate. Pure text/data commands (jq, sort, tr, ...)
  // resolve to no tools and run freely.
  const evalr = evaluateCommand(cmd, ctx.config)
  return enforceToolGate(evalr, gate, ctx.config, ctx.workspace, gate.command ?? cmd.name)
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
  let backgroundRequested = false
  {
    let op: '&&' | '||' | ';' | null = null
    let cur: ShellNode = node
    while (cur.kind === 'chain') {
      if (cur.background) backgroundRequested = true
      sequence.push({ op, pipeline: cur.left })
      op = cur.operator
      cur = cur.right
    }
    sequence.push({ op, pipeline: cur as PipelineNode })
  }

  const combine = (left: CommandResult, right: CommandResult): CommandResult => {
    const media = [...(left.media ?? []), ...(right.media ?? [])]
    return {
      exit_code: right.exit_code,
      stdout: left.stdout && right.stdout
        ? left.stdout + '\n' + right.stdout
        : left.stdout || right.stdout,
      stderr: left.stderr && right.stderr
        ? left.stderr + '\n' + right.stderr
        : left.stderr || right.stderr,
      ...(media.length > 0 ? { media } : {}),
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
  const final = acc ?? { exit_code: 0, stdout: '', stderr: '' }
  if (backgroundRequested) {
    const note = 'note: background execution (&) is not supported; commands ran sequentially'
    return { ...final, stderr: final.stderr ? note + '\n' + final.stderr : note }
  }
  return final
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

  for (const cmd of pipeline.stages) {
    // Check for abort between pipeline stages
    if (ctx.signal?.aborted) {
      return err('shell: aborted', 130)
    }
    lastResult = await executeCommand(cmd, currentStdin, ctx)
    ctx.env.setLastExitCode(lastResult.exit_code) // $?
    if (lastResult.media) media.push(...lastResult.media)
    // Bash pipelines do NOT stop on a stage's ordinary nonzero exit — every
    // stage runs, data flows through, and the pipeline's status is the LAST
    // stage's. Only CONTROL-plane failures (gate denial 126/130, not-found
    // 127, timeout 124) halt the pipeline so their message surfaces. This keeps
    // idioms like `grep -c x | sed …` working while a failed grep still exits 1.
    if (PIPELINE_FATAL_CODES.has(lastResult.exit_code)) {
      return media.length > 0 ? { ...lastResult, media } : lastResult
    }
    currentStdin = lastResult.stdout
  }

  return media.length > 0 ? { ...lastResult, media } : lastResult
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
  const blocked = await guardCommand(cmd, ctx)
  if (blocked) return blocked

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

  // Handle input redirects: < file → read file as stdin; < /dev/null → empty
  for (const r of cmd.redirects) {
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
    return applyRedirects({ exit_code: 0, stdout: output, stderr: '' }, cmd, ctx)
  }

  // Special: ./ scripts — route to code handler
  if (name.startsWith('./') || name.startsWith('/')) {
    const handler = getCommand('./')
    if (handler) {
      const cmdCtx = buildCommandContext([name, ...resolvedArgs], stdin, ctx, handler.valueFlags)
      const result = await handler.execute(cmdCtx)
      return applyRedirects(result, cmd, ctx)
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
  return applyRedirects(result, cmd, ctx)
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

/** Apply output redirects: dup (2>&1), discard (/dev/null), > file, >> file */
async function applyRedirects(
  result: CommandResult,
  cmd: CommandNode,
  ctx: ExecutorContext
): Promise<CommandResult> {
  let res = result

  // fd duplication first: `2>&1` means "stderr goes where stdout goes", so
  // the merge must happen before a file redirect captures the stream — this
  // makes both `cmd 2>&1 | head` and `cmd > f 2>&1` behave.
  for (const r of cmd.redirects) {
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

  for (const r of cmd.redirects) {
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
