import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync
} from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CodeExecutionPackage } from '../../shared/types/adf-v02.types'
import { getUserDataPath } from '../utils/user-data-path'

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === 'win32'
const NPM_BIN = IS_WIN ? 'npm.cmd' : 'npm'

const MAX_PACKAGE_SIZE_MB = 50
const MAX_TOTAL_SIZE_MB = 200
const LOG_TAG = '[SandboxPackages]'

interface PackageManifestEntry {
  name: string
  version: string
  installedAt: number
  size_mb: number
  /** Agent name that installed this package (if installed via npm_install tool). */
  installedBy?: string
}

interface PackagesManifest {
  packages: Record<string, PackageManifestEntry>
}

/**
 * Manages user-installed npm packages for the code execution sandbox.
 *
 * Packages are installed to ~/.adf-studio/sandbox-packages/ with a flat
 * shared node_modules. Config determines which packages each agent can import.
 * All packages must be pure JS — native addons are detected and rejected.
 */
export class SandboxPackagesService {
  private getBaseDir(): string {
    return join(getUserDataPath(), 'sandbox-packages')
  }

  private getManifestPath(): string {
    return join(this.getBaseDir(), 'sandbox-packages-manifest.json')
  }

  private loadManifest(): PackagesManifest {
    try {
      const path = this.getManifestPath()
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf-8'))
      }
    } catch { /* corrupted — start fresh */ }
    return { packages: {} }
  }

  private saveManifest(manifest: PackagesManifest): void {
    const baseDir = this.getBaseDir()
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
    writeFileSync(this.getManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  /** Ensure the base directory has a package.json for npm to work with. */
  private ensureBaseDir(): void {
    const baseDir = this.getBaseDir()
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
    const pkgJsonPath = join(baseDir, 'package.json')
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(pkgJsonPath, JSON.stringify({ name: 'sandbox-packages', private: true }, null, 2))
    }
  }

  /**
   * Install an npm package. Checks for native addons and size limits.
   * Returns the installed version and size.
   */
  async install(
    name: string,
    version?: string,
    onProgress?: (message: string) => void,
    agentName?: string
  ): Promise<{ name: string; version: string; size_mb: number; already_installed: boolean }> {
    const manifest = this.loadManifest()
    const versionSpec = version ?? 'latest'

    // Check if already installed at a compatible version
    const existing = manifest.packages[name]
    if (existing && version && existing.version === version) {
      return { name, version: existing.version, size_mb: existing.size_mb, already_installed: true }
    }

    this.ensureBaseDir()
    const baseDir = this.getBaseDir()

    onProgress?.(`Installing ${name}@${versionSpec}...`)

    try {
      const { stdout, stderr } = await execFileAsync(
        NPM_BIN,
        ['install', '--save', '--no-audit', '--no-fund', `${name}@${versionSpec}`],
        {
          cwd: baseDir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 120_000,
          shell: IS_WIN
        }
      )

      if (stderr && !stderr.includes('npm warn')) {
        console.warn(`${LOG_TAG} npm stderr for ${name}:`, stderr)
      }
      console.log(`${LOG_TAG} npm output:`, stdout.slice(0, 500))

      // Verify the package actually installed
      const pkgJsonPath = join(baseDir, 'node_modules', name, 'package.json')
      if (!existsSync(pkgJsonPath)) {
        throw new Error(`Package directory not found after install: ${pkgJsonPath}`)
      }

      // Read actual installed version
      let installedVersion = versionSpec
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        installedVersion = pkgJson.version ?? versionSpec
      } catch { /* use requested version */ }

      // Check for native addons
      const nativeCheck = this.checkNativeAddons(join(baseDir, 'node_modules'), name)
      if (nativeCheck) {
        // Rollback: uninstall the package
        await this.npmUninstall(name)
        throw new NativeAddonError(
          `Package "${name}" requires native code and cannot run in the sandbox: ${nativeCheck}`
        )
      }

      // Check size limits
      const sizeMb = this.getPackageSizeMb(join(baseDir, 'node_modules', name))
      if (sizeMb > MAX_PACKAGE_SIZE_MB) {
        await this.npmUninstall(name)
        throw new SizeLimitError(
          `Package "${name}" is ${sizeMb.toFixed(1)} MB, exceeding the ${MAX_PACKAGE_SIZE_MB} MB limit.`
        )
      }

      const totalSizeMb = this.getTotalSizeMb()
      if (totalSizeMb > MAX_TOTAL_SIZE_MB) {
        await this.npmUninstall(name)
        throw new SizeLimitError(
          `Total sandbox packages size (${totalSizeMb.toFixed(1)} MB) would exceed the ${MAX_TOTAL_SIZE_MB} MB limit.`
        )
      }

      // Update manifest
      manifest.packages[name] = {
        name,
        version: installedVersion,
        installedAt: Date.now(),
        size_mb: Math.round(sizeMb * 10) / 10,
        ...(agentName ? { installedBy: agentName } : {})
      }
      this.saveManifest(manifest)

      onProgress?.(`Installed ${name}@${installedVersion}`)
      console.log(`${LOG_TAG} Installed ${name}@${installedVersion} (${sizeMb.toFixed(1)} MB)`)

      return { name, version: installedVersion, size_mb: Math.round(sizeMb * 10) / 10, already_installed: false }
    } catch (error) {
      if (error instanceof NativeAddonError || error instanceof SizeLimitError) {
        throw error
      }
      throw new Error(`Failed to install ${name}@${versionSpec}: ${String(error)}`)
    }
  }

  /** Remove a package from the manifest. Does NOT delete from disk (other agents may use it). */
  uninstall(name: string): boolean {
    const manifest = this.loadManifest()
    if (!manifest.packages[name]) return false
    delete manifest.packages[name]
    this.saveManifest(manifest)
    console.log(`${LOG_TAG} Removed ${name} from manifest`)
    return true
  }

  /** Check if a package is installed (optionally at a specific version). */
  isInstalled(name: string, version?: string): boolean {
    const manifest = this.loadManifest()
    const entry = manifest.packages[name] ?? this.reconcilePackageFromDisk(manifest, name)
    if (!entry) return false
    if (version && entry.version !== version) return false
    return true
  }

  /** Return packages from the list that are not installed. */
  checkMissing(packages: CodeExecutionPackage[]): CodeExecutionPackage[] {
    const manifest = this.loadManifest()
    return packages.filter((pkg) => {
      const entry = manifest.packages[pkg.name] ?? this.reconcilePackageFromDisk(manifest, pkg.name)
      if (!entry) return true
      return entry.version !== pkg.version
    })
  }

  /** Base path for sandbox package installations. */
  getBasePath(): string {
    return this.getBaseDir()
  }

  /** List of all installed module names from the manifest. */
  getInstalledModules(): string[] {
    const manifest = this.loadManifest()
    return Object.keys(manifest.packages)
  }

  /** Return full manifest entries for UI display. */
  getInstalledPackages(): PackageManifestEntry[] {
    const manifest = this.loadManifest()
    return Object.values(manifest.packages)
  }

  /**
   * Recover manifest metadata from an installed package directory. This handles
   * older installs or manifest drift without forcing users to reinstall packages.
   */
  private reconcilePackageFromDisk(manifest: PackagesManifest, name: string): PackageManifestEntry | null {
    const pkgJsonPath = join(this.getBaseDir(), 'node_modules', name, 'package.json')
    if (!existsSync(pkgJsonPath)) return null

    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version?: string }
      const version = pkgJson.version
      if (!version) return null

      const pkgDir = join(this.getBaseDir(), 'node_modules', name)
      const sizeMb = this.getPackageSizeMb(pkgDir)
      const entry: PackageManifestEntry = {
        name,
        version,
        installedAt: Date.now(),
        size_mb: Math.round(sizeMb * 10) / 10
      }
      manifest.packages[name] = entry
      this.saveManifest(manifest)
      console.log(`${LOG_TAG} Reconciled ${name}@${version} from installed package directory`)
      return entry
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Native addon detection
  // ---------------------------------------------------------------------------

  /**
   * Scan the installed package and its dependencies for native addon indicators.
   * Returns a description of what was found, or null if clean.
   */
  private checkNativeAddons(nodeModulesDir: string, packageName: string): string | null {
    const pkgDir = join(nodeModulesDir, packageName)
    if (!existsSync(pkgDir)) return null

    // Check the target package and all its nested node_modules
    return this.scanDirForNativeAddons(pkgDir)
      ?? this.scanDepsForNativeAddons(nodeModulesDir, packageName)
  }

  /** Scan a directory tree for native addon files. */
  private scanDirForNativeAddons(dir: string): string | null {
    // Check for binding.gyp in the package root
    if (existsSync(join(dir, 'binding.gyp'))) {
      return `binding.gyp found in ${dir}`
    }

    // Check package.json for native-related scripts and deps
    const pkgJsonPath = join(dir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

        // Check install/postinstall scripts for gyp-related commands
        const scripts = pkgJson.scripts ?? {}
        for (const scriptKey of ['install', 'postinstall', 'preinstall']) {
          const script = scripts[scriptKey]
          if (typeof script === 'string') {
            if (/node-gyp|prebuild-install|node-pre-gyp|cmake-js/i.test(script)) {
              return `Native build script in ${scriptKey}: "${script}"`
            }
          }
        }

        // Check for gypfile flag
        if (pkgJson.gypfile === true) {
          return `gypfile: true in ${pkgJsonPath}`
        }
      } catch { /* ignore parse errors */ }
    }

    return null
  }

  /** Walk the dependency tree and check each dependency for native addons. */
  private scanDepsForNativeAddons(nodeModulesDir: string, packageName: string): string | null {
    const pkgJsonPath = join(nodeModulesDir, packageName, 'package.json')
    if (!existsSync(pkgJsonPath)) return null

    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.optionalDependencies
      }

      for (const depName of Object.keys(allDeps)) {
        const depDir = join(nodeModulesDir, depName)
        if (!existsSync(depDir)) continue
        const result = this.scanDirForNativeAddons(depDir)
        if (result) return `Dependency "${depName}": ${result}`
      }
    } catch { /* ignore */ }

    return null
  }

  // ---------------------------------------------------------------------------
  // Size calculation
  // ---------------------------------------------------------------------------

  private getPackageSizeMb(dir: string): number {
    return this.getDirSizeBytes(dir) / (1024 * 1024)
  }

  private getTotalSizeMb(): number {
    const nodeModulesDir = join(this.getBaseDir(), 'node_modules')
    if (!existsSync(nodeModulesDir)) return 0
    return this.getDirSizeBytes(nodeModulesDir) / (1024 * 1024)
  }

  private getDirSizeBytes(dir: string): number {
    let total = 0
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          total += this.getDirSizeBytes(fullPath)
        } else if (entry.isFile()) {
          total += statSync(fullPath).size
        }
      }
    } catch { /* ignore access errors */ }
    return total
  }

  // ---------------------------------------------------------------------------
  // npm uninstall (used for rollback only)
  // ---------------------------------------------------------------------------

  private async npmUninstall(name: string): Promise<void> {
    try {
      await execFileAsync(
        NPM_BIN,
        ['uninstall', '--save', '--no-audit', '--no-fund', name],
        {
          cwd: this.getBaseDir(),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 60_000,
          shell: IS_WIN
        }
      )
    } catch (err) {
      console.warn(`${LOG_TAG} npm uninstall rollback failed for ${name}:`, err)
    }
  }
}

/** Thrown when a package contains native addons. */
export class NativeAddonError extends Error {
  readonly code = 'native_addon'
  constructor(message: string) { super(message) }
}

/** Thrown when a package exceeds size limits. */
export class SizeLimitError extends Error {
  readonly code = 'size_limit'
  constructor(message: string) { super(message) }
}
