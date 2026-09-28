// The one $EDITOR helper for every view (files, loops, inspect). Resolve the
// editor, write text to a temp file, run the editor attached to the terminal,
// read the result back. Callers hand the terminal over with ink's
// `useApp().suspendTerminal(run)` for the duration.

import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Split a command line, honoring "double" and 'single' quotes. */
export function splitCommand(command: string): string[] {
  const out: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(command))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return true
  }
  return false
}

/** `ADF_EDITOR`, `VISUAL`, `EDITOR`, then notepad (Windows) / nano / vi. */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const configured = (env.ADF_EDITOR ?? '').trim() || (env.VISUAL ?? '').trim() || (env.EDITOR ?? '').trim()
  if (configured) return splitCommand(configured)
  if (platform === 'win32') return ['notepad']
  return [onPath('nano', env) ? 'nano' : 'vi']
}

/** The editor command as the user would type it (for messages). */
export function editorLabel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveEditor(env).join(' ')
}

function quoteWin(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/** Run the editor attached to the terminal; resolves with its exit code. */
export function runEditorProcess(command: string[], file: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const [bin, ...args] = command
  const win = process.platform === 'win32'
  return new Promise((resolve, reject) => {
    // Windows needs the shell for .cmd shims (code.cmd, subl.cmd, …).
    const child = win
      ? spawn([bin, ...args, file].map(quoteWin).join(' '), [], { stdio: 'inherit', shell: true, env, windowsHide: false })
      : spawn(bin, [...args, file], { stdio: 'inherit', env })
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
}

export interface EditResult {
  /** The edited text; null when the editor could not start or exited non-zero. */
  text: string | null
  changed: boolean
  editor: string
  error?: string
}

export interface EditTextOptions {
  filename?: string
  env?: NodeJS.ProcessEnv
  /** Normalize CRLF to LF and drop trailing newlines (single-field edits). */
  trim?: boolean
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** Write `text` to a temp file, run the editor on it, read it back. The temp dir is always removed. */
export async function editText(text: string, options: EditTextOptions = {}): Promise<EditResult> {
  const env = options.env ?? process.env
  const command = resolveEditor(env)
  const editor = command.join(' ')
  const dir = await fs.mkdtemp(join(tmpdir(), 'adf-tui-'))
  const file = join(dir, options.filename ?? 'edit.txt')
  try {
    await fs.writeFile(file, text, 'utf-8')
    const code = await runEditorProcess(command, file, env)
    if (code !== 0 && code !== null) return { text: null, changed: false, editor, error: `${editor} exited with code ${code}` }
    let edited = await fs.readFile(file, 'utf-8')
    if (text.charCodeAt(0) !== 0xfeff) edited = stripBom(edited)
    if (options.trim) edited = edited.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    return { text: edited, changed: edited !== text, editor }
  } catch (err) {
    return { text: null, changed: false, editor, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
