/**
 * Filesystem commands: cat, ls, rm, cp, mv, touch, find, du, chmod, head, tail
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err, EXIT } from './types'
import { shellReadFile } from './fs-read-helper'

/** Normalize a path for VFS: strip leading ./ and / since VFS paths are relative */
function vfsPath(p: string): string {
  if (p === '.' || p === './' || p === '/') return ''
  return p.replace(/^\.\//, '').replace(/^\//, '')
}

const catHandler: CommandHandler = {
  name: 'cat',
  summary: 'Read file contents',
  helpText: [
    'cat <path>           Read file contents',
    'cat -n <path>        With line numbers',
    'cat <glob>           Read multiple files matching glob',
    '',
    'Options:',
    '  -n                 Show line numbers',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_read'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const showLineNumbers = !!ctx.flags.n
    const paths = ctx.args
    if (paths.length === 0) {
      // If stdin is provided, pass through (like real cat)
      if (ctx.stdin) return ok(ctx.stdin)
      return err('cat: missing file path')
    }

    const outputs: string[] = []
    for (const rawPath of paths) {
      const path = vfsPath(rawPath)
      const [content, error] = await shellReadFile(ctx.toolRegistry, ctx.workspace, path)
      if (error) return err(`cat: ${error}`)
      if (showLineNumbers) {
        const lines = content.split('\n')
        outputs.push(lines.map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n'))
      } else {
        outputs.push(content)
      }
    }
    return ok(outputs.join('\n'))
  }
}

const lsHandler: CommandHandler = {
  name: 'ls',
  summary: 'List files',
  helpText: [
    'ls [prefix]          List files',
    'ls -l [prefix]       Long format (size, dates, protected)',
    '',
    'Options:',
    '  -l                 Long listing format',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_list'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const prefix = vfsPath(ctx.args[0] ?? '')
    const long = !!ctx.flags.l
    const result = await ctx.toolRegistry.executeTool('fs_list', {
      prefix,
      include_metadata: long
    }, ctx.workspace)
    if (result.isError) return err(`ls: ${result.content}`)
    return ok(result.content)
  }
}

const rmHandler: CommandHandler = {
  name: 'rm',
  summary: 'Delete a file',
  helpText: 'rm <path>            Delete a file from the VFS',
  category: 'filesystem',
  resolvedTools: ['fs_delete'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('rm: missing file path')
    for (const rawPath of ctx.args) {
      const path = vfsPath(rawPath)
      const result = await ctx.toolRegistry.executeTool('fs_delete', { path }, ctx.workspace)
      if (result.isError) return err(`rm: ${result.content}`)
    }
    return ok('')
  }
}

const cpHandler: CommandHandler = {
  name: 'cp',
  summary: 'Copy a file',
  helpText: 'cp <src> <dst>       Copy a file',
  category: 'filesystem',
  resolvedTools: ['fs_read', 'fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length < 2) return err('cp: usage: cp <src> <dst>')
    const src = vfsPath(ctx.args[0])
    const dst = vfsPath(ctx.args[1])
    const [content, readErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, src)
    if (readErr) return err(`cp: ${readErr}`)
    const write = await ctx.toolRegistry.executeTool('fs_write', { mode: 'write', path: dst, content }, ctx.workspace)
    if (write.isError) return err(`cp: ${write.content}`)
    return ok('')
  }
}

const mvHandler: CommandHandler = {
  name: 'mv',
  summary: 'Move/rename a file',
  helpText: 'mv <src> <dst>       Move or rename a file',
  category: 'filesystem',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length < 2) return err('mv: usage: mv <src> <dst>')
    const src = vfsPath(ctx.args[0])
    const dst = vfsPath(ctx.args[1])
    try {
      const renamed = ctx.workspace.renameInternalFile(src, dst)
      if (!renamed) return err(`mv: ${src}: no such file`)
      return ok('')
    } catch (e) {
      return err(`mv: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

const touchHandler: CommandHandler = {
  name: 'touch',
  summary: 'Create an empty file',
  helpText: 'touch <path>         Create an empty file (only if it doesn\'t exist)',
  category: 'filesystem',
  resolvedTools: ['fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('touch: missing file path')
    for (const rawPath of ctx.args) {
      const path = vfsPath(rawPath)
      // Check if file exists first
      if (!ctx.workspace.fileExists(path)) {
        // File doesn't exist — create it
        const result = await ctx.toolRegistry.executeTool('fs_write', { mode: 'write', path, content: '' }, ctx.workspace)
        if (result.isError) return err(`touch: ${result.content}`)
      }
    }
    return ok('')
  }
}

const findHandler: CommandHandler = {
  name: 'find',
  summary: 'Find files by pattern',
  helpText: [
    'find [path] -name <glob>   Find files matching glob pattern',
    '',
    'Options:',
    '  -name <glob>       Match filename pattern',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_list'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const prefix = vfsPath(ctx.args[0] ?? '')
    const namePattern = ctx.flags.name as string | undefined
    const result = await ctx.toolRegistry.executeTool('fs_list', { prefix }, ctx.workspace)
    if (result.isError) return err(`find: ${result.content}`)

    // Extract bare paths from "path (size) [protection]" — find output must be pipeable
    let lines = result.content.split('\n').map(line => {
      const pathMatch = line.match(/^(.+?)\s+\(/)
      return pathMatch ? pathMatch[1] : line.trim()
    })

    if (namePattern) {
      const regex = new RegExp('^' + namePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      lines = lines.filter(filePath => {
        const name = filePath.split('/').pop() ?? filePath
        return regex.test(name)
      })
    }

    return ok(lines.join('\n'))
  }
}

/** Format byte count to human-readable size (e.g. "4.0K", "1.2M") */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`
}

const duHandler: CommandHandler = {
  name: 'du',
  summary: 'Show file sizes',
  helpText: [
    'du [path]            Show disk usage of files',
    '',
    'Options:',
    '  -h                 Human-readable sizes (default)',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const prefix = vfsPath(ctx.args[0] ?? '')
    let files = ctx.workspace.listFiles()
    if (prefix) {
      files = files.filter(f => f.path.startsWith(prefix))
    }
    if (files.length === 0) return ok('')

    // Sort by size descending
    files.sort((a, b) => b.size - a.size)
    const total = files.reduce((sum, f) => sum + f.size, 0)
    const lines = files.map(f => `${formatSize(f.size)}\t${f.path}`)
    lines.push(`${formatSize(total)}\ttotal`)
    return ok(lines.join('\n'))
  }
}

const chmodHandler: CommandHandler = {
  name: 'chmod',
  summary: 'Set file protection',
  helpText: [
    'chmod +p <path>      Set file as protected',
    'chmod -p <path>      Remove protection',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length < 2) return err('chmod: usage: chmod [+p|-p] <path>')
    const mode = ctx.args[0]
    const path = vfsPath(ctx.args[1])
    if (mode === '+p') {
      try {
        ctx.workspace.setFileProtection(path, 'protected')
        return ok('')
      } catch (e) {
        return err(`chmod: ${String(e)}`)
      }
    } else if (mode === '-p') {
      try {
        ctx.workspace.setFileProtection(path, 'normal')
        return ok('')
      } catch (e) {
        return err(`chmod: ${String(e)}`)
      }
    }
    return err('chmod: invalid mode. Use +p or -p')
  }
}

const headHandler: CommandHandler = {
  name: 'head',
  summary: 'Show first N lines',
  helpText: [
    'head [-N] [file]     Show first N lines (default 10)',
    '',
    'Options:',
    '  -n <N>             Number of lines (or -N shorthand)',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_read'],
  valueFlags: new Set(['n']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    let n = 10
    // -n <N> where valueFlags consumed the value
    if (ctx.flags.n && typeof ctx.flags.n === 'string') n = parseInt(ctx.flags.n, 10)
    // -N shorthand (e.g., -5 → flags["5"] = true)
    for (const key of Object.keys(ctx.flags)) {
      if (/^\d+$/.test(key)) n = parseInt(key, 10)
    }

    let text = ctx.stdin
    if (ctx.args.length > 0) {
      const [content, error] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(ctx.args[0]), { end_line: n })
      if (error) return err(`head: ${error}`)
      return ok(content)
    }

    // Operate on stdin
    if (!text) return ok('')
    const lines = text.split('\n')
    return ok(lines.slice(0, n).join('\n'))
  }
}

const tailHandler: CommandHandler = {
  name: 'tail',
  summary: 'Show last N lines',
  helpText: [
    'tail [-N] [file]     Show last N lines (default 10)',
    '',
    'Options:',
    '  -n <N>             Number of lines (or -N shorthand)',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_read'],
  valueFlags: new Set(['n']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    let n = 10
    // -n <N> where valueFlags consumed the value
    if (ctx.flags.n && typeof ctx.flags.n === 'string') n = parseInt(ctx.flags.n, 10)
    // -N shorthand (e.g., -5 → flags["5"] = true)
    for (const key of Object.keys(ctx.flags)) {
      if (/^\d+$/.test(key)) n = parseInt(key, 10)
    }

    let text = ctx.stdin
    if (ctx.args.length > 0) {
      const [content, error] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(ctx.args[0]))
      if (error) return err(`tail: ${error}`)
      text = content
    }

    if (!text) return ok('')
    const lines = text.split('\n')
    return ok(lines.slice(-n).join('\n'))
  }
}

export const filesystemHandlers: CommandHandler[] = [
  catHandler, lsHandler, rmHandler, cpHandler, mvHandler,
  touchHandler, findHandler, duHandler, chmodHandler,
  headHandler, tailHandler,
]
