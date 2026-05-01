import { join, dirname, resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { McpInstalledPackage } from '../../shared/types/adf-v02.types'
import { getUserDataPath } from '../utils/user-data-path'

const execFileAsync = promisify(execFile)

interface PackageManifest {
  packages: Record<string, McpInstalledPackage>
}

/**
 * Resolves the entry-point command for an installed npm package.
 * Looks for bin entries in package.json, falls back to main.
 */
function resolveEntryPoint(installDir: string, packageName: string): string {
  const pkgJsonPath = join(installDir, 'node_modules', packageName, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    // Try scoped package path
    const parts = packageName.split('/')
    if (parts.length === 2) {
      const scopedPath = join(installDir, 'node_modules', parts[0], parts[1], 'package.json')
      if (existsSync(scopedPath)) {
        return resolveEntryFromPkgJson(scopedPath, installDir, packageName)
      }
    }
    throw new Error(`Package ${packageName} not found after install`)
  }
  return resolveEntryFromPkgJson(pkgJsonPath, installDir, packageName)
}

function resolveEntryFromPkgJson(pkgJsonPath: string, installDir: string, packageName: string): string {
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  const pkgDir = dirname(pkgJsonPath)

  const safePath = (relative: string): string => {
    const resolved = resolve(pkgDir, relative)
    if (!resolved.startsWith(resolve(installDir))) {
      throw new Error(`Entry point "${relative}" in ${packageName} escapes install directory`)
    }
    return resolved
  }

  // Check bin field first (preferred for CLI MCP servers)
  if (pkgJson.bin) {
    if (typeof pkgJson.bin === 'string') {
      return safePath(pkgJson.bin)
    }
    // Pick the first bin entry, or one matching the package name
    const shortName = packageName.split('/').pop()!
    const binPath = pkgJson.bin[shortName] ?? pkgJson.bin[Object.keys(pkgJson.bin)[0]]
    if (binPath) {
      return safePath(binPath)
    }
  }

  // Fall back to main
  if (pkgJson.main) {
    return safePath(pkgJson.main)
  }

  throw new Error(`No bin or main entry found in ${packageName}`)
}

/**
 * General-purpose npm package installer.
 *
 * Each instance manages packages in `~/.adf-studio/<subdirName>/`.
 * Manifest file: `<subdirName>-manifest.json`.
 */
export class PackageResolver {
  private subdirName: string
  private manifestFile: string

  constructor(subdirName = 'mcp-servers') {
    this.subdirName = subdirName
    this.manifestFile = `${subdirName}-manifest.json`
  }

  private getBaseDir(): string {
    return join(getUserDataPath(), this.subdirName)
  }

  private getManifestPath(): string {
    return join(this.getBaseDir(), this.manifestFile)
  }

  private loadManifest(): PackageManifest {
    const path = this.getManifestPath()
    try {
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf-8'))
      }
    } catch {
      // Corrupted manifest — start fresh
    }
    return { packages: {} }
  }

  private saveManifest(manifest: PackageManifest): void {
    const baseDir = this.getBaseDir()
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true })
    }
    writeFileSync(this.getManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  /**
   * Install an npm package into the managed directory.
   * Returns the installed package info on success.
   */
  async install(
    packageName: string,
    onProgress?: (message: string) => void
  ): Promise<McpInstalledPackage> {
    const baseDir = this.getBaseDir()
    // Each package gets its own subdirectory to avoid dependency conflicts
    const safeName = packageName.replace(/[/@]/g, '_')
    const installDir = join(baseDir, safeName)

    if (!existsSync(installDir)) {
      mkdirSync(installDir, { recursive: true })
    }

    // Initialize a package.json if one doesn't exist
    const pkgJsonPath = join(installDir, 'package.json')
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(pkgJsonPath, JSON.stringify({ name: `pkg-${safeName}`, private: true }, null, 2))
    }

    onProgress?.(`Installing ${packageName}...`)

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath.includes('Electron')
          ? 'npm'   // When running in packaged Electron, use system npm
          : 'npm',
        ['install', '--save', '--no-audit', '--no-fund', packageName],
        {
          cwd: installDir,
          env: {
            ...process.env,
            // Avoid Electron's bundled Node interfering with npm
            ELECTRON_RUN_AS_NODE: '1'
          },
          timeout: 120_000  // 2 minute timeout
        }
      )

      if (stderr && !stderr.includes('npm warn')) {
        console.warn(`[PackageResolver] npm stderr for ${packageName}:`, stderr)
      }

      onProgress?.(`Resolving entry point for ${packageName}...`)

      const command = resolveEntryPoint(installDir, packageName)

      // Read installed version from package.json
      let version = 'unknown'
      try {
        const installedPkgJson = JSON.parse(
          readFileSync(join(installDir, 'node_modules', packageName, 'package.json'), 'utf-8')
        )
        version = installedPkgJson.version ?? 'unknown'
      } catch { /* ignore */ }

      const installed: McpInstalledPackage = {
        package: packageName,
        version,
        command,
        installPath: installDir,
        installedAt: Date.now()
      }

      // Update manifest
      const manifest = this.loadManifest()
      manifest.packages[packageName] = installed
      this.saveManifest(manifest)

      onProgress?.(`Installed ${packageName}@${version}`)
      console.log(`[PackageResolver] Installed ${packageName}@${version} at ${installDir}`)
      console.log(`[PackageResolver] npm output:`, stdout.slice(0, 500))

      return installed
    } catch (error) {
      // Clean up on failure
      try { rmSync(installDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new Error(`Failed to install ${packageName}: ${String(error)}`)
    }
  }

  /**
   * Uninstall a managed package.
   */
  async uninstall(packageName: string): Promise<void> {
    const manifest = this.loadManifest()
    const entry = manifest.packages[packageName]
    if (!entry) return

    // Remove the install directory — validate it's within the managed base dir
    const baseDir = this.getBaseDir()
    if (!resolve(entry.installPath).startsWith(resolve(baseDir))) {
      console.error(`[PackageResolver] Refusing to delete "${entry.installPath}" — outside managed directory`)
    } else {
      try {
        rmSync(entry.installPath, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[PackageResolver] Failed to remove ${entry.installPath}:`, err)
      }
    }

    // Update manifest
    delete manifest.packages[packageName]
    this.saveManifest(manifest)
    console.log(`[PackageResolver] Uninstalled ${packageName}`)
  }

  /**
   * List all installed managed packages.
   */
  listInstalled(): McpInstalledPackage[] {
    const manifest = this.loadManifest()
    return Object.values(manifest.packages)
  }

  /**
   * Get info for a specific installed package.
   */
  getInstalled(packageName: string): McpInstalledPackage | undefined {
    const manifest = this.loadManifest()
    return manifest.packages[packageName]
  }

  /**
   * Resolve the command for a registered server.
   * For managed npm packages, returns the resolved entry point.
   * For custom commands, returns the command as-is.
   */
  resolveCommand(registration: { type?: string; npmPackage?: string; command?: string; managed?: boolean }): string | null {
    if (registration.managed && registration.npmPackage) {
      const installed = this.getInstalled(registration.npmPackage)
      if (installed) return 'node'
      return null  // Not yet installed
    }

    if (registration.type === 'npm' && registration.npmPackage) {
      // Legacy unmanaged: use npx
      return 'npx'
    }

    return registration.command ?? null
  }

  /**
   * Resolve args for a registered server.
   * For managed npm packages, returns [entrypoint, ...userArgs].
   * For legacy npm, returns ['-y', packageName, ...userArgs].
   */
  resolveArgs(registration: { type?: string; npmPackage?: string; args?: string[]; managed?: boolean }): string[] {
    if (registration.managed && registration.npmPackage) {
      const installed = this.getInstalled(registration.npmPackage)
      if (!installed) return registration.args ?? []
      // Run via: node <entrypoint> <userArgs...>
      return [installed.command, ...(registration.args ?? [])]
    }

    if (registration.type === 'npm' && registration.npmPackage) {
      return ['-y', registration.npmPackage, ...(registration.args ?? [])]
    }

    return registration.args ?? []
  }
}

/** @deprecated Use PackageResolver instead */
export { PackageResolver as McpPackageResolver }

