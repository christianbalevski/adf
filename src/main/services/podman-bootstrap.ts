/**
 * Podman availability detection (detect-and-guide, not bundled).
 *
 * Checks whether `podman` is available on the system and, on macOS/Windows,
 * whether a Podman machine is running.  Returns actionable guidance when
 * Podman is missing or not started.
 */

import { execFile } from 'child_process'
import { platform } from 'os'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'

export interface InstallMethod {
  /** Shell command to run (e.g. 'brew install podman'). Empty for a `url` method. */
  command: string
  /** Human-readable label for UI buttons */
  label: string
  /** Whether this can be run automatically (no sudo, no GUI installer) */
  autoRunnable: boolean
  /** A page to open instead of a command to run (e.g. a GUI installer download). */
  url?: string
}

export interface Prerequisite {
  /** Stable identifier. */
  id: 'wsl'
  /** Display name. */
  name: string
  /** Whether the prerequisite is satisfied. */
  installed: boolean
  /** Command the user should run to install (usually requires admin). */
  installCommand?: string
  /** True if installing requires a reboot before it's usable. */
  requiresReboot?: boolean
  /** Short human-readable description of what this prereq is for. */
  description?: string
  /** Optional docs URL for the user. */
  docsUrl?: string
}

export interface PodmanAvailability {
  /** Podman binary found and executable. */
  available: boolean
  /** Resolved absolute path to the `podman` binary (if found). */
  binPath?: string
  /** Podman version string (e.g. "5.3.1"). */
  version?: string
  /** Whether a VM-backed machine is required (macOS, Windows). */
  machineRequired: boolean
  /** Whether the machine is currently running (only relevant when machineRequired). */
  machineRunning?: boolean
  /** Whether a machine exists but is stopped (vs not initialized at all). */
  machineExists?: boolean
  /** Human-readable error or guidance message. */
  error?: string
  /** Current platform identifier. */
  platform: string
  /** Available install methods for this platform. */
  installMethods: InstallMethod[]
  /** Platform prerequisites that must be satisfied before machine setup (e.g. WSL on Windows). */
  prerequisites: Prerequisite[]
}

/** Well-known locations where podman might live. */
const EXTRA_SEARCH_PATHS: Record<string, string[]> = {
  // Homebrew (Apple Silicon, Intel), then the podman.io .pkg installer.
  darwin: ['/opt/homebrew/bin/podman', '/usr/local/bin/podman', '/opt/podman/bin/podman'],
  win32: [
    'C:\\Program Files\\RedHat\\Podman\\podman.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Podman\\podman.exe`,
  ].filter((p) => !p.startsWith('\\')),
  linux: ['/usr/bin/podman', '/usr/local/bin/podman'],
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ stdout: stdout?.trim() ?? '', stderr: stderr?.trim() ?? '', code: error ? (error as NodeJS.ErrnoException).code === 'ENOENT' ? -1 : 1 : 0 })
    })
  })
}

/**
 * On Windows, detect whether WSL is installed and usable.
 * Podman machine on Windows is backed by WSL by default — if WSL isn't
 * installed, `podman machine init` fails with a cryptic "wsl.exe ... failed"
 * error. Detecting WSL up front lets the setup wizard give clear guidance.
 *
 * Returns true if WSL is present, false otherwise. Returns true on non-Windows
 * platforms (WSL only applies to Windows).
 */
async function checkWslInstalled(): Promise<boolean> {
  if (platform() !== 'win32') return true
  // `wsl --status` prints install/version info when WSL is present, and
  // "The Windows Subsystem for Linux is not installed." otherwise.
  // It returns exit 0 when installed, non-zero when missing.
  const result = await exec('wsl.exe', ['--status'])
  if (result.code !== 0) return false
  // Some Windows installs have a wsl.exe stub that exits 0 but prints the
  // "not installed" message. Double-check the output (wsl.exe prints UTF-16,
  // which Node decodes as UTF-8 and inserts nulls between chars).
  const normalized = (result.stdout + result.stderr).replace(/\u0000/g, '')
  if (/is not installed/i.test(normalized)) return false
  return true
}

async function findPodmanBin(): Promise<string | null> {
  // Try PATH first
  const which = await exec(platform() === 'win32' ? 'where' : 'which', ['podman'])
  if (which.code === 0 && which.stdout) {
    return which.stdout.split('\n')[0]
  }

  // Check well-known locations
  for (const candidate of EXTRA_SEARCH_PATHS[platform()] ?? []) {
    const check = await exec(candidate, ['--version'])
    if (check.code === 0) return candidate
  }

  return null
}

/** Podman's macOS installation docs, which link the official .pkg installer. */
export const PODMAN_MACOS_INSTALL_DOCS_URL = 'https://podman.io/docs/installation#macos'

const HOMEBREW_LOCATIONS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']

/**
 * Absolute path to Homebrew: the standard prefixes first, then PATH (custom
 * prefixes such as ~/homebrew). Resolved to an absolute path because the
 * install step runs it with execFile, which only sees the app's PATH — a
 * Finder-launched app may not have Homebrew on it.
 */
export function findHomebrew(
  exists: (path: string) => boolean = existsSync,
  pathEnv: string = process.env.PATH ?? '',
): string | null {
  const standard = HOMEBREW_LOCATIONS.find((p) => exists(p))
  if (standard) return standard
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && exists(join(dir, 'brew'))) return join(dir, 'brew')
  }
  return null
}

export function getInstallMethods(
  plat: NodeJS.Platform = platform(),
  exists: (path: string) => boolean = existsSync,
  pathEnv: string = process.env.PATH ?? '',
): InstallMethod[] {
  if (plat === 'darwin') {
    const brew = findHomebrew(exists, pathEnv)
    if (brew) {
      return [{ command: `${brew} install podman`, label: 'Install via Homebrew', autoRunnable: true }]
    }
    // No Homebrew: point at the official installer instead of offering a
    // command that can only fail.
    return [{ command: '', url: PODMAN_MACOS_INSTALL_DOCS_URL, label: 'Download the Podman installer', autoRunnable: false }]
  }

  if (plat === 'win32') {
    return [
      { command: 'winget install -e --id RedHat.Podman', label: 'Install via winget', autoRunnable: true },
    ]
  }

  // Linux — detect available package managers
  const methods: InstallMethod[] = []
  if (exists('/usr/bin/apt-get') || exists('/usr/bin/apt')) {
    methods.push({ command: 'sudo apt-get install -y podman', label: 'Install via apt', autoRunnable: false })
  }
  if (exists('/usr/bin/dnf')) {
    methods.push({ command: 'sudo dnf install -y podman', label: 'Install via dnf', autoRunnable: false })
  }
  if (exists('/usr/bin/pacman')) {
    methods.push({ command: 'sudo pacman -S --noconfirm podman', label: 'Install via pacman', autoRunnable: false })
  }
  if (methods.length === 0) {
    methods.push({ command: 'sudo apt-get install -y podman', label: 'Install via package manager', autoRunnable: false })
  }
  return methods
}

async function getPrerequisites(): Promise<Prerequisite[]> {
  const plat = platform()
  if (plat !== 'win32') return []

  const wslInstalled = await checkWslInstalled()
  return [
    {
      id: 'wsl',
      name: 'Windows Subsystem for Linux',
      installed: wslInstalled,
      installCommand: 'wsl --install',
      requiresReboot: true,
      description: 'Required to run the Podman VM on Windows. Installation needs admin rights and a system reboot.',
      docsUrl: 'https://learn.microsoft.com/windows/wsl/install',
    },
  ]
}

function installNotFoundMessage(method: InstallMethod | undefined): string {
  if (method?.url) return `Podman not found. ${method.label}: ${method.url}`
  if (method?.command) return `Podman not found. Run: ${method.command}`
  return 'Podman not found on this system.'
}

export async function checkPodmanAvailability(): Promise<PodmanAvailability> {
  const plat = platform()
  const machineRequired = plat === 'darwin' || plat === 'win32'
  const installMethods = getInstallMethods()
  const prerequisites = await getPrerequisites()

  const binPath = await findPodmanBin()
  if (!binPath) {
    return {
      available: false,
      machineRequired,
      platform: plat,
      installMethods,
      prerequisites,
      error: installNotFoundMessage(installMethods[0]),
    }
  }

  // Get version
  const ver = await exec(binPath, ['--version'])
  const version = ver.stdout.replace(/^podman version\s*/i, '')

  // Check machine status on macOS/Windows
  let machineRunning: boolean | undefined
  let machineExists: boolean | undefined
  if (machineRequired) {
    const ml = await exec(binPath, ['machine', 'list', '--format', '{{.Name}}\t{{.Running}}', '--noheading'])
    if (ml.code === 0 && ml.stdout.trim()) {
      machineExists = true
      machineRunning = ml.stdout.toLowerCase().includes('true')
    } else {
      machineExists = false
      machineRunning = false
    }
  }

  return {
    available: true,
    binPath,
    version,
    machineRequired,
    machineRunning,
    machineExists,
    platform: plat,
    installMethods,
    prerequisites,
  }
}
