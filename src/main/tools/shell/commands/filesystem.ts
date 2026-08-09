/**
 * Filesystem commands: cat, ls, rm, cp, mv, touch, find, du, chmod, head, tail
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err, EXIT } from './types'
import type { FileProtectionLevel } from '@shared/types/adf-v02.types'
import { currentSourceOrUnknown } from '../../../runtime/execution-context'
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
    'ls [prefix...]       List files (multiple args merged, deduped)',
    'ls -l [prefix...]    Long format (size, dates, protected)',
    '',
    'Options:',
    '  -l                 Long listing format',
    '',
    'Output is ONE JSON array, not one line per file — piping to head/tail',
    "slices nothing. Slice with jq: ls | jq -r '.[].path'  or  ls | jq '.[0:3]'",
    '',
    'Each arg is a path prefix (exact file OR directory-ish prefix); results',
    'are merged and deduped, so `ls *.md` (shell-expanded) lists every match.',
    'An arg matching nothing prints "ls: <arg>: No such file or directory" on',
    'stderr; exit 2 only if NO arg matched. Stdout is always one JSON array.',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_list'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const long = !!ctx.flags.l
    // Every arg is a prefix query (globs arrive pre-expanded by the shell, so
    // `ls *.md` is several args here). No args → one unfiltered listing.
    const prefixes = ctx.args.length > 0 ? ctx.args.map(a => vfsPath(a)) : ['']
    const merged: unknown[] = []
    const seen = new Set<string>()
    const missing: string[] = []
    for (let i = 0; i < prefixes.length; i++) {
      const result = await ctx.toolRegistry.executeTool('fs_list', {
        prefix: prefixes[i],
        include_metadata: long
      }, ctx.workspace)
      if (result.isError) return err(`ls: ${result.content}`)
      let rows: unknown[]
      try {
        const parsed = JSON.parse(result.content)
        rows = Array.isArray(parsed) ? parsed : []
      } catch {
        return err('ls: unexpected fs_list output (not a JSON array)')
      }
      if (rows.length === 0 && ctx.args.length > 0) {
        // Explicit arg matched nothing — surface it like bash ls does instead
        // of silently returning [] (a footgun now that globs pre-expand).
        missing.push(ctx.args[i])
        continue
      }
      for (const row of rows) {
        const key = (row && typeof row === 'object' && typeof (row as { path?: unknown }).path === 'string')
          ? (row as { path: string }).path
          : JSON.stringify(row)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(row)
      }
    }
    // Stdout is ALWAYS one JSON array (the `ls | jq -r '.[].path'` contract),
    // even on failure. Exit 2 only when explicit args were given and none
    // matched; partial matches list what exists and still exit 0.
    const nothingMatched = ctx.args.length > 0 && merged.length === 0
    return {
      exit_code: nothingMatched ? 2 : EXIT.SUCCESS,
      stdout: JSON.stringify(merged),
      stderr: missing.map(m => `ls: ${m}: No such file or directory`).join('\n'),
    }
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
  helpText: [
    'mv <src> <dst>       Move or rename a file',
    '',
    'A rename preserves content, so mv needs fs_read + fs_write — not the',
    'destructive fs_delete. Protected sources (read_only/no_delete) still',
    'require a HIL override before the old path is released.',
  ].join('\n'),
  category: 'filesystem',
  // A rename preserves content — the honest capability set is read-the-source
  // + write-the-destination, NOT the destructive fs_delete: gating mv on
  // delete priced "rename" the same as "destroy", so an agent without
  // fs_delete couldn't rename anything. The delete-like half (releasing a
  // PROTECTED src path) is covered by the inline protection/HIL check below,
  // which fails closed / asks the human exactly as before.
  // (Previously []: fully ungated, a permission-escalation seam.)
  resolvedTools: ['fs_read', 'fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length < 2) return err('mv: usage: mv <src> <dst>')
    const src = vfsPath(ctx.args[0])
    const dst = vfsPath(ctx.args[1])

    // Protection check mirrors fs_delete (the destructive half of a rename).
    // Authorized scripts bypass, same privilege as the UI. (ctx.authorized is
    // set by the executor gate for authorized .sh files; undefined elsewhere.)
    // This inline check never dispatches fs_delete, so the protection-gated
    // registry can't intercept it — request the HIL override directly.
    const protection = ctx.workspace.getFileProtection(src)
    const wasProtected = protection === 'read_only' || protection === 'no_delete'
    let bypass: 'authorized' | 'human-approved' | null = null
    if (wasProtected) {
      if (ctx.authorized) {
        bypass = 'authorized'
      } else {
        const gate = ctx.gate
        if (!gate?.onProtectionBlocked || gate.authorized) {
          return err(`mv: cannot move "${src}": file is protected (${protection}).`)
        }
        const decision = await gate.onProtectionBlocked(
          'fs_delete',
          { path: src },
          {
            kind: 'file_protection', target: src, level: protection!,
            description: `Move "${src}" — file is protected (${protection})`
          },
          gate.command ?? `mv ${src} ${dst}`
        )
        if (!decision.approved) {
          const fb = decision.feedback?.trim()
          return err(`mv: cannot move "${src}": file is protected (${protection}). Override rejected by the user.${fb ? ` Feedback: ${fb}` : ''} Do not retry.`, EXIT.INTERCEPTED)
        }
        bypass = 'human-approved'
      }
    }

    try {
      const renamed = ctx.workspace.renameInternalFile(src, dst)
      if (!renamed) return err(`mv: ${src}: no such file`)
      // No Secrets: moving a PROTECTED source releases its protected path — a
      // bypass (authorized script or human override) must never be silent.
      if (bypass) {
        const reason = bypass === 'human-approved'
          ? 'human-approved override'
          : `authorized code bypass (${currentSourceOrUnknown()})`
        ctx.workspace.insertLog?.('warn', 'protection', 'bypass', src,
          `Moved protected file "${src}" (${protection}) — ${reason}`)
        return ok(`Moved "${src}" (⚠ protection override: ${protection}, ${bypass}).`)
      }
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
    'chmod +p <path>              Protect a file (default level: read_only)',
    'chmod +p=read_only <path>    Protect: no writes, no deletion',
    'chmod +p=no_delete <path>    Protect: writable, but cannot be deleted',
    'chmod -p <path>              Remove protection',
    '',
    'Protection levels: read_only (no writes or deletion), no_delete',
    '(writable but not deletable), none (unprotected). Plain +p defaults to',
    'read_only. Removing or changing an EXISTING protection pauses for a',
    'human (HIL) override approval; raising protection on an unprotected',
    'file needs none.',
    '',
    'adf files have no unix modes — numeric (644) and symbolic (u+x) modes',
    'are not supported. +p/-p is the whole interface.',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const usage = 'chmod: usage: chmod [+p[=read_only|no_delete]|-p] <path>'
    // `chmod -p path` arrives with -p parsed as a boolean flag (args: [path]);
    // `chmod +p path` keeps +p as a positional. Accept both shapes.
    const mode = ctx.flags.p === true ? '-p' : ctx.args[0]
    const pathArg = ctx.flags.p === true ? ctx.args[0] : ctx.args[1]
    if (!mode || !pathArg) return err(usage)

    // Map the mode to a valid FileProtectionLevel ('read_only' | 'no_delete'
    // | 'none' — the DB CHECK-constrained set). The old handler wrote legacy
    // 'protected'/'normal', which the DB rejected with a CHECK failure.
    let target: FileProtectionLevel
    if (mode === '-p') {
      target = 'none'
    } else if (mode === '+p') {
      target = 'read_only' // documented default: "+p protects" = no writes, no deletion
    } else if (mode.startsWith('+p=')) {
      const level = mode.slice('+p='.length)
      if (level !== 'read_only' && level !== 'no_delete') {
        return err(`chmod: invalid protection level "${level}". Use +p=read_only or +p=no_delete (or -p to unprotect)`)
      }
      target = level
    } else if (/^[0-7]{1,4}$/.test(mode) || /^[ugoa]*[+\-=][rwxXstugo]+$/.test(mode)) {
      // Numeric (644) / symbolic (u+x, a=r) unix modes: fail fast with the
      // real contract instead of a generic "invalid mode".
      return err('chmod: only +p (protect) and -p (unprotect) are supported — adf files have no unix modes')
    } else {
      return err(`chmod: invalid mode "${mode}". Use +p, +p=read_only, +p=no_delete, or -p`)
    }

    const path = vfsPath(pathArg)
    const current = ctx.workspace.getFileProtection(path)
    if (current === null) return err(`chmod: ${pathArg}: No such file or directory`)
    if (current === target) return ok('')

    // Removing or CHANGING an existing protection is a protection override —
    // route through the HIL gate, mirroring mv's inline check (chmod talks to
    // the workspace directly, so the protection-gated registry never sees
    // it). Raising protection on an unprotected file needs no approval.
    // Authorized scripts bypass, same privilege as the UI.
    const wasProtected = current === 'read_only' || current === 'no_delete'
    let bypass: 'authorized' | 'human-approved' | null = null
    if (wasProtected) {
      if (ctx.authorized) {
        bypass = 'authorized'
      } else {
        const gate = ctx.gate
        if (!gate?.onProtectionBlocked || gate.authorized) {
          return err(`chmod: cannot change protection of "${path}": file is protected (${current}).`)
        }
        const decision = await gate.onProtectionBlocked(
          'fs_write',
          { path, protection: target },
          {
            kind: 'file_protection', target: path, level: current,
            description: `Change protection of "${path}" (currently ${current})`
          },
          gate.command ?? `chmod ${mode} ${pathArg}`
        )
        if (!decision.approved) {
          const fb = decision.feedback?.trim()
          return err(`chmod: cannot change protection of "${path}": file is protected (${current}). Override rejected by the user.${fb ? ` Feedback: ${fb}` : ''} Do not retry.`, EXIT.INTERCEPTED)
        }
        bypass = 'human-approved'
      }
    }

    try {
      ctx.workspace.setFileProtection(path, target)
      // No Secrets: lowering/changing a REAL protection via a bypass (authorized
      // script or human override) must never be silent — audit + visible marker.
      if (bypass) {
        const reason = bypass === 'human-approved'
          ? 'human-approved override'
          : `authorized code bypass (${currentSourceOrUnknown()})`
        ctx.workspace.insertLog?.('warn', 'protection', 'bypass', path,
          `Changed protection of "${path}" (${current} -> ${target}) — ${reason}`)
        return ok(`Changed protection of "${path}" to ${target} (⚠ protection override: ${current}, ${bypass}).`)
      }
      return ok('')
    } catch (e) {
      return err(`chmod: ${e instanceof Error ? e.message : String(e)}`)
    }
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
    '  -c <N>             First N BYTES instead of lines (UTF-8 byte slice;',
    '                     a multi-byte char cut at the boundary becomes U+FFFD).',
    '                     Takes precedence over -n if both are given.',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_read'],
  valueFlags: new Set(['n', 'c']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // -c <N>: byte mode. Must be a valueFlag — before, `head -c 80 file`
    // parsed "80" as the file path and errored 'File not found: "80"'.
    if (ctx.flags.c !== undefined) {
      const raw = ctx.flags.c
      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        return err('head: -c requires a plain byte count (e.g. head -c 80 file); suffixes (K/M) and negative counts are not supported')
      }
      const bytes = parseInt(raw, 10)
      let content = ctx.stdin
      if (ctx.args.length > 0) {
        const [fileContent, error] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(ctx.args[0]))
        if (error) return err(`head: ${error}`)
        content = fileContent
      }
      if (!content) return ok('')
      // Buffer slice = real head's byte semantics for UTF-8 content; a partial
      // trailing multi-byte sequence decodes as U+FFFD (documented in help).
      return ok(Buffer.from(content, 'utf8').subarray(0, bytes).toString('utf8'))
    }

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
    '  -n <N>             Number of lines (or -N shorthand); -n +N starts at line N',
    '  -c <N>             Last N BYTES instead of lines; -c +N starts at byte N',
    '                     (UTF-8 byte slice; a multi-byte char cut at the',
    '                     boundary becomes U+FFFD). Takes precedence over -n.',
  ].join('\n'),
  category: 'filesystem',
  resolvedTools: ['fs_read'],
  valueFlags: new Set(['n', 'c']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // -c <N>: byte mode, mirroring head -c (same valueFlags fix — without it
    // the count was misparsed as the file path).
    if (ctx.flags.c !== undefined) {
      const raw = ctx.flags.c
      if (typeof raw !== 'string' || !/^\+?\d+$/.test(raw)) {
        return err('tail: -c requires a plain byte count (e.g. tail -c 80 file); suffixes (K/M) and negative counts are not supported')
      }
      const fromByte = raw.startsWith('+') // GNU: -c +N outputs from byte N (1-indexed)
      const bytes = parseInt(raw, 10)
      let content = ctx.stdin
      if (ctx.args.length > 0) {
        const [fileContent, error] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(ctx.args[0]))
        if (error) return err(`tail: ${error}`)
        content = fileContent
      }
      if (!content) return ok('')
      const buf = Buffer.from(content, 'utf8')
      const sliced = fromByte
        ? buf.subarray(Math.max(0, bytes - 1))
        : (bytes <= 0 ? buf.subarray(buf.length) : buf.subarray(Math.max(0, buf.length - bytes)))
      return ok(sliced.toString('utf8'))
    }

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
