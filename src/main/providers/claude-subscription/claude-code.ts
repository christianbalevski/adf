import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { compareVersions } from '../../utils/version-compare'

/**
 * Locates the user's installed Claude Code executable.
 *
 * The Claude subscription provider never handles Claude credentials itself:
 * sign-in, token storage and refresh all happen inside the unmodified Claude
 * Code binary (Anthropic's own flow), and model calls run through the Claude
 * Agent SDK, which drives that binary. ADF does not bundle Claude Code; it uses
 * the copy the user installed.
 */

/** Oldest Claude Code the provider supports (Agent SDK `verbatimPrompts`). */
export const MIN_CLAUDE_CODE_VERSION = '2.1.248'

export const CLAUDE_CODE_INSTALL_URL = 'https://code.claude.com/docs/en/setup'

export interface ClaudeCodeInstall {
  path: string
  version: string
}

export type ClaudeCodeProbe =
  | { found: true; install: ClaudeCodeInstall; supported: boolean }
  | { found: false }

const isWindows = process.platform === 'win32'
const exeName = isWindows ? 'claude.exe' : 'claude'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Existing candidate executable paths. GUI apps on macOS do not inherit the
 * login shell's PATH, so the well-known install locations are checked
 * explicitly in addition to PATH.
 */
async function candidatePaths(): Promise<string[]> {
  const out: string[] = []
  const override = process.env.ADF_CLAUDE_CODE_PATH
  if (override) out.push(override)

  const home = homedir()
  // Native installer.
  out.push(join(home, '.local', 'bin', exeName))
  out.push(join(home, '.claude', 'local', exeName))
  if (!isWindows) {
    out.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude')
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    if (isWindows) {
      // npm's Windows shims (claude.cmd / extensionless sh script) cannot be
      // spawned directly; resolve them to the package's real executable.
      out.push(join(dir, 'claude.exe'))
      const target = await resolveNpmShim(join(dir, 'claude.cmd'))
      if (target) out.push(target)
    } else {
      out.push(join(dir, 'claude'))
    }
  }

  const appData = process.env.APPDATA
  if (isWindows && appData) {
    out.push(join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  }
  const unique = [...new Set(out)]
  const present = await Promise.all(unique.map(exists))
  return unique.filter((_, i) => present[i])
}

/** npm writes `"%dp0%\node_modules\...\claude.exe"` into its .cmd shims. */
async function resolveNpmShim(shimPath: string): Promise<string | null> {
  try {
    const text = await readFile(shimPath, 'utf8')
    const match = text.match(/"%dp0%\\([^"]+?\.exe)"/i)
    if (!match) return null
    const target = join(dirname(shimPath), match[1])
    return (await exists(target)) ? target : null
  } catch {
    return null
  }
}

function runVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const match = String(stdout).match(/(\d+\.\d+\.\d+)/)
      resolve(match ? match[1] : null)
    })
  })
}

let cached: { probe: ClaudeCodeProbe; at: number } | null = null
let inflight: Promise<ClaudeCodeProbe> | null = null
const CACHE_MS = 60_000

async function runProbe(): Promise<ClaudeCodeProbe> {
  const paths = await candidatePaths()
  const versions = await Promise.all(paths.map(runVersion))
  let install: ClaudeCodeInstall | null = null
  for (let i = 0; i < paths.length; i++) {
    const version = versions[i]
    if (version && (!install || compareVersions(version, install.version) > 0)) install = { path: paths[i], version }
  }
  return install
    ? { found: true, install, supported: compareVersions(install.version, MIN_CLAUDE_CODE_VERSION) >= 0 }
    : { found: false }
}

/**
 * Find Claude Code and read its version. Every install found is probed and the
 * newest wins, so an old copy earlier on the search path cannot hide a newer
 * one. Cached for a minute and shared by concurrent callers so status polls
 * stay cheap; `force` re-probes (e.g. right after the user installs it).
 */
export function probeClaudeCode(force = false): Promise<ClaudeCodeProbe> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.probe)
  if (!force && inflight) return inflight
  const run = runProbe().then((probe) => {
    cached = { probe, at: Date.now() }
    return probe
  }).finally(() => {
    if (inflight === run) inflight = null
  })
  inflight = run
  return run
}

/** Test hook: forget the cached probe. */
export function resetClaudeCodeProbe(): void {
  cached = null
  inflight = null
}

/** The executable to run, or a user-facing error explaining what to do. */
export async function requireClaudeCode(): Promise<ClaudeCodeInstall> {
  const probe = await probeClaudeCode()
  if (!probe.found) {
    throw new Error(`Claude Code is not installed. Install it (${CLAUDE_CODE_INSTALL_URL}), then sign in with Claude.`)
  }
  if (!probe.supported) {
    throw new Error(
      `Claude Code ${probe.install.version} is installed; ADF needs ${MIN_CLAUDE_CODE_VERSION} or newer. Run \`claude update\`.`
    )
  }
  return probe.install
}

const CLAUDE_ENV_DENY = /^(CLAUDE_CODE_|ANTHROPIC_|CLAUDECODE$)/i

/**
 * Environment for every Claude Code child process. Strips Anthropic API
 * credentials so usage is always billed to the signed-in Claude plan, never
 * silently to an API key that happens to be in the environment, and every
 * other inherited Claude Code / Anthropic setting. CLAUDE_CONFIG_DIR and
 * proxy/CA variables pass through.
 */
export function claudeCodeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // Inherited Claude Code / Anthropic settings (extra body, custom headers,
    // model overrides, a parent Claude Code session) would silently change
    // what is sent; ELECTRON_RUN_AS_NODE must not reach the native binary.
    if (v === undefined || CLAUDE_ENV_DENY.test(k) || k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    env[k] = v
  }
  return { ...env, ...extra }
}
