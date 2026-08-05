/**
 * Text processing builtins: grep, sed, sort, uniq, wc, cut, tr, tee, rev, tac, diff, xargs
 * Pure string operations on stdin.
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'
import { shellReadFile, shellReadFileRow, isTextRow } from './fs-read-helper'
import { runApplet } from './wasi-applet-adapter'

/** Normalize a path for VFS: strip leading ./ and / */
function vfsPath(p: string): string {
  if (p === '.' || p === './' || p === '/') return ''
  return p.replace(/^\.\//, '').replace(/^\//, '')
}

/** Extract just the file path from an fs_list entry like "path (1.2 KB) [no-delete]" */
function extractPath(entry: string): string {
  const match = entry.match(/^(.+?)\s+\(/)
  return match ? match[1] : entry.trim()
}

/** Interpret common escape sequences in a string (e.g. \n → newline, \t → tab) */
function interpretEscapes(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
}

/**
 * Execute a real coreutils applet (uutils WASM). Positional args are treated
 * as VFS file paths (GNU semantics): pre-read via the audited fs_read path
 * and mounted into the applet's in-memory filesystem. Set fileArgs:false for
 * applets whose positionals are not files (e.g. tr's character sets).
 */
async function coreutilsExec(
  applet: string,
  ctx: CommandContext,
  opts: { fileArgs: boolean } = { fileArgs: true }
): Promise<CommandResult> {
  const files: Record<string, string | Uint8Array> = {}
  // Work off rawArgs, not ctx.args: the shell's long-flag parser consumes the
  // next token as a flag value (so `sort --reverse data.txt` files data.txt
  // under flags.reverse and drops it from ctx.args). Instead, mount every
  // non-flag token that resolves in the VFS and let the real applet do arg
  // parsing. Tokens that are actually flag values won't resolve and are
  // skipped; genuinely-missing inputs surface as the applet's own error.
  const argv = [...(ctx.rawArgs ?? ctx.args)]
  if (opts.fileArgs) {
    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i]
      if (tok.startsWith('-')) continue // flag, combined flags, or '-' stdin marker
      const norm = vfsPath(tok)
      if (!norm) continue
      const [row, readErr] = await shellReadFileRow(ctx.toolRegistry, ctx.workspace, norm)
      if (readErr !== null) continue // not a readable file → maybe a flag value or output path
      // Mount real bytes: text as-is, binary decoded from the fs_read base64
      // row so byte-oriented applets (wc -c) count actual bytes.
      files[norm] = isTextRow(row) ? row.content : Buffer.from(row.content, 'base64')
      argv[i] = norm // reference the mounted key (vfsPath may have stripped ./ or /)
    }
  }
  try {
    const { stdout, stderr, exitCode } = await runApplet(applet, argv, ctx.stdin || '', files, {
      timeoutMs: ctx.config.limits?.execution_timeout_ms,
      signal: ctx.signal,
    })
    if (exitCode !== 0) return err(stderr.trim() || `${applet}: exit ${exitCode}`, exitCode)
    return ok(stdout.replace(/\n$/, ''))
  } catch (e) {
    return err(`${applet}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const grepHandler: CommandHandler = {
  name: 'grep',
  summary: 'Filter lines matching a pattern',
  helpText: [
    'grep <pattern> [file]   Filter lines matching regex pattern',
    '',
    'Options:',
    '  -i                    Case-insensitive',
    '  -v                    Invert match',
    '  -c                    Count matches',
    '  -n                    Show line numbers',
    '  -r                    Recursive search in VFS',
    '  -A <N>                Show N lines after match',
    '  -B <N>                Show N lines before match',
    '  -C <N>                Show N lines before and after match',
    '  --include=<glob>      Only search files matching glob',
    '  --exclude=<glob>      Skip files matching glob',
  ].join('\n'),
  category: 'text',
  resolvedTools: [],  // pure text operation; -r uses fs_list + fs_read
  valueFlags: new Set(['A', 'B', 'C']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('grep: missing pattern')

    const pattern = ctx.args[0]
    const ignoreCase = !!ctx.flags.i
    const invert = !!ctx.flags.v
    const count = !!ctx.flags.c
    const showNumbers = !!ctx.flags.n
    const recursive = !!ctx.flags.r
    const afterCtx = typeof ctx.flags.A === 'string' ? parseInt(ctx.flags.A, 10) : 0
    const beforeCtx = typeof ctx.flags.B === 'string' ? parseInt(ctx.flags.B, 10) : 0
    const aroundCtx = typeof ctx.flags.C === 'string' ? parseInt(ctx.flags.C, 10) : 0
    const ctxBefore = aroundCtx || beforeCtx
    const ctxAfter = aroundCtx || afterCtx

    const regex = new RegExp(pattern, ignoreCase ? 'i' : '')

    // --include/--exclude glob filters
    const includeGlob = typeof ctx.flags.include === 'string' ? ctx.flags.include : undefined
    const excludeGlob = typeof ctx.flags.exclude === 'string' ? ctx.flags.exclude : undefined
    const includeRegex = includeGlob
      ? new RegExp('^' + includeGlob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      : undefined
    const excludeRegex = excludeGlob
      ? new RegExp('^' + excludeGlob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      : undefined

    // If a file arg is given, read it
    let text = ctx.stdin
    if (ctx.args.length > 1 || recursive) {
      const path = vfsPath(ctx.args[1] ?? '')
      // Treat "." or empty path as implicit recursive (no real directories in VFS)
      if (recursive || path === '') {
        // Recursive grep: iterate over VFS files directly (no fs_list parsing)
        const allFiles = ctx.workspace.listFiles()
        let files = path ? allFiles.filter(f => f.path.startsWith(path)) : allFiles
        // Apply --include/--exclude filters
        if (includeRegex) {
          files = files.filter(f => {
            const name = f.path.split('/').pop() ?? f.path
            return includeRegex.test(name)
          })
        }
        if (excludeRegex) {
          files = files.filter(f => {
            const name = f.path.split('/').pop() ?? f.path
            return !excludeRegex.test(name)
          })
        }
        const matches: string[] = []
        for (const file of files) {
          // Skip binary files
          if (file.mime_type && !file.mime_type.startsWith('text/') &&
              !['application/json', 'application/xml', 'application/yaml',
                'application/javascript', 'application/typescript', 'application/x-sh',
                'application/sql'].includes(file.mime_type)) {
            continue
          }
          const [fileContent, readErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, file.path)
          if (readErr) continue
          const lines = fileContent.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const match = regex.test(lines[i])
            if (match !== invert) {
              matches.push(`${file.path}:${i + 1}:${lines[i]}`)
            }
          }
        }
        return ok(count ? String(matches.length) : matches.join('\n'))
      }
      const [grepContent, grepErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(ctx.args[1]))
      if (grepErr) return err(`grep: ${grepErr}`)
      text = grepContent
    }

    if (!text) return ok(count ? '0' : '')

    const lines = text.split('\n')

    // Without context: simple match
    if (ctxBefore === 0 && ctxAfter === 0) {
      const matched: string[] = []
      for (let i = 0; i < lines.length; i++) {
        const match = regex.test(lines[i])
        if (match !== invert) {
          matched.push(showNumbers ? `${i + 1}:${lines[i]}` : lines[i])
        }
      }
      return ok(count ? String(matched.length) : matched.join('\n'))
    }

    // With context: collect match indices, then build output with separators
    const matchIndices: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]) !== invert) matchIndices.push(i)
    }

    if (count) return ok(String(matchIndices.length))
    if (matchIndices.length === 0) return ok('')

    const included = new Set<number>()
    for (const idx of matchIndices) {
      for (let j = Math.max(0, idx - ctxBefore); j <= Math.min(lines.length - 1, idx + ctxAfter); j++) {
        included.add(j)
      }
    }

    const output: string[] = []
    let lastPrinted = -2
    for (const idx of [...included].sort((a, b) => a - b)) {
      if (lastPrinted >= 0 && idx > lastPrinted + 1) {
        output.push('--')
      }
      const prefix = showNumbers ? `${idx + 1}:` : ''
      output.push(`${prefix}${lines[idx]}`)
      lastPrinted = idx
    }

    return ok(output.join('\n'))
  }
}

const sedHandler: CommandHandler = {
  name: 'sed',
  summary: 'Stream editor (s/// substitution)',
  helpText: [
    'sed \'s/old/new/[g]\' [file]   Regex substitution',
    'sed -i \'s/old/new/[g]\' <file> In-place edit',
    '',
    'Options:',
    '  -i                 Edit file in-place',
  ].join('\n'),
  category: 'text',
  resolvedTools: ['fs_read', 'fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('sed: missing expression')

    const inPlace = !!ctx.flags.i
    const expr = ctx.args[0]

    // Parse s/pattern/replacement/flags
    const match = expr.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/)
    if (!match) return err(`sed: invalid expression: ${expr}`)

    const [, , pattern, replacement, flags] = match
    const regex = new RegExp(pattern, flags.includes('i') ? (flags.includes('g') ? 'gi' : 'i') : (flags.includes('g') ? 'g' : ''))

    let text = ctx.stdin || ''
    let filePath: string | null = null

    // sed 's/old/new/' file.txt — file as second arg
    if (ctx.args.length > 1) {
      filePath = vfsPath(ctx.args[1])
      const [sedContent, sedErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, filePath)
      if (sedErr) return err(`sed: ${sedErr}`)
      text = sedContent
    } else if (!text) {
      return ok('')
    }

    const result = text.split('\n').map(line => line.replace(regex, replacement)).join('\n')

    // In-place: write back to file
    if (inPlace && filePath) {
      const writeResult = await ctx.toolRegistry.executeTool('fs_write', { mode: 'write', path: filePath, content: result }, ctx.workspace)
      if (writeResult.isError) return err(`sed: ${writeResult.content}`)
      return ok('')
    }

    return ok(result)
  }
}

const sortHandler: CommandHandler = {
  name: 'sort',
  summary: 'Sort lines',
  helpText: [
    'sort [file ...]     Sort lines (real GNU-compatible sort via WASM)',
    '',
    'Common options: -r reverse, -n numeric, -u unique, -k <N> key field,',
    '-t <sep> field separator, -f ignore case, -h human-numeric, -V version sort.',
  ].join('\n'),
  category: 'text',
  resolvedTools: ['fs_read'],
  valueFlags: new Set(['k', 't']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    return coreutilsExec('sort', ctx)
  }
}

const uniqHandler: CommandHandler = {
  name: 'uniq',
  summary: 'Deduplicate adjacent lines',
  helpText: [
    'uniq [file]         Remove adjacent duplicate lines (real coreutils)',
    '',
    'Common options: -c count, -d only-duplicates, -i ignore case,',
    '-f <N> skip fields, -s <N> skip chars.',
  ].join('\n'),
  category: 'text',
  resolvedTools: ['fs_read'],
  valueFlags: new Set(['f', 's', 'w']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    return coreutilsExec('uniq', ctx)
  }
}

const wcHandler: CommandHandler = {
  name: 'wc',
  summary: 'Count lines, words, characters',
  helpText: [
    'wc [file ...]       Count lines, words, bytes (real coreutils)',
    '',
    'Common options: -l lines, -w words, -c bytes, -m chars, -L max line length.',
  ].join('\n'),
  category: 'text',
  resolvedTools: ['fs_read'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    return coreutilsExec('wc', ctx)
  }
}

const cutHandler: CommandHandler = {
  name: 'cut',
  summary: 'Extract fields from lines',
  helpText: [
    'cut -d<delim> -f<N> [file]  Extract fields/chars (real coreutils)',
    '',
    'Common options: -d <delim> delimiter, -f <list> fields (1,3-5, 2-),',
    '-c <list> characters, -b <list> bytes.',
  ].join('\n'),
  category: 'text',
  resolvedTools: ['fs_read'],
  valueFlags: new Set(['d', 'f', 'c', 'b']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    return coreutilsExec('cut', ctx)
  }
}

const trHandler: CommandHandler = {
  name: 'tr',
  summary: 'Translate characters',
  helpText: [
    'tr <set1> [set2]     Translate/delete characters (real coreutils)',
    '',
    'Supports ranges (a-z), classes ([:digit:]), -d delete, -s squeeze, -c complement.',
  ].join('\n'),
  category: 'text',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // tr's positionals are character sets, not files
    return coreutilsExec('tr', ctx, { fileArgs: false })
  }
}

const teeHandler: CommandHandler = {
  name: 'tee',
  summary: 'Write to file and pass through',
  helpText: 'tee <path>           Write stdin to file AND pass to stdout',
  category: 'text',
  resolvedTools: ['fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('tee: missing file path')
    const path = vfsPath(ctx.args[0])
    const text = ctx.stdin || ''

    await ctx.toolRegistry.executeTool('fs_write', { mode: 'write', path, content: text }, ctx.workspace)
    return ok(text)
  }
}

const revHandler: CommandHandler = {
  name: 'rev',
  summary: 'Reverse each line',
  helpText: 'rev                  Reverse characters in each line',
  category: 'text',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const text = ctx.stdin || ''
    if (!text) return ok('')
    return ok(text.split('\n').map(l => l.split('').reverse().join('')).join('\n'))
  }
}

const tacHandler: CommandHandler = {
  name: 'tac',
  summary: 'Reverse line order',
  helpText: 'tac                  Print lines in reverse order',
  category: 'text',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const text = ctx.stdin || ''
    if (!text) return ok('')
    return ok(text.split('\n').reverse().join('\n'))
  }
}

const diffHandler: CommandHandler = {
  name: 'diff',
  summary: 'Compare two files',
  helpText: 'diff <file1> <file2>  Line-by-line comparison',
  category: 'text',
  resolvedTools: ['fs_read'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length < 2) return err('diff: usage: diff <file1> <file2>')
    const path1 = vfsPath(ctx.args[0])
    const path2 = vfsPath(ctx.args[1])

    const [content1, err1] = await shellReadFile(ctx.toolRegistry, ctx.workspace, path1)
    if (err1) return err(`diff: ${err1}`)
    const [content2, err2] = await shellReadFile(ctx.toolRegistry, ctx.workspace, path2)
    if (err2) return err(`diff: ${err2}`)

    const lines1 = content1.split('\n')
    const lines2 = content2.split('\n')
    const output: string[] = []

    const maxLen = Math.max(lines1.length, lines2.length)
    for (let i = 0; i < maxLen; i++) {
      const l1 = lines1[i]
      const l2 = lines2[i]
      if (l1 === undefined) {
        output.push(`+ ${l2}`)
      } else if (l2 === undefined) {
        output.push(`- ${l1}`)
      } else if (l1 !== l2) {
        output.push(`- ${l1}`)
        output.push(`+ ${l2}`)
      }
    }

    return ok(output.length === 0 ? '' : output.join('\n'))
  }
}

const xargsHandler: CommandHandler = {
  name: 'xargs',
  summary: 'Run command per input line',
  helpText: [
    'xargs <cmd>          Run command for each line of stdin',
    '',
    'Options:',
    '  -I <placeholder>   Replace placeholder with input line (default: {})',
  ].join('\n'),
  category: 'text',
  resolvedTools: [],  // resolved at runtime based on target command
  valueFlags: new Set(['I']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('xargs: missing command')

    const placeholder = typeof ctx.flags.I === 'string' ? ctx.flags.I : '{}'
    const cmdName = ctx.args[0]
    const cmdArgs = ctx.args.slice(1)
    const text = ctx.stdin || ''
    if (!text) return ok('')

    const lines = text.split('\n').filter(l => l)
    const outputs: string[] = []

    for (const line of lines) {
      const resolvedArgs = cmdArgs.map(a => a === placeholder ? line : a.split(placeholder).join(line))
      // Import dynamically to avoid circular dependency
      const { parse } = await import('../parser/parser')
      const { executeNode } = await import('../executor/pipeline-executor')
      const fullCmd = `${cmdName} ${resolvedArgs.map(a => `"${a}"`).join(' ')}`
      const ast = parse(fullCmd)
      const result = await executeNode(ast, '', {
        workspace: ctx.workspace,
        toolRegistry: ctx.toolRegistry,
        config: ctx.config,
        env: ctx.env,
        gate: ctx.gate, // forward gating to the spawned sub-command
      })
      if (result.exit_code !== 0) return result
      if (result.stdout) outputs.push(result.stdout)
    }

    return ok(outputs.join('\n'))
  }
}

const seqHandler: CommandHandler = {
  name: 'seq',
  summary: 'Generate number sequence',
  helpText: [
    'seq <last>           Print 1 to last',
    'seq <first> <last>   Print first to last',
    'seq <first> <inc> <last>  Print with increment',
  ].join('\n'),
  category: 'text',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    let first = 1, inc = 1, last = 1
    if (ctx.args.length === 1) {
      last = parseInt(ctx.args[0], 10)
    } else if (ctx.args.length === 2) {
      first = parseInt(ctx.args[0], 10)
      last = parseInt(ctx.args[1], 10)
    } else if (ctx.args.length >= 3) {
      first = parseInt(ctx.args[0], 10)
      inc = parseInt(ctx.args[1], 10)
      last = parseInt(ctx.args[2], 10)
    }
    if (isNaN(first) || isNaN(inc) || isNaN(last) || inc === 0) return err('seq: invalid arguments')
    const nums: number[] = []
    const maxItems = 10000
    if (inc > 0) {
      for (let i = first; i <= last && nums.length < maxItems; i += inc) nums.push(i)
    } else {
      for (let i = first; i >= last && nums.length < maxItems; i += inc) nums.push(i)
    }
    return ok(nums.join('\n'))
  }
}

const printfHandler: CommandHandler = {
  name: 'printf',
  summary: 'Format and print text',
  helpText: [
    'printf <format> [args...]  Format and print text',
    '',
    'Supports: %s (string), %d (integer), %f (float), %% (literal %)',
    'Escape sequences: \\n, \\t, \\r, \\\\',
  ].join('\n'),
  category: 'text',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('printf: missing format string')
    const fmt = interpretEscapes(ctx.args[0])
    const fmtArgs = ctx.args.slice(1)

    let argIdx = 0
    const result = fmt.replace(/%([sdfe%])/g, (match, spec) => {
      if (spec === '%') return '%'
      const arg = fmtArgs[argIdx++] ?? ''
      switch (spec) {
        case 's': return arg
        case 'd': return String(parseInt(arg, 10) || 0)
        case 'f': case 'e': return String(parseFloat(arg) || 0)
        default: return match
      }
    })
    return ok(result)
  }
}

export const textHandlers: CommandHandler[] = [
  grepHandler, sedHandler, sortHandler, uniqHandler, wcHandler,
  cutHandler, trHandler, teeHandler, revHandler, tacHandler,
  diffHandler, xargsHandler, seqHandler, printfHandler,
]
