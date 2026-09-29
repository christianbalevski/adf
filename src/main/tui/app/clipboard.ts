// The system clipboard: copy (chat `c`, /copy, mouse selection, site URLs)
// and paste (right-click in mouse mode). Native tools first (pbcopy / clip /
// wl-copy / xclip / xsel), OSC 52 through the terminal as the fallback and
// over SSH, where the native clipboard is the remote machine's. Tests swap
// both ends with setClipboardWriter / setClipboardReader.

import { spawn } from 'node:child_process'
import { writeTerminal } from './terminal'

export type ClipboardWriter = (text: string) => Promise<boolean>
export type ClipboardReader = () => Promise<string | null>

function pipeTo(command: string, args: string[], data: Buffer): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', code => resolve(code === 0))
      child.stdin.end(data)
    } catch {
      resolve(false)
    }
  })
}

function readFrom(command: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => { child.kill(); resolve(null) }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.on('error', () => { clearTimeout(timer); resolve(null) })
      child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null) })
    } catch {
      resolve(null)
    }
  })
}

/** Over SSH the native tools reach the remote machine's clipboard, not the user's. */
export function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT)
}

/** OSC 52: the terminal sets its own clipboard (iTerm2 with "Applications may access clipboard", Windows Terminal, kitty, WezTerm, tmux with set-clipboard). */
export function osc52(text: string): string {
  const seq = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`
  // tmux / screen swallow OSC unless wrapped in a passthrough.
  return process.env.TMUX ? `\u001bPtmux;${seq.replace(/\u001b/g, '\u001b\u001b')}\u001b\\` : seq
}

async function nativeCopy(text: string): Promise<boolean> {
  if (process.platform === 'win32') {
    // clip.exe reads UTF-16LE with a BOM losslessly.
    return pipeTo('clip', [], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
  }
  const data = Buffer.from(text, 'utf8')
  if (process.platform === 'darwin') return pipeTo('pbcopy', [], data)
  for (const [cmd, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]] as const) {
    if (await pipeTo(cmd, [...args], data)) return true
  }
  return false
}

const systemWriter: ClipboardWriter = async text => {
  // ADF_TUI_CLIPBOARD=osc52: only ever through the terminal (WSL, containers, nested sessions).
  if (process.env.ADF_TUI_CLIPBOARD === 'osc52') return writeTerminal(osc52(text))
  if (isRemoteSession()) return writeTerminal(osc52(text)) || nativeCopy(text)
  if (await nativeCopy(text)) return true
  return writeTerminal(osc52(text))
}

const systemReader: ClipboardReader = async () => {
  if (process.platform === 'win32') {
    const text = await readFrom('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'])
    // Get-Clipboard -Raw ends with the console's own newline.
    return text === null ? null : text.replace(/\r?\n$/, '')
  }
  if (process.platform === 'darwin') return readFrom('pbpaste', [])
  for (const [cmd, args] of [['wl-paste', ['-n']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]] as const) {
    const text = await readFrom(cmd, [...args])
    if (text !== null) return text
  }
  return null
}

let writer: ClipboardWriter = systemWriter
let reader: ClipboardReader = systemReader

/** Tests swap the clipboard for a recorder (null restores the system one). */
export function setClipboardWriter(next: ClipboardWriter | null): void {
  writer = next ?? systemWriter
}

export function setClipboardReader(next: ClipboardReader | null): void {
  reader = next ?? systemReader
}

export function copyToClipboard(text: string): Promise<boolean> {
  return writer(text)
}

/** The clipboard's text, or null when it cannot be read (no tool, not text). */
export function readClipboard(): Promise<string | null> {
  return reader()
}
