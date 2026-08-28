import { join } from 'path'
import { existsSync, mkdirSync, chmodSync, createWriteStream, renameSync, statSync, unlinkSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createGunzip } from 'zlib'
import { pipeline } from 'stream/promises'
import { get as httpsGet } from 'https'
import { IncomingMessage } from 'http'
import { homedir, tmpdir } from 'os'
import { getUserDataPath } from '../utils/user-data-path'

const execFileAsync = promisify(execFile)

const MIN_UV_VERSION = '0.4.0'

interface PlatformBinary {
  archive: string
  binaryName: string
  isZip: boolean
}

function getPlatformBinary(): PlatformBinary {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin' && arch === 'arm64') {
    return { archive: 'uv-aarch64-apple-darwin.tar.gz', binaryName: 'uv', isZip: false }
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { archive: 'uv-x86_64-apple-darwin.tar.gz', binaryName: 'uv', isZip: false }
  }
  if (platform === 'linux' && arch === 'x64') {
    return { archive: 'uv-x86_64-unknown-linux-gnu.tar.gz', binaryName: 'uv', isZip: false }
  }
  if (platform === 'win32' && arch === 'x64') {
    return { archive: 'uv-x86_64-pc-windows-msvc.zip', binaryName: 'uv.exe', isZip: true }
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}

function followRedirects(url: string, maxRedirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'))
    httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume() // drain
        followRedirects(res.headers.location, maxRedirects - 1).then(resolve, reject)
      } else if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve(res)
      } else {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`))
      }
    }).on('error', reject)
  })
}

export interface InstalledTool {
  name: string
  version?: string
}

export class UvManager {
  private binDir: string
  private uvPath: string | null = null
  private resolving: Promise<string> | null = null

  constructor() {
    this.binDir = join(getUserDataPath(), 'mcp-bin')
  }

  // ---------------------------------------------------------------------------
  // uv binary resolution
  // ---------------------------------------------------------------------------

  async ensureUv(): Promise<string> {
    if (this.uvPath) return this.uvPath

    // Serialize concurrent calls
    if (this.resolving) return this.resolving
    this.resolving = this._resolveUv()
    try {
      this.uvPath = await this.resolving
      return this.uvPath
    } finally {
      this.resolving = null
    }
  }

  private async _resolveUv(): Promise<string> {
    const { binaryName } = getPlatformBinary()

    // 1. Check managed install
    const managedPath = join(this.binDir, binaryName)
    if (existsSync(managedPath)) {
      const ver = await this._getVersion(managedPath)
      if (ver && compareVersions(ver, MIN_UV_VERSION) >= 0) {
        return managedPath
      }
      // Managed install too old — re-download below
    }

    // 2. Check PATH and common locations
    const candidates = [
      'uv',                                          // PATH lookup
      join(process.env.HOME ?? '', '.cargo/bin/uv'),
      join(process.env.HOME ?? '', '.local/bin/uv'),
      '/usr/local/bin/uv',
    ]
    if (process.platform === 'win32') {
      candidates[0] = 'uv.exe'
    }

    for (const candidate of candidates) {
      try {
        const ver = await this._getVersion(candidate)
        if (ver && compareVersions(ver, MIN_UV_VERSION) >= 0) {
          return candidate
        }
      } catch {
        // Not found or can't execute — skip
      }
    }

    // 3. Auto-download
    return this._downloadUv()
  }

  private async _getVersion(uvBin: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(uvBin, ['--version'], { timeout: 10_000 })
      // Output format: "uv 0.5.1" or "uv 0.5.1 (abcdef 2024-01-01)"
      const match = stdout.trim().match(/^uv\s+(\d+\.\d+\.\d+)/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }

  private async _downloadUv(): Promise<string> {
    const { archive, binaryName, isZip } = getPlatformBinary()
    const url = `https://github.com/astral-sh/uv/releases/latest/download/${archive}`

    if (!existsSync(this.binDir)) {
      mkdirSync(this.binDir, { recursive: true })
    }

    const targetPath = join(this.binDir, binaryName)
    const tempDir = join(tmpdir(), `adf-uv-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })

    try {
      const archivePath = join(tempDir, archive)
      console.log(`[UvManager] Downloading uv from ${url}`)

      // Download archive
      const res = await followRedirects(url)
      await pipeline(res, createWriteStream(archivePath))

      // Extract
      if (isZip) {
        // Windows: use PowerShell to extract
        await execFileAsync('powershell', [
          '-NoProfile', '-Command',
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force`
        ], { timeout: 60_000 })
      } else {
        await execFileAsync('tar', ['xzf', archivePath, '-C', tempDir, '--strip-components=1'], { timeout: 60_000 })
      }

      // Move binary to managed dir
      const extractedBinary = join(tempDir, binaryName)
      if (!existsSync(extractedBinary)) {
        throw new Error(`Binary ${binaryName} not found after extraction in ${tempDir}`)
      }

      // Atomic-ish move: copy to temp in target dir, then rename
      const tempTarget = `${targetPath}.tmp`
      renameSync(extractedBinary, tempTarget)
      renameSync(tempTarget, targetPath)

      // Set executable permission (unix)
      if (process.platform !== 'win32') {
        chmodSync(targetPath, 0o755)
      }

      // macOS: remove quarantine attribute
      if (process.platform === 'darwin') {
        try {
          await execFileAsync('xattr', ['-d', 'com.apple.quarantine', targetPath], { timeout: 5_000 })
        } catch {
          // Quarantine attribute may not be present — that's fine
        }
      }

      console.log(`[UvManager] Installed uv to ${targetPath}`)
      return targetPath
    } finally {
      // Clean up temp dir
      try {
        const { rmSync } = await import('fs')
        rmSync(tempDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Python provisioning
  // ---------------------------------------------------------------------------

  async ensurePython(minVersion = '3.12'): Promise<void> {
    const uv = await this.ensureUv()
    const hasPython = await this._hasPython(uv, minVersion)
    if (hasPython) return

    console.log(`[UvManager] Installing Python ${minVersion}...`)
    await execFileAsync(uv, ['python', 'install', minVersion], { timeout: 300_000 })
    console.log(`[UvManager] Python ${minVersion} installed`)
  }

  async isPythonAvailable(minVersion = '3.12'): Promise<boolean> {
    try {
      const uv = await this.ensureUv()
      return this._hasPython(uv, minVersion)
    } catch {
      return false
    }
  }

  private async _hasPython(uv: string, minVersion: string): Promise<boolean> {
    try {
      // uv python find exits 0 and prints a path if a matching Python is found
      await execFileAsync(uv, ['python', 'find', minVersion], { timeout: 10_000 })
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Tool lifecycle
  // ---------------------------------------------------------------------------

  async toolInstall(
    pkg: string,
    version?: string,
    onProgress?: (message: string) => void
  ): Promise<void> {
    const uv = await this.ensureUv()
    const spec = version ? `${pkg}@${version}` : pkg
    onProgress?.(`Installing ${spec} via uv...`)
    console.log(`[UvManager] Installing tool: ${spec}`)

    await execFileAsync(uv, ['tool', 'install', spec], {
      timeout: 120_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })

    onProgress?.(`Installed ${spec}`)
    console.log(`[UvManager] Installed tool: ${spec}`)
  }

  async toolUninstall(pkg: string): Promise<void> {
    const uv = await this.ensureUv()
    console.log(`[UvManager] Uninstalling tool: ${pkg}`)
    await execFileAsync(uv, ['tool', 'uninstall', pkg], { timeout: 30_000 })
  }

  /**
   * Absolute path to a tool's executable, or throw so callers fall back to
   * `uv tool run <pkg>`.
   *
   * `uv tool dir` is the *venv* root (~/.local/share/uv/tools) — it holds one
   * DIRECTORY per tool, not the entry points. Joining the package name there
   * yields `.../tools/<pkg>`, which existsSync() accepts and spawn() then
   * rejects with EACCES. Executables live in `uv tool dir --bin`
   * (~/.local/bin, or UV_TOOL_BIN_DIR/XDG_BIN_HOME when set), so ask for that
   * and require the result to be a file.
   */
  async resolveEntryPoint(pkg: string): Promise<string> {
    const uv = await this.ensureUv()
    const isFile = (p: string) => { try { return statSync(p).isFile() } catch { return false } }
    const exeName = (name: string) => process.platform === 'win32' ? `${name}.exe` : name

    // An entry point is not always named after its package, so prefer the
    // names uv itself reports for this tool.
    const names = [...new Set([...await this.listEntryPoints(pkg), pkg])]

    const binDirs: string[] = []
    try {
      const { stdout } = await execFileAsync(uv, ['tool', 'dir', '--bin'], { timeout: 10_000 })
      if (stdout.trim()) binDirs.push(stdout.trim())
    } catch {
      // uv too old for `--bin` — fall through to the conventional locations
    }
    binDirs.push(join(homedir(), '.local', 'bin'))

    // Last resort: the tool's own venv bin dir, which uv symlinks from.
    try {
      const { stdout } = await execFileAsync(uv, ['tool', 'dir'], { timeout: 10_000 })
      const toolDir = stdout.trim()
      if (toolDir) {
        binDirs.push(join(toolDir, pkg, process.platform === 'win32' ? 'Scripts' : 'bin'))
      }
    } catch {
      // uv tool dir unavailable — the dirs above are all we have
    }

    for (const dir of binDirs) {
      for (const name of names) {
        const entryPoint = join(dir, exeName(name))
        if (isFile(entryPoint)) return entryPoint
      }
    }

    // Fallback: use `uv tool run` as the spawn command
    throw new Error(`Entry point for ${pkg} not found in ${binDirs.join(', ')}`)
  }

  /** Entry-point names uv lists under a package (`uv tool list` prints them as "- <name>"). */
  private async listEntryPoints(pkg: string): Promise<string[]> {
    const uv = await this.ensureUv()
    try {
      const { stdout } = await execFileAsync(uv, ['tool', 'list'], { timeout: 10_000 })
      const names: string[] = []
      let inPkg = false
      for (const line of stdout.split('\n')) {
        if (line.startsWith('- ')) {
          if (inPkg) names.push(line.slice(2).trim())
        } else {
          inPkg = line.match(/^(\S+)\s+v?\S+/)?.[1] === pkg
        }
      }
      return names.filter(Boolean)
    } catch {
      return []
    }
  }

  async listTools(): Promise<InstalledTool[]> {
    const uv = await this.ensureUv()
    try {
      const { stdout } = await execFileAsync(uv, ['tool', 'list'], { timeout: 10_000 })
      // Format: "package-name v1.2.3\n- entry-point\n"
      const tools: InstalledTool[] = []
      for (const line of stdout.split('\n')) {
        const match = line.match(/^(\S+)\s+v?(\S+)/)
        if (match && !line.startsWith('-') && !line.startsWith(' ')) {
          tools.push({ name: match[1], version: match[2] })
        }
      }
      return tools
    } catch {
      return []
    }
  }

  async getUvVersion(): Promise<string | null> {
    try {
      const uv = await this.ensureUv()
      return this._getVersion(uv)
    } catch {
      return null
    }
  }
}
