/**
 * Runs real coreutils (uutils, compiled to wasm32-wasip1) as shell applets.
 *
 * Execution model: one WebAssembly instance per invocation (the compiled
 * module is cached), stdin/stdout/stderr and any file arguments live in an
 * in-memory WASI filesystem via @bjorn3/browser_wasi_shim — the applet never
 * touches the host filesystem, preserving the single-file agent sandbox.
 * File contents are pre-read from the SQLite VFS by the command handlers
 * (through the audited fs_read path) and mounted read-only here.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import {
  WASI,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
  WASIProcExit,
} from '@bjorn3/browser_wasi_shim'

export interface AppletResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Locate resources/wasm/coreutils.wasm across all runtimes: bundled Electron
 * main (out/main inside asar — Electron patches readFileSync for asar paths),
 * tsx daemon/CLI (src/main/...), and vitest. Walks up from this module's
 * directory; falls back to cwd for module systems without __dirname.
 */
function locateWasm(): string {
  const starts: string[] = []
  if (typeof __dirname !== 'undefined') starts.push(__dirname)
  starts.push(process.cwd())
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'resources', 'wasm', 'coreutils.wasm')
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error('coreutils.wasm not found (expected under resources/wasm/)')
}

let modulePromise: Promise<WebAssembly.Module> | null = null

function getModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = WebAssembly.compile(readFileSync(locateWasm()))
  }
  return modulePromise
}

/** Build a nested in-memory directory tree from path → content entries.
 *  Content may be a string (text file) or raw bytes (binary file). */
function buildTree(files: Record<string, string | Uint8Array>): Map<string, File | Directory> {
  const encoder = new TextEncoder()
  const root = new Map<string, File | Directory>()
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    const bytes = typeof content === 'string' ? encoder.encode(content) : content
    let dir = root
    for (let i = 0; i < segments.length - 1; i++) {
      let next = dir.get(segments[i])
      if (!(next instanceof Directory)) {
        next = new Directory(new Map())
        dir.set(segments[i], next)
      }
      dir = (next as Directory).contents as Map<string, File | Directory>
    }
    // A leaf name that collided with an intermediate directory would corrupt
    // the tree; skip rather than overwrite a Directory with a File.
    const leaf = segments[segments.length - 1]
    if (dir.get(leaf) instanceof Directory) continue
    dir.set(leaf, new File(bytes))
  }
  return root
}

/**
 * Run a coreutils applet. `argv` is everything after the applet name,
 * exactly as typed (flags + positionals). `files` mounts VFS contents into
 * the applet's working directory so file arguments resolve.
 */
export async function runApplet(
  applet: string,
  argv: string[],
  stdin: string,
  files: Record<string, string | Uint8Array> = {}
): Promise<AppletResult> {
  const module = await getModule()

  let stdout = ''
  let stderr = ''
  // Raw byte capture — lineBuffered would drop a final unterminated line
  const outDecoder = new TextDecoder()
  const errDecoder = new TextDecoder()
  const fds = [
    new OpenFile(new File(new TextEncoder().encode(stdin))),
    new ConsoleStdout((buf) => { stdout += outDecoder.decode(buf, { stream: true }) }),
    new ConsoleStdout((buf) => { stderr += errDecoder.decode(buf, { stream: true }) }),
    new PreopenDirectory('.', buildTree(files)),
  ]

  const wasi = new WASI(['coreutils', applet, ...argv], [], fds, { debug: false })
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  })

  let exitCode = 0
  try {
    exitCode = wasi.start(instance as Parameters<WASI['start']>[0])
  } catch (e) {
    if (e instanceof WASIProcExit) {
      exitCode = e.code
    } else {
      throw e
    }
  }

  return { stdout, stderr, exitCode }
}
