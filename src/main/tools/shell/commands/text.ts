/**
 * Text processing builtins: grep, sed, sort, uniq, wc, cut, tr, tee, rev, tac, diff, xargs
 * Pure string operations on stdin.
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'
import { shellReadFile, shellReadFileRow, isTextRow, isTextMime } from './fs-read-helper'
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

/** Escape a string for use as a literal regex (grep -F). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split into lines, dropping the phantom empty line a terminating newline
 *  produces — so `grep -v` / `grep -c` don't count it as a line (GNU behavior). */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Flags grep understands. Anything else is rejected (fail loud, not silent). */
const GREP_KNOWN_FLAGS = new Set([
  'i', 'v', 'c', 'n', 'r', 'R', 'o', 'F', 'w', 'x', 'l', 'q', 'm', 'E', 'e', 'h', 'H',
  'A', 'B', 'C', 'include', 'exclude',
])

const grepHandler: CommandHandler = {
  name: 'grep',
  summary: 'Filter lines matching a pattern',
  helpText: [
    'grep <pattern> [file]   Filter lines matching a regex (ERE-style, JS regex)',
    '',
    'Supported: -i case-insensitive, -v invert, -c count, -n line numbers,',
    '  -r recursive (VFS), -o only-matching, -F fixed string, -w word match,',
    '  -x whole-line, -l files-with-matches, -q quiet, -m <N> max matches,',
    '  -e <pat>, -A/-B/-C <N> context, --include/--exclude=<glob>.',
    'Unsupported flags (e.g. -P) are rejected, not ignored. Regex is JS/ERE:',
    '  -P (PCRE) and BRE-only escapes are not supported.',
  ].join('\n'),
  category: 'text',
  resolvedTools: [],  // pure text operation; -r uses fs_list + fs_read
  valueFlags: new Set(['A', 'B', 'C', 'm', 'e']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // Honesty: reject flags we don't implement instead of silently no-op'ing.
    const unknown = Object.keys(ctx.flags).filter(f => !GREP_KNOWN_FLAGS.has(f))
    if (unknown.length > 0) {
      return err(`grep: unsupported option${unknown.length > 1 ? 's' : ''}: ${unknown.map(f => (f.length === 1 ? '-' : '--') + f).join(', ')}`)
    }

    // Pattern: -e <pat> takes it from the flag (then all positionals are files),
    // otherwise the first positional is the pattern.
    const patternFromE = typeof ctx.flags.e === 'string' ? ctx.flags.e : undefined
    const pattern = patternFromE ?? ctx.args[0]
    if (pattern === undefined) return err('grep: missing pattern')
    const fileArgs = patternFromE ? ctx.args : ctx.args.slice(1)

    const ignoreCase = !!ctx.flags.i
    const invert = !!ctx.flags.v
    const count = !!ctx.flags.c
    const showNumbers = !!ctx.flags.n
    const recursive = !!ctx.flags.r || !!ctx.flags.R
    const onlyMatching = !!ctx.flags.o
    const listFiles = !!ctx.flags.l
    const quiet = !!ctx.flags.q
    const maxCount = typeof ctx.flags.m === 'string' ? parseInt(ctx.flags.m, 10) : Infinity
    const afterCtx = typeof ctx.flags.A === 'string' ? parseInt(ctx.flags.A, 10) : 0
    const beforeCtx = typeof ctx.flags.B === 'string' ? parseInt(ctx.flags.B, 10) : 0
    const aroundCtx = typeof ctx.flags.C === 'string' ? parseInt(ctx.flags.C, 10) : 0
    const ctxBefore = aroundCtx || beforeCtx
    const ctxAfter = aroundCtx || afterCtx

    // Build the matcher: -F literal, -w word boundary, -x whole line.
    let src = ctx.flags.F ? escapeRegExp(pattern) : pattern
    if (ctx.flags.w) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`
    if (ctx.flags.x) src = `^(?:${src})$`
    let lineRe: RegExp
    let oRe: RegExp | null = null
    try {
      lineRe = new RegExp(src, ignoreCase ? 'i' : '')
      if (onlyMatching) oRe = new RegExp(src, ignoreCase ? 'ig' : 'g')
    } catch (e) {
      return err(`grep: invalid pattern: ${e instanceof Error ? e.message : String(pattern)}`)
    }

    const globToRe = (g?: string) => g
      ? new RegExp('^' + g.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      : undefined
    const includeRe = globToRe(typeof ctx.flags.include === 'string' ? ctx.flags.include : undefined)
    const excludeRe = globToRe(typeof ctx.flags.exclude === 'string' ? ctx.flags.exclude : undefined)

    /** Emit the matching pieces of one line (respects -o). */
    const emit = (line: string, prefix: string, out: string[]): number => {
      if (onlyMatching && oRe) {
        const found = line.match(oRe)
        if (!found) return 0
        for (const m of found) out.push(`${prefix}${m}`)
        return found.length
      }
      out.push(`${prefix}${line}`)
      return 1
    }

    // ── Recursive / multi-file mode ──
    if (recursive || fileArgs.length > 1 || (fileArgs.length === 1 && (listFiles || recursive))) {
      const startPath = vfsPath(fileArgs[0] ?? '')
      const all = ctx.workspace.listFiles()
      let files = recursive
        ? (startPath ? all.filter(f => f.path.startsWith(startPath)) : all)
        : all.filter(f => fileArgs.map(vfsPath).includes(f.path))
      if (includeRe) files = files.filter(f => includeRe.test(f.path.split('/').pop() ?? f.path))
      if (excludeRe) files = files.filter(f => !excludeRe.test(f.path.split('/').pop() ?? f.path))

      const out: string[] = []
      const matchedFiles: string[] = []
      let anyMatch = false
      for (const file of files) {
        if (file.mime_type && !isTextMime(file.mime_type)) continue
        const [content, readErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, file.path)
        if (readErr) continue
        const lines = splitLines(content)
        let fileMatches = 0
        for (let i = 0; i < lines.length && fileMatches < maxCount; i++) {
          if (lineRe.test(lines[i]) !== invert) {
            anyMatch = true
            fileMatches++
            if (!listFiles && !quiet && !count) emit(lines[i], `${file.path}:${i + 1}:`, out)
          }
        }
        if (fileMatches > 0) matchedFiles.push(file.path)
      }
      if (quiet) return { exit_code: anyMatch ? 0 : 1, stdout: '', stderr: '' }
      if (listFiles) return ok(matchedFiles.join('\n'))
      if (count) return ok(String(matchedFiles.reduce((n, _) => n, out.length) || out.length))
      return anyMatch ? ok(out.join('\n')) : { exit_code: 1, stdout: '', stderr: '' }
    }

    // ── Single-file / stdin mode ──
    let text = ctx.stdin
    if (fileArgs.length === 1) {
      const [content, readErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(fileArgs[0]))
      if (readErr) return err(`grep: ${fileArgs[0]}: No such file or directory`)
      text = content
    }
    if (!text) {
      if (quiet) return { exit_code: 1, stdout: '', stderr: '' }
      return count ? ok('0') : { exit_code: 1, stdout: '', stderr: '' }
    }

    const lines = splitLines(text)
    const matchIdx: number[] = []
    for (let i = 0; i < lines.length && matchIdx.length < maxCount; i++) {
      if (lineRe.test(lines[i]) !== invert) matchIdx.push(i)
    }

    if (quiet) return { exit_code: matchIdx.length > 0 ? 0 : 1, stdout: '', stderr: '' }
    if (count) return ok(String(matchIdx.length))
    if (matchIdx.length === 0) return { exit_code: 1, stdout: '', stderr: '' }

    const out: string[] = []
    if (ctxBefore === 0 && ctxAfter === 0) {
      for (const i of matchIdx) emit(lines[i], showNumbers ? `${i + 1}:` : '', out)
      return ok(out.join('\n'))
    }

    // With context (-A/-B/-C): -o is ignored for context lines (GNU prints full lines)
    const included = new Set<number>()
    for (const idx of matchIdx) {
      for (let j = Math.max(0, idx - ctxBefore); j <= Math.min(lines.length - 1, idx + ctxAfter); j++) included.add(j)
    }
    let lastPrinted = -2
    for (const idx of [...included].sort((a, b) => a - b)) {
      if (lastPrinted >= 0 && idx > lastPrinted + 1) out.push('--')
      out.push(`${showNumbers ? `${idx + 1}:` : ''}${lines[idx]}`)
      lastPrinted = idx
    }
    return ok(out.join('\n'))
  }
}

/** Translate a sed replacement string to a JS String.replace replacement:
 *  `&` → whole match ($&), `\1`..`\9` → capture groups ($1..$9), `\&` → literal
 *  &, `\n`/`\t` → newline/tab, `\\` → backslash; a literal `$` is escaped to $$
 *  so JS doesn't interpret it. (Was the source of silent corruption: `&` and
 *  backrefs came out literally.) */
function sedReplacement(repl: string): string {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i]
    if (c === '\\') {
      const n = repl[i + 1]
      if (n === undefined) { out += '\\'; break }
      if (n >= '0' && n <= '9') out += '$' + n
      else if (n === '&') out += '&'
      else if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else out += n // \\ → \, \x → x
      i++
    } else if (c === '&') {
      out += '$&'
    } else if (c === '$') {
      out += '$$'
    } else {
      out += c
    }
  }
  return out
}

const SED_KNOWN_FLAGS = new Set(['i', 'E', 'r'])

const sedHandler: CommandHandler = {
  name: 'sed',
  summary: 'Stream editor (s/// substitution)',
  helpText: [
    'sed \'s/old/new/[gi]\' [file]   Regex substitution (JS/ERE regex)',
    'sed -i \'s/old/new/\' <file>     In-place edit',
    '',
    'Replacement: & = whole match, \\1..\\9 = capture groups, \\n \\t supported.',
    'Options: -i in-place, -E/-r extended regex (default). Addresses (1p, /re/d)',
    'and -n are NOT supported — they error rather than silently misbehave.',
  ].join('\n'),
  category: 'text',
  resolvedTools: ['fs_read', 'fs_write'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('sed: missing expression')

    const unknown = Object.keys(ctx.flags).filter(f => !SED_KNOWN_FLAGS.has(f))
    if (unknown.length > 0) {
      return err(`sed: unsupported option${unknown.length > 1 ? 's' : ''}: ${unknown.map(f => (f.length === 1 ? '-' : '--') + f).join(', ')} (only s/// substitution is supported)`)
    }

    const inPlace = !!ctx.flags.i
    const expr = ctx.args[0]

    // Parse s<delim>pattern<delim>replacement<delim>flags
    const match = expr.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/)
    if (!match) return err(`sed: unsupported expression "${expr}" — only s/old/new/[gi] is supported`)

    const [, , pattern, rawReplacement, flags] = match
    let regex: RegExp
    try {
      regex = new RegExp(pattern, (flags.includes('i') ? 'i' : '') + (flags.includes('g') ? 'g' : ''))
    } catch (e) {
      return err(`sed: invalid pattern: ${e instanceof Error ? e.message : pattern}`)
    }
    const replacement = sedReplacement(rawReplacement)

    let text = ctx.stdin || ''
    let filePath: string | null = null

    // sed 's/old/new/' file.txt — file as second arg
    if (ctx.args.length > 1) {
      filePath = vfsPath(ctx.args[1])
      const [sedContent, sedErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, filePath)
      if (sedErr) return err(`sed: ${filePath}: No such file or directory`)
      text = sedContent
    } else if (!text) {
      return ok('')
    }

    const result = text.split('\n').map(line => line.replace(regex, replacement)).join('\n')

    if (inPlace && filePath) {
      // Preserve exact file content (incl. trailing newline) on write-back.
      const writeResult = await ctx.toolRegistry.executeTool('fs_write', { mode: 'write', path: filePath, content: result }, ctx.workspace)
      if (writeResult.isError) return err(`sed: ${writeResult.content}`)
      return ok('')
    }

    // Strip one trailing newline on stdout, matching the other text commands.
    return ok(result.replace(/\n$/, ''))
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
    // Read numeric tokens from rawArgs so a negative first value (`seq -5 5`)
    // isn't mis-parsed as a flag. (The flag parser can't tell `seq -5` from
    // `head -5`, so seq handles its own numeric args.)
    const nums0 = (ctx.rawArgs ?? ctx.args).filter(t => /^-?\d+(\.\d+)?$/.test(t)).map(Number)
    let first = 1, inc = 1, last = 1
    if (nums0.length === 1) {
      last = nums0[0]
    } else if (nums0.length === 2) {
      first = nums0[0]; last = nums0[1]
    } else if (nums0.length >= 3) {
      first = nums0[0]; inc = nums0[1]; last = nums0[2]
    } else {
      return err('seq: missing operand')
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
