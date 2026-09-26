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
 * with the standard package-manager directories appended — never a broken
 * PATH. Output is still parsed when the shell exits non-zero or times out
 * after env has printed (a hanging logout hook, a shell that propagates rc
 * errors).
 *
 * Kept free of electron imports so it can be unit tested under plain Node.
 */
import { execFileSync } from 'child_process'
import { homedir } from 'os'

export const PATH_START_MARKER = '__ADF_LOGIN_ENV_START__'
export const PATH_END_MARKER = '__ADF_LOGIN_ENV_END__'

/** Directories package managers install into, in precedence order. */
function fallbackDirs(platform: NodeJS.Platform, home: string): string[] {
  const user = home ? [`${home}/.local/bin`] : []
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', ...user]
  if (platform === 'linux') return ['/usr/local/bin', '/usr/local/sbin', '/home/linuxbrew/.linuxbrew/bin', ...user]
  return []
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
  /** Injectable for tests; defaults to os.homedir(). */
  home?: string
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
  // Last start marker: under `set -x` the echoed command line carries the
  // marker text too, ahead of the real output.
  const start = output.lastIndexOf(PATH_START_MARKER)
  if (start === -1) return null
  const end = output.indexOf(PATH_END_MARKER, start + PATH_START_MARKER.length)
  if (end === -1) return null

  // Last plausible PATH= line: a multi-line value of another variable can
  // contain a line that happens to start with PATH=.
  const candidates = output
    .slice(start + PATH_START_MARKER.length, end)
    .split(/\r?\n/)
    .filter((l) => l.startsWith('PATH='))
    .map((l) => l.slice('PATH='.length).trim())
    .filter(isPlausiblePath)
  return candidates.length > 0 ? candidates[candidates.length - 1] : null
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

/**
 * Inherited PATH with the platform's package-manager directories appended.
 * Appended, not prepended, so they add tools without shadowing the system
 * binaries the inherited PATH already resolves.
 */
export function fallbackPath(currentPath: string, platform: NodeJS.Platform, home: string = homedir()): string {
  const current = currentPath.split(':').filter(Boolean)
  const extra = fallbackDirs(platform, home).filter((dir) => !current.includes(dir))
  return [...current, ...extra].join(':')
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
  const fallback = (reason: string): LoginShellPathResult => ({
    source: 'fallback',
    path: fallbackPath(opts.currentPath, opts.platform, opts.home),
    reason,
  })
  let output: string
  try {
    // Separate flags rather than -ilc: bash, zsh, fish and nushell all accept
    // `-i -l -c`, but not all of them parse the combined form.
    output = exec(opts.shell, ['-i', '-l', '-c', loginShellScript()], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (err) {
    // execFileSync throws on a non-zero exit and on timeout, but whatever the
    // shell printed is still on the error.
    const stdout = (err as { stdout?: unknown }).stdout
    const salvaged = typeof stdout === 'string' ? parseLoginShellPath(stdout) : null
    if (salvaged) return { source: 'login-shell', path: salvaged }
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return fallback(`shell failed: ${reason}`)
  }

  const parsed = parseLoginShellPath(output)
  return parsed ? { source: 'login-shell', path: parsed } : fallback(`no usable PATH in ${opts.shell} output`)
}
