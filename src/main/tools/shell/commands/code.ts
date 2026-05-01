/**
 * Code execution commands: node -e, ./<script>, .sh scripts
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'
import { shellReadFile } from './fs-read-helper'

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
    '.sh files: read and execute line-by-line as shell commands',
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

    // TypeScript/JavaScript: use sys_lambda
    const fnName = ctx.args[1]
    const argsStr = ctx.flags.args as string | undefined

    const input: Record<string, unknown> = { path }
    if (fnName) input.function = fnName
    if (argsStr) {
      try {
        input.args = JSON.parse(argsStr)
      } catch {
        return err(`./: invalid JSON args: ${argsStr}`)
      }
    }
    if (ctx.stdin) {
      // Pass stdin as first arg if no explicit args
      if (!argsStr) {
        input.args = [ctx.stdin]
      }
    }

    const result = await ctx.toolRegistry.executeTool('sys_lambda', input, ctx.workspace)
    if (result.isError) return err(`./${path}: ${result.content}`)
    return ok(result.content)
  }
}

/** Execute a .sh file: read from VFS, parse line-by-line, execute sequentially */
async function executeShellScript(path: string, ctx: CommandContext): Promise<CommandResult> {
  const [scriptContent, readErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, path)
  if (readErr) return err(`./${path}: ${readErr}`)

  const lines = scriptContent.split('\n')
  let lastResult: CommandResult = { exit_code: 0, stdout: '', stderr: '' }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue
    // Skip shebang
    if (line.startsWith('#!')) continue

    // Parse and execute each line
    const { parse } = await import('../parser/parser')
    const { executeNode } = await import('../executor/pipeline-executor')
    const ast = parse(line)
    lastResult = await executeNode(ast, '', {
      workspace: ctx.workspace,
      toolRegistry: ctx.toolRegistry,
      config: ctx.config,
      env: ctx.env,
    })

    if (lastResult.exit_code !== 0) return lastResult
  }

  return lastResult
}

export const codeHandlers: CommandHandler[] = [nodeHandler, scriptHandler]
