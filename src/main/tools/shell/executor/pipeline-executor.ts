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
import type { EnvironmentResolver } from './environment'
import { getCommand } from '../commands/index'
import type { McpClientManager } from '../../mcp/mcp-client-manager'
import { shellReadFile } from '../commands/fs-read-helper'

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

  // ChainNode: accumulate stdout across chained commands (like real bash)
  const leftResult = await executePipeline(node.left, stdin, ctx)

  const combine = (left: CommandResult, right: CommandResult): CommandResult => ({
    exit_code: right.exit_code,
    stdout: left.stdout && right.stdout
      ? left.stdout + '\n' + right.stdout
      : left.stdout || right.stdout,
    stderr: left.stderr && right.stderr
      ? left.stderr + '\n' + right.stderr
      : left.stderr || right.stderr,
  })

  switch (node.operator) {
    case '&&':
      if (leftResult.exit_code === 0) {
        const rightResult = await executeNode(node.right, '', ctx)
        return combine(leftResult, rightResult)
      }
      return leftResult

    case '||':
      if (leftResult.exit_code !== 0) {
        const rightResult = await executeNode(node.right, '', ctx)
        return combine(leftResult, rightResult)
      }
      return leftResult

    case ';': {
      const rightResult = await executeNode(node.right, '', ctx)
      return combine(leftResult, rightResult)
    }

    default:
      return leftResult
  }
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

  for (const cmd of pipeline.stages) {
    // Check for abort between pipeline stages
    if (ctx.signal?.aborted) {
      return err('shell: aborted', 130)
    }
    lastResult = await executeCommand(cmd, currentStdin, ctx)
    if (lastResult.exit_code !== 0) {
      return lastResult
    }
    currentStdin = lastResult.stdout
  }

  return lastResult
}

/** Execute a single command */
async function executeCommand(
  cmd: CommandNode,
  stdin: string,
  ctx: ExecutorContext
): Promise<CommandResult> {
  const name = cmd.name

  // Handle input redirect: < file → read file as stdin
  for (const r of cmd.redirects) {
    if (r.type === 'in') {
      const [redirectContent, redirectErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(r.target))
      if (redirectErr) {
        return err(`${name}: ${redirectErr}`)
      }
      stdin = redirectContent
    }
  }

  // Handle heredoc as stdin
  if (cmd.heredoc) {
    stdin = cmd.heredoc.content
  }

  // Resolve arguments
  const resolvedArgs = await resolveArgs(cmd.args, ctx)

  // Check for help flag
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

/** Resolve argument nodes to string values */
async function resolveArgs(
  args: ArgumentNode[],
  ctx: ExecutorContext
): Promise<string[]> {
  const result: string[] = []

  for (const arg of args) {
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
      return ctx.env.resolve(arg.name)

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
    workspace: ctx.workspace,
    toolRegistry: ctx.toolRegistry,
    config: ctx.config,
    env: ctx.env,
  }
}

/** Apply output redirects (> file, >> file) */
async function applyRedirects(
  result: CommandResult,
  cmd: CommandNode,
  ctx: ExecutorContext
): Promise<CommandResult> {
  for (const r of cmd.redirects) {
    const target = vfsPath(r.target)
    if (r.type === 'out') {
      await ctx.toolRegistry.executeTool('fs_write', {
        mode: 'write',
        path: target,
        content: result.stdout
      }, ctx.workspace)
      return { ...result, stdout: '' }
    }
    if (r.type === 'append') {
      // Read existing content, append, write back
      const [existingContent, existingErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, target)
      const content = (existingErr ? '' : existingContent) + result.stdout
      await ctx.toolRegistry.executeTool('fs_write', {
        mode: 'write',
        path: target,
        content
      }, ctx.workspace)
      return { ...result, stdout: '' }
    }
  }
  return result
}
