/**
 * Host-side execution helpers for compute_exec and fs_transfer.
 *
 * Detects the best shell available on the host at first use and caches it.
 * Returns { stdout, stderr, code } matching PodmanService.execInContainer so
 * tools can branch on target without changing their result handling.
 */

import { execFile, execFileSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
import { getUserDataPath } from '../utils/user-data-path'

const MAX_OUTPUT_BYTES = 512 * 1024 // 512 KB per stream — same as compute_exec
const TIMEOUT_EXIT_CODE = 124       // GNU timeout convention
const SPAWN_FAIL_EXIT_CODE = -1     // shell binary not found / permission denied

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

/**
 * Execute a shell command on the host machine using the detected shell.
 */
export function hostExec(
  cwd: string,
  command: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const shell = resolveHostShell()
  return new Promise((resolve) => {
    execFile(
      shell.path,
      [...shell.args, command],
      { cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        let stderrOut = (stderr ?? '').toString()
        let code = 0
        if (error) {
          const errnoCode = (error as NodeJS.ErrnoException).code
          if ((error as { killed?: boolean }).killed) {
            code = TIMEOUT_EXIT_CODE
            stderrOut += `\ncompute_exec: command timed out after ${timeout}ms`
          } else if (typeof errnoCode === 'string') {
            code = SPAWN_FAIL_EXIT_CODE
            stderrOut += `\ncompute_exec: failed to spawn host shell (${errnoCode}): ${error.message}`
          } else if (typeof errnoCode === 'number') {
            code = errnoCode
          } else {
            code = 1
          }
        }
        resolve({
          stdout: (stdout ?? '').toString().trim(),
          stderr: stderrOut.trim(),
          code,
        })
      },
    )
  })
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
