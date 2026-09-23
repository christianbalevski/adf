/**
 * Login-shell PATH resolution for packaged macOS/Linux builds.
 *
 * An app launched from Finder or a desktop entry inherits a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) with no Homebrew, nvm, or ~/.local/bin, so
 * npx/uvx MCP servers, npm installs, brew and podman can't be found. The fix is
 * to ask the user's login shell for its PATH — but the naive
 * `$SHELL -ilc 'echo -n $PATH'` breaks in common setups:
 *
 *   - fish prints `$PATH` as a space-separated list, nushell has no `echo -n`,
 *     so the result is not a PATH at all;
 *   - anything the rc files print to stdout (motd, conda/nvm banners) ends up
 *     glued onto the value.
 *
 * Instead we run the external `/usr/bin/env` between two marker lines and read
 * the exported `PATH=` line, which is colon-separated whatever the shell. The
 * result is validated, and anything unusable falls back to the inherited PATH
 * plus the standard package-manager directories — never a broken PATH.
 *
 * Kept free of electron imports so it can be unit tested under plain Node.
 */
import { execFileSync } from 'child_process'

export const PATH_START_MARKER = '__ADF_LOGIN_ENV_START__'
export const PATH_END_MARKER = '__ADF_LOGIN_ENV_END__'

/** Directories package managers install into, in precedence order. */
const FALLBACK_DIRS: Record<string, string[]> = {
  darwin: ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'],
  linux: ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'],
}

const DEFAULT_TIMEOUT_MS = 5000

export type LoginShellExec = (shell: string, args: string[], timeoutMs: number) => string

export interface ResolveLoginShellPathOptions {
  shell: string
  currentPath: string
  platform: NodeJS.Platform
  timeoutMs?: number
  /** Injectable for tests; defaults to a synchronous execFile of the shell. */
  exec?: LoginShellExec
}

export type LoginShellPathResult =
  | { source: 'login-shell'; path: string }
  | { source: 'fallback'; path: string; reason: string }

/** The shell script: markers around the external env binary's output. */
export function loginShellScript(): string {
  return `echo ${PATH_START_MARKER}; /usr/bin/env; echo ${PATH_END_MARKER}`
}

/**
 * Extract PATH from the marked `env` output. Returns null when the markers or
 * the PATH line are missing, or the value doesn't look like a PATH.
 */
export function parseLoginShellPath(output: string): string | null {
  const start = output.indexOf(PATH_START_MARKER)
  if (start === -1) return null
  const end = output.indexOf(PATH_END_MARKER, start + PATH_START_MARKER.length)
  if (end === -1) return null

  const block = output.slice(start + PATH_START_MARKER.length, end)
  const line = block.split(/\r?\n/).find((l) => l.startsWith('PATH='))
  if (!line) return null

  const value = line.slice('PATH='.length).trim()
  return isPlausiblePath(value) ? value : null
}

/** Colon-separated, no whitespace-joined list, and at least one absolute entry. */
export function isPlausiblePath(value: string): boolean {
  if (!value) return false
  const entries = value.split(':').filter(Boolean)
  if (entries.length === 0) return false
  // A space-joined list (fish's `echo $PATH`) shows up as one entry holding
  // several absolute paths separated by spaces.
  if (entries.some((e) => / \//.test(e))) return false
  return entries.some((e) => e.startsWith('/'))
}

/** Inherited PATH with the platform's package-manager directories prepended. */
export function fallbackPath(currentPath: string, platform: NodeJS.Platform): string {
  const current = currentPath.split(':').filter(Boolean)
  const extra = (FALLBACK_DIRS[platform] ?? []).filter((dir) => !current.includes(dir))
  return [...extra, ...current].join(':')
}

const defaultExec: LoginShellExec = (shell, args, timeoutMs) =>
  execFileSync(shell, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    // No stdin: an rc file that prompts (oh-my-zsh update, etc.) gets EOF
    // instead of blocking until the timeout.
    stdio: ['ignore', 'pipe', 'ignore'],
  })

export function resolveLoginShellPath(opts: ResolveLoginShellPathOptions): LoginShellPathResult {
  const exec = opts.exec ?? defaultExec
  let output: string
  try {
    // Separate flags rather than -ilc: bash, zsh, fish and nushell all accept
    // `-i -l -c`, but not all of them parse the combined form.
    output = exec(opts.shell, ['-i', '-l', '-c', loginShellScript()], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return { source: 'fallback', path: fallbackPath(opts.currentPath, opts.platform), reason: `shell failed: ${reason}` }
  }

  const parsed = parseLoginShellPath(output)
  if (!parsed) {
    return {
      source: 'fallback',
      path: fallbackPath(opts.currentPath, opts.platform),
      reason: `no usable PATH in ${opts.shell} output`,
    }
  }
  return { source: 'login-shell', path: parsed }
}
