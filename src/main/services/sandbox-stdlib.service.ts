import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getUserDataPath } from '../utils/user-data-path'

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === 'win32'
const NPM_BIN = IS_WIN ? 'npm.cmd' : 'npm'

/**
 * Standard library packages available in the code execution sandbox.
 * All must be pure JS or WASM — no native addons.
 * Versions pinned per Studio release.
 */
const STDLIB_PACKAGES = [
  // Document
  { name: 'xlsx', version: '0.18.5' },
  { name: 'pdf-lib', version: '1.17.1' },
  { name: 'mupdf', version: '0.3.0' },
  { name: 'docx', version: '9.0.2' },
  { name: 'jszip', version: '3.10.1' },
  // Data
  { name: 'sql.js', version: '1.11.0' },
  { name: 'cheerio', version: '1.0.0' },
  { name: 'yaml', version: '2.6.0' },
  { name: 'date-fns', version: '4.1.0' },
  // Image
  { name: 'jimp', version: '1.6.0' },
]

interface StdlibManifest {
  packages: Record<string, { name: string; version: string; installedAt: number }>
}

/**
 * Manages the sandbox standard library — a set of pre-installed npm packages
 * available to all agents in the code execution sandbox.
 *
 * Packages are installed to ~/.adf-studio/sandbox-stdlib/ on first launch
 * (or when versions change). Unlike MCP packages, these are library packages
 * that don't need entry point resolution — only `createRequire` resolution.
 */
export class SandboxStdlibService {
  private ready = false

  private getBaseDir(): string {
    return join(getUserDataPath(), 'sandbox-stdlib')
  }

  private getManifestPath(): string {
    return join(this.getBaseDir(), 'sandbox-stdlib-manifest.json')
  }

  private loadManifest(): StdlibManifest {
    try {
      const path = this.getManifestPath()
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf-8'))
      }
    } catch { /* corrupted — start fresh */ }
    return { packages: {} }
  }

  private saveManifest(manifest: StdlibManifest): void {
    const baseDir = this.getBaseDir()
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
    writeFileSync(this.getManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  /**
   * Ensure all standard library packages are installed at the correct versions.
   * Installs missing or outdated packages. Skips already-correct ones.
   */
  async ensureInstalled(onProgress?: (message: string) => void): Promise<void> {
    const manifest = this.loadManifest()

    const toInstall = STDLIB_PACKAGES.filter((pkg) => {
      const current = manifest.packages[pkg.name]
      return !current || current.version !== pkg.version
    })

    if (toInstall.length === 0) {
      onProgress?.('Standard library up to date')
      this.ready = true
      return
    }

    onProgress?.(`Installing ${toInstall.length} standard library package${toInstall.length > 1 ? 's' : ''}...`)

    for (const pkg of toInstall) {
      try {
        await this.installPackage(pkg.name, pkg.version, manifest, onProgress)
      } catch (err) {
        const msg = `Failed to install stdlib package ${pkg.name}@${pkg.version}: ${err}`
        console.error(`[SandboxStdlib] ${msg}`)
        onProgress?.(msg)
        // Continue with remaining packages — partial stdlib is better than none
      }
    }

    this.saveManifest(manifest)
    onProgress?.('Standard library installation complete')
    this.ready = true
  }

  /**
   * Install a single library package. No entry point resolution needed —
   * these are libraries resolved via createRequire, not CLI tools.
   */
  private async installPackage(
    name: string,
    version: string,
    manifest: StdlibManifest,
    onProgress?: (message: string) => void
  ): Promise<void> {
    const baseDir = this.getBaseDir()
    const safeName = name.replace(/[/@]/g, '_')
    const installDir = join(baseDir, safeName)

    // Clean slate if version changed
    if (existsSync(installDir)) {
      rmSync(installDir, { recursive: true, force: true })
    }
    mkdirSync(installDir, { recursive: true })

    // Initialize package.json
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({ name: `stdlib-${safeName}`, private: true }, null, 2)
    )

    onProgress?.(`Installing ${name}@${version}...`)

    try {
      const { stdout, stderr } = await execFileAsync(
        NPM_BIN,
        ['install', '--save', '--no-audit', '--no-fund', `${name}@${version}`],
        {
          cwd: installDir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 120_000,
          shell: IS_WIN
        }
      )

      if (stderr && !stderr.includes('npm warn')) {
        console.warn(`[SandboxStdlib] npm stderr for ${name}:`, stderr)
      }

      // Verify the package actually installed
      const pkgJsonPath = join(installDir, 'node_modules', name, 'package.json')
      if (!existsSync(pkgJsonPath)) {
        throw new Error(`Package directory not found after install: ${pkgJsonPath}`)
      }

      // Read actual installed version
      let installedVersion = version
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        installedVersion = pkgJson.version ?? version
      } catch { /* use requested version */ }

      manifest.packages[name] = {
        name,
        version: installedVersion,
        installedAt: Date.now()
      }

      onProgress?.(`Installed ${name}@${installedVersion}`)
      console.log(`[SandboxStdlib] Installed ${name}@${installedVersion} at ${installDir}`)
      console.log(`[SandboxStdlib] npm output:`, stdout.slice(0, 500))
    } catch (error) {
      // Clean up on failure
      try { rmSync(installDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new Error(`Failed to install ${name}@${version}: ${String(error)}`)
    }
  }

  /**
   * Base path for stdlib package installations.
   * Each package is in its own subdirectory: <basePath>/<safeName>/node_modules/<pkg>/
   */
  getBasePath(): string {
    return this.getBaseDir()
  }

  /**
   * List of module names available in the standard library.
   */
  getModuleNames(): string[] {
    return STDLIB_PACKAGES.map((p) => p.name)
  }

  /**
   * Whether the stdlib has finished installing.
   */
  isReady(): boolean {
    return this.ready
  }
}
