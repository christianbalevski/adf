/**
 * Text processing builtins: grep, sed, sort, uniq, wc, cut, tr, tee, rev, tac, diff, xargs
 * Pure string operations on stdin.
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'
import type { ArgumentNode } from '../parser/ast'
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

  // Applets whose -o/--output writes a file inside the sandbox FS would succeed
  // silently and lose the output when the worker's FS is torn down. Reject only
  // for those applets (so `wc -o` still gets the applet's own "invalid option"),
  // and catch all forms: -o, -oFILE, --output, --output=FILE.
  const OUTPUT_APPLETS = new Set(['sort', 'shuf'])
  if (OUTPUT_APPLETS.has(applet)) {
    // uutils/clap accepts any unambiguous long-flag abbreviation, so `--out`,
    // `--outp=x` etc. all mean --output. sort/shuf have no other `--o*` long
    // option, so reject any -o short form or `--o…` long form.
    const badFlag = argv.find(a => /^-o/.test(a) || /^--o/.test(a))
    if (badFlag) {
      return err(`${applet}: writing to a file (${badFlag}) is not supported in the sandbox — redirect stdout instead (e.g. \`${applet} ... > out.txt\`)`)
    }
  }
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
    // Preserve partial stdout on nonzero exit (e.g. `sort good.txt missing.txt`
    // still sorts good.txt) instead of discarding it.
    if (exitCode !== 0) {
      return { exit_code: exitCode, stdout, stderr: stderr.trim() || `${applet}: exit ${exitCode}` }
    }
    // Preserve exact bytes (incl. any trailing newline) — stripping it broke
    // byte-faithful pipelines (checksums, concatenation, wc -c).
    return ok(stdout)
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

    const noFilename = !!ctx.flags.h   // -h: suppress filename prefix
    const forceFilename = !!ctx.flags.H // -H: force filename prefix

    /** Emit the matching pieces of one line (respects -o). Under -o, empty
     *  (zero-width) matches are dropped — GNU prints nothing for those. */
    const emit = (line: string, prefix: string, out: string[]): number => {
      if (onlyMatching && oRe) {
        const found = (line.match(oRe) ?? []).filter(m => m.length > 0)
        if (found.length === 0) return 0
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

      // Filename prefix: on by default in multi-file/recursive; -h suppresses.
      const withName = forceFilename || !noFilename
      const out: string[] = []
      const counts: string[] = []       // `path:count` for -c
      const matchedFiles: string[] = [] // for -l
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
            if (!listFiles && !quiet && !count) {
              // GNU: path:content by default, path:N:content only with -n
              const prefix = `${withName ? `${file.path}:` : ''}${showNumbers ? `${i + 1}:` : ''}`
              emit(lines[i], prefix, out)
            }
          }
        }
        if (count) counts.push(`${withName ? `${file.path}:` : ''}${fileMatches}`)
        if (fileMatches > 0) matchedFiles.push(file.path)
      }
      if (quiet) return { exit_code: anyMatch ? 0 : 1, stdout: '', stderr: '' }
      if (listFiles) return matchedFiles.length > 0 ? ok(matchedFiles.join('\n')) : { exit_code: 1, stdout: '', stderr: '' }
      if (count) return { exit_code: anyMatch ? 0 : 1, stdout: counts.join('\n'), stderr: '' }
      // Exit tracks line selection (anyMatch), not emitted pieces — so `-o` on a
      // zero-width match still exits 0 with no output, like GNU.
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
      // No input → no match: exit 1 (grep convention). '0' for -c, but -q
      // stays silent (quiet wins over count).
      return { exit_code: 1, stdout: !quiet && count ? '0' : '', stderr: '' }
    }

    const lines = splitLines(text)
    const matchIdx: number[] = []
    for (let i = 0; i < lines.length && matchIdx.length < maxCount; i++) {
      if (lineRe.test(lines[i]) !== invert) matchIdx.push(i)
    }

    if (quiet) return { exit_code: matchIdx.length > 0 ? 0 : 1, stdout: '', stderr: '' }
    if (count) return { exit_code: matchIdx.length > 0 ? 0 : 1, stdout: String(matchIdx.length), stderr: '' }
    if (matchIdx.length === 0) return { exit_code: 1, stdout: '', stderr: '' }

    const out: string[] = []
    if (ctxBefore === 0 && ctxAfter === 0) {
      // matchIdx.length > 0 here (empty case returned above), so a line was
      // selected → exit 0 even if -o emits nothing for zero-width matches
      // (matches GNU: exit tracks line selection, not printed pieces).
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

/** Render a sed replacement template against one match. Uses a replacer
 *  CALLBACK (not a JS replacement string) so we fully control backref
 *  semantics: `&` and `\0` = whole match, `\1`..`\9` = capture groups (GNU
 *  supports only single-digit, so `\10` = group 1 then literal '0'), `\&` =
 *  literal &, `\n`/`\t` = newline/tab, `\\` = backslash. A literal `$` stays
 *  literal (JS `$`-interpretation is bypassed entirely). */
function renderSedReplacement(template: string, matchArgs: unknown[]): string {
  // String.replace callback args: (match, p1, .., offset, whole[, namedGroups]).
  // The offset is the first number, so groups = everything before it — robust
  // whether or not a trailing named-groups object is present.
  const offsetIdx = matchArgs.findIndex(a => typeof a === 'number')
  const groups = offsetIdx > 0 ? matchArgs.slice(0, offsetIdx) : [matchArgs[0]]
  let out = ''
  for (let i = 0; i < template.length; i++) {
    const c = template[i]
    if (c === '\\') {
      const n = template[i + 1]
      if (n === undefined) { out += '\\'; break }
      if (n >= '0' && n <= '9') out += String(groups[Number(n)] ?? '')
      else if (n === '&') out += '&'
      else if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else out += n // \\ → \, \x → x
      i++
    } else if (c === '&') {
      out += String(groups[0] ?? '')
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
    const replacer = (...matchArgs: unknown[]) => renderSedReplacement(rawReplacement, matchArgs)

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

    const result = text.split('\n').map(line => line.replace(regex, replacer as never)).join('\n')

    if (inPlace && filePath) {
      // Preserve exact file content (incl. trailing newline) on write-back.
      const writeResult = await ctx.toolRegistry.executeTool('fs_write', { mode: 'write', path: filePath, content: result }, ctx.workspace)
      if (writeResult.isError) return err(`sed: ${writeResult.content}`)
      return ok('')
    }

    // Preserve exact bytes (byte-faithful pipelines).
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

/** Static pre-gate hook for stdin-or-file commands: any arg that could be a
 *  file path means fs_read must be gated. Args we can't inspect statically
 *  (variables, substitutions, quoted mixes) count as files — over-gating is
 *  the safe direction. */
function fileArgsResolveTools(args: ArgumentNode[]): string[] {
  const hasFileArg = args.some(a => a.type !== 'literal' || !a.value.startsWith('-'))
  return hasFileArg ? ['fs_read'] : []
}

/** Read positional file args (concatenated, like cat) or fall back to stdin.
 *  Returns [text, null] on success, [null, errorResult] on a failed read. */
async function readFileArgsOrStdin(cmd: string, ctx: CommandContext): Promise<[string, null] | [null, CommandResult]> {
  if (ctx.args.length === 0) return [ctx.stdin || '', null]
  const parts: string[] = []
  for (const rawPath of ctx.args) {
    const [content, readErr] = await shellReadFile(ctx.toolRegistry, ctx.workspace, vfsPath(rawPath))
    if (readErr !== null) return [null, err(`${cmd}: ${readErr}`)]
    parts.push(content)
  }
  return [parts.join(''), null]
}

const revHandler: CommandHandler = {
  name: 'rev',
  summary: 'Reverse each line',
  helpText: 'rev [file ...]       Reverse characters in each line (files or stdin)',
  category: 'text',
  resolvedTools: [],
  resolveToolsFromArgs: fileArgsResolveTools,

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // File args were silently ignored (stdin-only) — `rev file.txt` returned
    // empty. Read them like the other text commands; stdin when no args.
    const [text, readError] = await readFileArgsOrStdin('rev', ctx)
    if (readError !== null) return readError
    if (!text) return ok('')
    return ok(text.split('\n').map(l => l.split('').reverse().join('')).join('\n'))
  }
}

const tacHandler: CommandHandler = {
  name: 'tac',
  summary: 'Reverse line order',
  helpText: 'tac [file ...]       Print lines in reverse order (files or stdin)',
  category: 'text',
  resolvedTools: [],
  resolveToolsFromArgs: fileArgsResolveTools,

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const [text, readError] = await readFileArgsOrStdin('tac', ctx)
    if (readError !== null) return readError
    if (!text) return ok('')
    // splitLines drops the phantom empty line a terminating newline produces,
    // so tac of "a\nb\n" is "b\na" — not a leading blank line.
    return ok(splitLines(text).reverse().join('\n'))
  }
}

/** One op of a line diff: ' ' common, '-' only in the left file, '+' only in
 *  the right file. */
interface DiffOp { t: ' ' | '-' | '+'; line: string }

/** LCS-based line diff. The old per-index compare turned a single inserted
 *  line into a wall of -/+ noise for everything after it. Falls back to the
 *  per-index compare when the DP table would be too large — output stays
 *  correct (exit 1, all changes shown), just not minimal. */
function lineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length
  const ops: DiffOp[] = []
  if ((n + 1) * (m + 1) > 4_000_000) {
    const maxLen = Math.max(n, m)
    for (let i = 0; i < maxLen; i++) {
      if (i < n && i < m && a[i] === b[i]) ops.push({ t: ' ', line: a[i] })
      else {
        if (i < n) ops.push({ t: '-', line: a[i] })
        if (i < m) ops.push({ t: '+', line: b[i] })
      }
    }
    return ops
  }
  // dp[i][j] = LCS length of a[i..] vs b[j..], flattened row-major.
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++ }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) ops.push({ t: '-', line: a[i++] })
    else ops.push({ t: '+', line: b[j++] })
  }
  while (i < n) ops.push({ t: '-', line: a[i++] })
  while (j < m) ops.push({ t: '+', line: b[j++] })
  return ops
}

/** Render diff ops as unified-style hunks with `context` common lines. */
function formatUnifiedDiff(file1: string, file2: string, ops: DiffOp[], context = 3): string {
  // 1-based old/new line numbers at each op index.
  const oldAt: number[] = [], newAt: number[] = []
  let ol = 1, nl = 1
  for (const op of ops) {
    oldAt.push(ol); newAt.push(nl)
    if (op.t !== '+') ol++
    if (op.t !== '-') nl++
  }
  // Merge changed-op indices into hunk ranges (± context, coalescing overlaps).
  const changed = ops.map((op, idx) => (op.t === ' ' ? -1 : idx)).filter(x => x >= 0)
  const ranges: Array<[number, number]> = []
  let start = Math.max(0, changed[0] - context)
  let end = Math.min(ops.length - 1, changed[0] + context)
  for (const c of changed.slice(1)) {
    if (c - context <= end + 1) end = Math.min(ops.length - 1, c + context)
    else { ranges.push([start, end]); start = Math.max(0, c - context); end = Math.min(ops.length - 1, c + context) }
  }
  ranges.push([start, end])

  const out = [`--- ${file1}`, `+++ ${file2}`]
  for (const [rs, re] of ranges) {
    let oldCount = 0, newCount = 0
    for (let k = rs; k <= re; k++) {
      if (ops[k].t !== '+') oldCount++
      if (ops[k].t !== '-') newCount++
    }
    out.push(`@@ -${oldAt[rs]},${oldCount} +${newAt[rs]},${newCount} @@`)
    for (let k = rs; k <= re; k++) out.push(`${ops[k].t}${ops[k].line}`)
  }
  return out.join('\n')
}

const DIFF_KNOWN_FLAGS = new Set(['u', 'q'])

const diffHandler: CommandHandler = {
  name: 'diff',
  summary: 'Compare two files',
  helpText: [
    'diff <file1> <file2>  Compare files (unified-style output)',
    '',
    'Exit codes (bash semantics): 0 = identical (no output), 1 = files differ,',
    '2 = error (missing file, unsupported option).',
    'Options: -u accepted (output is already unified-style), -q report-only.',
  ].join('\n'),
  category: 'text',
  resolvedTools: ['fs_read'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const unknown = Object.keys(ctx.flags).filter(f => !DIFF_KNOWN_FLAGS.has(f))
    if (unknown.length > 0) {
      return err(`diff: unsupported option${unknown.length > 1 ? 's' : ''}: ${unknown.map(f => (f.length === 1 ? '-' : '--') + f).join(', ')}`, 2)
    }
    if (ctx.args.length < 2) return err('diff: usage: diff <file1> <file2>', 2)
    const path1 = vfsPath(ctx.args[0])
    const path2 = vfsPath(ctx.args[1])

    const [row1, err1] = await shellReadFileRow(ctx.toolRegistry, ctx.workspace, path1)
    if (err1 !== null) return err(`diff: ${ctx.args[0]}: ${err1}`, 2)
    const [row2, err2] = await shellReadFileRow(ctx.toolRegistry, ctx.workspace, path2)
    if (err2 !== null) return err(`diff: ${ctx.args[1]}: ${err2}`, 2)

    // Binary content comes back base64 — line-diffing that is gibberish.
    // Compare for equality and report honestly (GNU behavior).
    if (!isTextRow(row1) || !isTextRow(row2)) {
      if (isTextRow(row1) === isTextRow(row2) && row1.content === row2.content) return ok('')
      return { exit_code: 1, stdout: `Binary files ${path1} and ${path2} differ`, stderr: '' }
    }

    if (row1.content === row2.content) return ok('') // identical → no output, exit 0
    if (ctx.flags.q) return { exit_code: 1, stdout: `Files ${path1} and ${path2} differ`, stderr: '' }

    const ops = lineDiff(splitLines(row1.content), splitLines(row2.content))
    if (!ops.some(o => o.t !== ' ')) {
      // Same lines, different bytes → only the trailing newline differs.
      return { exit_code: 1, stdout: `Files ${path1} and ${path2} differ only in a trailing newline`, stderr: '' }
    }
    return { exit_code: 1, stdout: formatUnifiedDiff(path1, path2, ops), stderr: '' }
  }
}

/** Single-quote a string for re-parsing by the shell: the content becomes one
 *  literal argument — no variable/substitution expansion, no operator or flag
 *  re-parsing of embedded |;&&><, no glob expansion. Embedded single quotes
 *  use the standard close-escape-reopen dance ('\''), which the tokenizer's
 *  glued-token handling reassembles into one argument. */
function shellQuote(s: string): string {
  return `'` + s.split(`'`).join(`'\\''`) + `'`
}

const xargsHandler: CommandHandler = {
  name: 'xargs',
  summary: 'Build and run a command from stdin',
  helpText: [
    'xargs <cmd> [args]   Append whitespace-split stdin items as arguments',
    'xargs -n N <cmd>     Same, but run one invocation per batch of N items',
    'xargs -I {} <cmd>    Run command once per input LINE, substituting {}',
    '',
    'Options:',
    '  -I <placeholder>   Per-line substitution mode (e.g. -I {})',
    '  -n <count>         Batch mode: split stdin items into groups of <count>',
    '                     and run the command once per group, sequentially.',
    '                     Later batches still run if one fails; the exit code is',
    '                     the HIGHEST batch exit code (real xargs collapses any',
    '                     failure to 123 — we keep the real code instead). A',
    '                     batch blocked by tool gating (exit 126/130) stops the',
    '                     remaining batches. Cannot be combined with -I.',
    '',
    'Default mode (no -I/-n) follows real xargs: stdin is split on whitespace and',
    'the items are appended to the command — but as ONE invocation (real xargs',
    'batches by ARG_MAX; use -n for explicit batching). Items are passed as',
    'literal arguments; {} is only special with -I.',
    'Example: ls | jq -r \'.[].path\' | xargs -n 10 rm',
  ].join('\n'),
  category: 'text',
  resolvedTools: [],  // resolved at runtime based on target command
  valueFlags: new Set(['I', 'n']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('xargs: missing command')

    const cmdName = ctx.args[0]
    const cmdArgs = ctx.args.slice(1)
    const text = ctx.stdin || ''

    // -n N: batch size for default mode. Validate BEFORE the empty-stdin
    // early-return so a bad flag never silently "works" on empty input.
    let batchSize: number | undefined
    if ('n' in ctx.flags) {
      if (ctx.flags.I !== undefined) {
        // Real xargs silently ignores -n when -I is given; we refuse loudly
        // instead (fail plainly, never silently ignore).
        return err('xargs: -n cannot be combined with -I (real xargs silently ignores -n here; we refuse instead — -I already runs one invocation per line, so drop -n)')
      }
      const rawFlag = ctx.flags.n
      const raw = Array.isArray(rawFlag) ? rawFlag[rawFlag.length - 1] : rawFlag
      if (raw === true) return err('xargs: -n requires a count (e.g. -n 2)')
      const n = /^-?\d+$/.test(String(raw)) ? parseInt(String(raw), 10) : NaN
      if (!Number.isInteger(n) || n <= 0) {
        return err(`xargs: -n: invalid number '${raw}'`)
      }
      batchSize = n
    }

    if (!text) return ok('')

    // Import dynamically to avoid circular dependency. Both modes re-enter
    // parse+executeNode with the gate forwarded, so the per-command gate
    // evaluates the FINAL built command (this is the single choke point —
    // never dispatch the target command's tools directly from here).
    const { parse } = await import('../parser/parser')
    const { executeNode } = await import('../executor/pipeline-executor')
    const subCtx = {
      workspace: ctx.workspace,
      toolRegistry: ctx.toolRegistry,
      config: ctx.config,
      env: ctx.env,
      gate: ctx.gate,   // forward gating to the spawned sub-command
      signal: ctx.signal, // forward abort so a cancelled shell stops xargs
      depth: (ctx.depth ?? 0) + 1,
    }

    // -I mode: one invocation per LINE, placeholder substituted (unchanged).
    if (ctx.flags.I !== undefined) {
      const placeholder = typeof ctx.flags.I === 'string' ? ctx.flags.I : '{}'
      const lines = text.split('\n').filter(l => l)
      const outputs: string[] = []

      for (const line of lines) {
        const resolvedArgs = cmdArgs.map(a => a === placeholder ? line : a.split(placeholder).join(line))
        const fullCmd = `${cmdName} ${resolvedArgs.map(a => `"${a}"`).join(' ')}`
        const ast = parse(fullCmd)
        const result = await executeNode(ast, '', subCtx)
        if (ctx.signal?.aborted) return err('xargs: aborted', 130)
        if (result.exit_code !== 0) return result
        if (result.stdout) outputs.push(result.stdout)
      }

      return ok(outputs.join('\n'))
    }

    // Default mode: real-xargs contract — split stdin on whitespace/newlines
    // and APPEND the items as arguments (previously the items were silently
    // dropped, so `ls | xargs rm` failed with "missing file path"). Without
    // -n, ONE invocation carries all items (real xargs batches by ARG_MAX —
    // documented deviation); with -n N the items run in sequential batches of
    // N, each batch re-entering the gated executor so per-invocation gating is
    // identical to the single-shot path. Items are DATA: each is single-quoted
    // so a filename can never be re-parsed as an operator/substitution/glob,
    // mirroring how -I builds its command. Template args are re-quoted the
    // same way (they were already resolved once; quoting keeps them verbatim —
    // a resolved "-f" still parses as a flag, since flag parsing happens
    // post-resolution).
    const items = text.split(/\s+/).filter(Boolean)
    const size = batchSize ?? items.length
    const outputs: string[] = []
    const errors: string[] = []
    let worstExit = 0
    for (let i = 0; i < items.length; i += size) {
      if (ctx.signal?.aborted) return err('xargs: aborted', 130)
      const batch = items.slice(i, i + size)
      const fullCmd = [cmdName, ...cmdArgs.map(shellQuote), ...batch.map(shellQuote)].join(' ')
      const ast = parse(fullCmd)
      const result = await executeNode(ast, '', subCtx)
      if (ctx.signal?.aborted) return err('xargs: aborted', 130)
      if (result.stdout) outputs.push(result.stdout)
      if (result.stderr) errors.push(result.stderr)
      worstExit = Math.max(worstExit, result.exit_code)
      // Gate signals end the run: 126 = tool disabled (every later batch would
      // fail identically), 130 = intercepted/awaiting approval (a task was
      // created — spawning one per remaining batch would spam approvals).
      if (result.exit_code === 126 || result.exit_code === 130) {
        return { exit_code: result.exit_code, stdout: outputs.join(''), stderr: errors.join('\n') }
      }
      // Ordinary failures don't stop later batches (real-xargs behavior);
      // exit code aggregates to the highest batch exit (documented deviation
      // from real xargs's blanket 123).
    }
    return { exit_code: worstExit, stdout: outputs.join(''), stderr: errors.join('\n') }
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
    // Bound output, but error rather than silently truncating a longer range.
    const maxItems = 100000
    const estimated = Math.floor((last - first) / inc) + 1
    if (estimated > maxItems) {
      return err(`seq: range too large (${estimated} items > ${maxItems} limit)`)
    }
    const nums: number[] = []
    if (inc > 0) {
      for (let i = first; i <= last; i += inc) nums.push(i)
    } else {
      for (let i = first; i >= last; i += inc) nums.push(i)
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

    // POSIX: the format string is REUSED until all arguments are consumed
    // (`printf '%s\n' a b` → "a\nb\n"). If it has no consuming conversions,
    // it's printed once. Previously the format ran once and dropped extra args.
    const consumingSpecs = (fmt.match(/%[sdfe]/g) ?? []).length
    if (consumingSpecs === 0) return ok(fmt)

    let out = ''
    let argIdx = 0
    do {
      out += fmt.replace(/%([sdfe%])/g, (match, spec) => {
        if (spec === '%') return '%'
        const arg = fmtArgs[argIdx++] ?? ''
        switch (spec) {
          case 's': return arg
          case 'd': return String(parseInt(arg, 10) || 0)
          case 'f': case 'e': return String(parseFloat(arg) || 0)
          default: return match
        }
      })
    } while (argIdx < fmtArgs.length)
    return ok(out)
  }
}

export const textHandlers: CommandHandler[] = [
  grepHandler, sedHandler, sortHandler, uniqHandler, wcHandler,
  cutHandler, trHandler, teeHandler, revHandler, tacHandler,
  diffHandler, xargsHandler, seqHandler, printfHandler,
]
