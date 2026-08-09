/**
 * Filesystem commands: cat, ls, rm, cp, mv, touch, find, du, chmod, head, tail
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err, EXIT } from './types'
import { shellReadFile, shellReadFileRow, isMediaMime, isTextRow } from './fs-read-helper'

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
    'cat --text <path>    Force text output even if the MIME says binary',
    '',
    'Options:',
    '  -n                 Show line numbers',
    '  --text             Decode as UTF-8 text regardless of MIME classification',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_read'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const showLineNumbers = !!ctx.flags.n
    const forceText = !!ctx.flags.text
    const paths = ctx.args
    if (paths.length === 0) {
      // If stdin is provided, pass through (like real cat)
      if (ctx.stdin) return ok(ctx.stdin)
      return err('cat: missing file path')
    }

    const outputs: string[] = []
    const media: Array<{ path: string; mime_type: string }> = []
    for (const rawPath of paths) {
      const path = vfsPath(rawPath)
      const [row, error] = await shellReadFileRow(ctx.toolRegistry, ctx.workspace, path)
      if (error !== null) return err(`cat: ${error}`)
      if (isMediaMime(row.mime_type)) {
        // Media file: emit a marker and queue for multimodal injection —
        // dumping base64 into stdout would waste context and show nothing.
        // Don't promise attachment for files the executor will drop for size:
        // the injection path silently skips media over the per-modality limit.
        const mime = row.mime_type!
        const limits = ctx.config.limits ?? {}
        const maxSize = mime.startsWith('image/') ? (limits.max_image_size_bytes ?? 5_242_880)
          : mime.startsWith('audio/') ? (limits.max_audio_size_bytes ?? 10_485_760)
          : (limits.max_video_size_bytes ?? 10_485_760)
        if (row.size !== undefined && row.size > maxSize) {
          outputs.push(`[${mime}: ${row.path ?? path}, ${row.size} bytes — too large to attach (limit ${maxSize} bytes)]`)
          continue
        }
        media.push({ path: row.path ?? path, mime_type: mime })
        outputs.push(`[${mime}: ${row.path ?? path}${row.size ? `, ${row.size} bytes` : ''} — attached for viewing if your model supports this modality]`)
        continue
      }
      if (!isTextRow(row)) {
        // Non-text, non-media binary (zip/pdf/octet-stream/unknown mime):
        // fs_read returns base64 for these.
        if (forceText) {
          // Escape hatch: the file really is text the MIME registry missed —
          // decode the base64 back to UTF-8 and emit the bytes.
          const decoded = Buffer.from(row.content, 'base64').toString('utf8')
          outputs.push(showLineNumbers
            ? decoded.split('\n').map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n')
            : decoded)
          continue
        }
        // Emit a marker instead of flooding context with unreadable base64.
        outputs.push(`[binary: ${row.path ?? path}${row.size ? `, ${row.size} bytes` : ''}${row.mime_type ? `, ${row.mime_type}` : ''} — not shown${'; use `cat --text` if this is text'}]`)
        continue
      }
      if (showLineNumbers) {
        const lines = row.content.split('\n')
        outputs.push(lines.map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n'))
      } else {
        outputs.push(row.content)
      }
    }
    const result = ok(outputs.join('\n'))
    if (media.length > 0) result.media = media
    return result
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
    '',
    'Output is ONE JSON array, not one line per file — piping to head/tail',
    "slices nothing. Slice with jq: ls | jq -r '.[].path'  or  ls | jq '.[0:3]'",
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
  // Rename destroys the old path and creates a new one (renameInternalFile
  // emits delete+create events), so it requires BOTH capabilities — matching
  // the tool-path cost of a rename (read+write+delete) and letting preflight
  // gate it. Previously []: fully ungated, a permission-escalation seam.
  resolvedTools: ['fs_write', 'fs_delete'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length < 2) return err('mv: usage: mv <src> <dst>')
    const src = vfsPath(ctx.args[0])
    const dst = vfsPath(ctx.args[1])

    // Protection check mirrors fs_delete (the destructive half of a rename).
    // Authorized scripts bypass, same privilege as the UI. (ctx.authorized is
    // set by the executor gate for authorized .sh files; undefined elsewhere.)
    // This inline check never dispatches fs_delete, so the protection-gated
    // registry can't intercept it — request the HIL override directly.
    if (!ctx.authorized) {
      const protection = ctx.workspace.getFileProtection(src)
      if (protection === 'read_only' || protection === 'no_delete') {
        const gate = ctx.gate
        if (!gate?.onProtectionBlocked || gate.authorized) {
          return err(`mv: cannot move "${src}": file is protected (${protection}).`)
        }
        const decision = await gate.onProtectionBlocked(
          'fs_delete',
          { path: src },
          { kind: 'file_protection', target: src, level: protection },
          gate.command ?? `mv ${src} ${dst}`
        )
        if (!decision.approved) {
          const fb = decision.feedback?.trim()
          return err(`mv: cannot move "${src}": file is protected (${protection}). Override rejected by the user.${fb ? ` Feedback: ${fb}` : ''} Do not retry.`, EXIT.INTERCEPTED)
        }
      }
    }

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
    'find [path]                List files (optionally under a path)',
    'find [path] -name <glob>   Find files whose basename matches a glob',
    '',
    'Options:',
    '  -name <glob>       Glob with * and ? (* never crosses a / segment).',
    '                     Quote the glob ("*.md") so find does the matching;',
    '                     an unquoted glob is expanded by the shell first.',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: [],  // reads the VFS list directly, like grep -r

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // Parse argv ourselves from rawArgs: the generic flag parser explodes
    // `-name` into boolean -n -a -m -e flags and demotes the pattern to a
    // positional, which then filtered paths as a PREFIX — so
    // `find -name "*.md"` matched nothing while exact names "worked" by
    // accident (the pattern doubled as an exact-path prefix).
    const raw = ctx.rawArgs ?? ctx.args
    const positionals: string[] = []
    const patterns: string[] = []
    for (let i = 0; i < raw.length; i++) {
      const tok = raw[i]
      if (tok === '-name' || tok === '--name') {
        // Take every following non-flag token as a pattern: normally one, but
        // an unquoted glob the shell pre-expanded arrives as several — a file
        // matches if ANY of them matches.
        const before = patterns.length
        while (i + 1 < raw.length && !raw[i + 1].startsWith('-')) patterns.push(raw[++i])
        if (patterns.length === before) return err('find: -name requires a pattern (quote it: -name "*.md")')
      } else if (tok.startsWith('-') && tok.length > 1) {
        return err(`find: unsupported option ${tok} — usage: find [path] [-name <glob>]`)
      } else {
        positionals.push(tok)
      }
    }

    // Read the file list directly (structured), not the human-formatted fs_list
    // text — parsing that produced garbage that the -name filter couldn't match.
    const prefix = vfsPath(positionals[0] ?? '')
    let paths = ctx.workspace.listFiles().map(f => f.path)

    // Prefix = a file (exact match) OR a directory (paths under `prefix/`). This
    // stops an exact filename from also matching longer siblings (e.g.
    // `find x.json` matching x.jsonl).
    if (prefix) {
      paths = paths.filter(p => p === prefix || p.startsWith(prefix + '/'))
    }

    if (patterns.length > 0) {
      // Glob → regex: escape regex chars, then * → [^/]* and ? → [^/] — VFS
      // keys are /-separated, and * must not cross a segment boundary.
      const matchers = patterns.map(g => ({
        regex: new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$'),
        // A pattern containing / (e.g. a shell-pre-expanded full path) matches
        // the whole path; a plain glob matches the basename (GNU -name).
        fullPath: g.includes('/'),
      }))
      paths = paths.filter(p => matchers.some(m => m.regex.test(m.fullPath ? p : (p.split('/').pop() ?? p))))
    }

    return ok(paths.join('\n'))
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
    '',
    'adf files have no unix modes — numeric (644) and symbolic (u+x) modes',
    'are not supported. +p/-p is the whole interface.',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // `chmod -p path` arrives with -p parsed as a boolean flag (args: [path]);
    // `chmod +p path` keeps +p as a positional. Accept both shapes.
    const mode = ctx.flags.p === true ? '-p' : ctx.args[0]
    const pathArg = ctx.flags.p === true ? ctx.args[0] : ctx.args[1]
    if (!mode || !pathArg) return err('chmod: usage: chmod [+p|-p] <path>')
    if (mode === '+p' || mode === '-p') {
      try {
        ctx.workspace.setFileProtection(vfsPath(pathArg), mode === '+p' ? 'protected' : 'normal')
        return ok('')
      } catch (e) {
        return err(`chmod: ${String(e)}`)
      }
    }
    // Numeric (644) / symbolic (u+x, a=r) unix modes: fail fast with the real
    // contract instead of a generic "invalid mode".
    if (/^[0-7]{1,4}$/.test(mode) || /^[ugoa]*[+\-=][rwxXstugo]+$/.test(mode)) {
      return err('chmod: only +p (protect) and -p (unprotect) are supported — adf files have no unix modes')
    }
    return err(`chmod: invalid mode "${mode}". Use +p or -p`)
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
    let fromLine = false // `-n +N`: start at line N (skip the first N-1)
    if (typeof ctx.flags.n === 'string') {
      const raw = ctx.flags.n
      fromLine = raw.startsWith('+')
      n = parseInt(raw, 10)
    }
    // -N shorthand (e.g., -5 → flags["5"] = true)
    for (const key of Object.keys(ctx.flags)) {
      if (/^\d+$/.test(key)) n = parseInt(key, 10)
    }
    if (isNaN(n)) return err('tail: invalid number of lines')

    let text = ctx.stdin
    if (ctx.args.length > 0) {
      const [content, error] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(ctx.args[0]))
      if (error) return err(`tail: ${error}`)
      text = content
    }

    if (!text) return ok('')
    const lines = text.split('\n')
    // A terminating newline yields a trailing '' that isn't a real line — drop
    // it, else `tail -n 1` of "a\nb\n" returns "" instead of "b".
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (fromLine) return ok(lines.slice(Math.max(0, n - 1)).join('\n')) // +N: from line N
    if (n <= 0) return ok('') // GNU: `tail -n 0` prints nothing
    return ok(lines.slice(-n).join('\n'))
  }
}

export const filesystemHandlers: CommandHandler[] = [
  catHandler, lsHandler, rmHandler, cpHandler, mvHandler,
  touchHandler, findHandler, duHandler, chmodHandler,
  headHandler, tailHandler,
]
