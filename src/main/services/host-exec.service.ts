/**
 * Host-side execution helpers for compute_exec and fs_transfer.
 *
 * Detects the best shell available on the host at first use and caches it.
 * Returns { stdout, stderr, code } matching PodmanService.execInContainer so
 * tools can branch on target without changing their result handling.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
import { getUserDataPath } from '../utils/user-data-path'
import { trackChild, killTree } from '../utils/child-registry'

const MAX_OUTPUT_BYTES = 512 * 1024 // 512 KB per stream — same as compute_exec
const TIMEOUT_EXIT_CODE = 124       // GNU timeout convention
const SPAWN_FAIL_EXIT_CODE = -1     // shell binary not found / permission denied
const SIGKILL_GRACE_MS = 2000       // POSIX: SIGTERM → SIGKILL escalation window
const PIPE_DRAIN_GRACE_MS = 1000    // settle this long after 'exit' if 'close' hasn't fired

export type ShellFamily = 'posix' | 'powershell' | 'cmd'
export type HostOs = 'windows' | 'macos' | 'linux'

export interface HostShellInfo {
  /** Absolute path to the shell binary. */
  path: string
  /** Arg prefix before the command string, e.g. ['-c'] or ['/d','/s','/c']. */
  args: readonly string[]
  /** Human-readable label for the agent (e.g. "bash (Git Bash)"). */
  label: string
  /** Syntax family the shell expects. */
  family: ShellFamily
}

export interface HostEnvInfo {
  os: HostOs
  osLabel: string
  release: string
  shell: HostShellInfo
}

let cachedShell: HostShellInfo | null = null
let cachedEnv: HostEnvInfo | null = null

export function resolveHostShell(): HostShellInfo {
  if (!cachedShell) cachedShell = detectShell()
  return cachedShell
}

export function resolveHostEnv(): HostEnvInfo {
  if (cachedEnv) return cachedEnv
  const plat = process.platform
  const os: HostOs = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'macos' : 'linux'
  const osLabel = os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : 'Linux'
  cachedEnv = { os, osLabel, release: release(), shell: resolveHostShell() }
  return cachedEnv
}

function detectShell(): HostShellInfo {
  if (process.platform === 'win32') {
    const gitBash = [
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : null,
      process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)']!, 'Git', 'bin', 'bash.exe') : null,
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].filter((p): p is string => !!p)
    for (const p of gitBash) {
      if (existsSync(p)) return { path: p, args: ['-c'], label: 'bash (Git Bash)', family: 'posix' }
    }
    const bashOnPath = whichWindows('bash.exe')
    if (bashOnPath) return { path: bashOnPath, args: ['-c'], label: 'bash', family: 'posix' }
    const pwsh = whichWindows('pwsh.exe')
    if (pwsh) return { path: pwsh, args: ['-NoProfile', '-Command'], label: 'pwsh (PowerShell Core)', family: 'powershell' }
    const powershell = whichWindows('powershell.exe')
    if (powershell) return { path: powershell, args: ['-NoProfile', '-Command'], label: 'powershell (Windows PowerShell)', family: 'powershell' }
    const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    return { path: cmd, args: ['/d', '/s', '/c'], label: 'cmd.exe', family: 'cmd' }
  }

  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
    if (existsSync(candidate)) return { path: candidate, args: ['-c'], label: 'bash', family: 'posix' }
  }
  return { path: '/bin/sh', args: ['-c'], label: 'sh', family: 'posix' }
}

function whichWindows(binary: string): string | null {
  try {
    const out = execFileSync('where', [binary], { encoding: 'utf-8', timeout: 3000, windowsHide: true }).toString()
    const first = out.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
    if (first && existsSync(first)) return first
  } catch { /* not on PATH */ }
  return null
}

/** Live host-exec children so shutdown can tree-kill stragglers. */
const liveHostExecs = new Set<ChildProcess>()

/**
 * Tree-kill a host-exec child. Windows: taskkill /T /F takes the whole
 * tree. POSIX: signal the process group (-pid, works because we spawn
 * detached), SIGTERM first, SIGKILL after a grace window.
 */
function terminateHostExec(child: ChildProcess): void {
  const pid = child.pid
  if (pid == null) return
  if (process.platform === 'win32') {
    killTree(child)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }, SIGKILL_GRACE_MS)
  escalate.unref?.()
  child.once('exit', () => clearTimeout(escalate))
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

/**
 * Execute a shell command on the host machine using the detected shell.
 *
 * Commands are LLM-authored and routinely launch long-lived grandchildren
 * (dev servers, watchers), so a plain execFile timeout — which kills only
 * the shell — is not enough. The child is spawned so the entire process
 * tree can be reaped: on timeout the tree is killed (taskkill /T on
 * Windows, process-group signal on POSIX), and every child is registered
 * with the child registry plus the local set so app shutdown reaps
 * stragglers via killAllHostExecs().
 */
export function hostExec(
  cwd: string,
  command: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const shell = resolveHostShell()
  return new Promise((resolve) => {
    const child = spawn(shell.path, [...shell.args, command], {
      cwd,
      windowsHide: true,
      // POSIX: lead a new process group so we can signal -pid on timeout/shutdown
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    trackChild(child)
    liveHostExecs.add(child)

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return
      stdoutBytes += Buffer.byteLength(chunk)
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return
      stderrBytes += Buffer.byteLength(chunk)
      stderr += chunk
    })

    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      terminateHostExec(child)
    }, timeout)

    const settle = (code: number, extraStderr = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      liveHostExecs.delete(child)
      resolve({
        stdout: stdout.trim(),
        stderr: (stderr + extraStderr).trim(),
        code,
      })
    }

    child.once('error', (error: NodeJS.ErrnoException) => {
      // Spawn failure (ENOENT/EACCES/…) — 'close' may never fire, settle here
      settle(
        SPAWN_FAIL_EXIT_CODE,
        `\ncompute_exec: failed to spawn host shell (${error.code ?? 'unknown'}): ${error.message}`,
      )
    })

    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (timedOut) {
        settle(
          TIMEOUT_EXIT_CODE,
          `\ncompute_exec: command timed out after ${formatDuration(timeout)} and its process tree was terminated`,
        )
      } else if (code !== null) {
        settle(code)
      } else {
        settle(1, signal ? `\ncompute_exec: command terminated by signal ${signal}` : '')
      }
    }

    child.once('close', (code, signal) => finalize(code, signal))
    child.once('exit', (code, signal) => {
      // 'close' additionally waits for stdio to drain, and a background
      // grandchild holding the inherited pipes can delay that indefinitely.
      // Settle shortly after process exit if 'close' has not fired.
      const grace = setTimeout(() => finalize(code, signal), PIPE_DRAIN_GRACE_MS)
      grace.unref?.()
    })
  })
}

/**
 * Tree-kill every live host-exec child, waiting up to budgetMs for exits.
 * Never throws; intended for app shutdown paths.
 */
export async function killAllHostExecs(budgetMs = 3000): Promise<void> {
  const children = [...liveHostExecs]
  if (children.length === 0) return
  const exits = children.map(
    (c) =>
      new Promise<void>((resolveExit) => {
        if (c.pid == null || c.exitCode !== null || c.signalCode !== null) return resolveExit()
        c.once('close', () => resolveExit())
      }),
  )
  for (const c of children) terminateHostExec(c)
  await Promise.race([
    Promise.allSettled(exits),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, budgetMs).unref?.()),
  ])
}

export function ensureHostWorkspace(agentId: string): string {
  const dir = join(getUserDataPath(), 'workspaces', agentId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Test-only: reset cached shell/env detection. */
export function __resetHostExecCacheForTests(): void {
  cachedShell = null
  cachedEnv = null
}
