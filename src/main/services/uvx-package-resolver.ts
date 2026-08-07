import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import type { McpInstalledPackage } from '../../shared/types/adf-v02.types'
import type { UvManager } from './uv-manager'
import { getUserDataPath } from '../utils/user-data-path'

interface UvxManifest {
  packages: Record<string, McpInstalledPackage>
}

/**
 * Package resolver for Python MCP servers using uv/uvx.
 * Wraps UvManager with manifest tracking and the same interface as PackageResolver.
 */
export class UvxPackageResolver {
  private uvManager: UvManager
  private manifestFile: string
  /** Parsed-manifest cache keyed on file mtime — getInstalled() is called
   *  per server per agent on the startup path, so avoid re-read + re-parse. */
  private manifestCache: { mtimeMs: number; manifest: UvxManifest } | null = null

  constructor(uvManager: UvManager) {
    this.uvManager = uvManager
    this.manifestFile = 'mcp-servers-python-manifest.json'
  }

  private getManifestPath(): string {
    return join(getUserDataPath(), this.manifestFile)
  }

  private loadManifest(): UvxManifest {
    const path = this.getManifestPath()
    try {
      if (existsSync(path)) {
        const { mtimeMs } = statSync(path)
        if (this.manifestCache && this.manifestCache.mtimeMs === mtimeMs) {
          return this.manifestCache.manifest
        }
        const manifest = JSON.parse(readFileSync(path, 'utf-8')) as UvxManifest
        this.manifestCache = { mtimeMs, manifest }
        return manifest
      }
    } catch {
      // Corrupted manifest — start fresh
    }
    this.manifestCache = null
    return { packages: {} }
  }

  private saveManifest(manifest: UvxManifest): void {
    const dir = getUserDataPath()
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const path = this.getManifestPath()
    writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8')
    try {
      this.manifestCache = { mtimeMs: statSync(path).mtimeMs, manifest }
    } catch {
      this.manifestCache = null
    }
  }

  async install(
    packageName: string,
    version?: string,
    onProgress?: (message: string) => void
  ): Promise<McpInstalledPackage> {
    // Ensure uv + Python are available
    onProgress?.('Checking Python runtime...')
    await this.uvManager.ensureUv()
    await this.uvManager.ensurePython()

    // Install via uv tool install
    await this.uvManager.toolInstall(packageName, version, onProgress)

    // Resolve entry point
    onProgress?.(`Resolving entry point for ${packageName}...`)
    let command: string
    try {
      command = await this.uvManager.resolveEntryPoint(packageName)
    } catch {
      // Fallback: use `uv tool run` as the command
      const uv = await this.uvManager.ensureUv()
      command = `${uv} tool run ${packageName}`
    }

    // Determine installed version from uv tool list
    const resolvedVersion = await this._getInstalledVersion(packageName) ?? version ?? 'unknown'

    const installed: McpInstalledPackage = {
      package: packageName,
      version: resolvedVersion,
      command,
      installPath: '', // uv manages its own install paths
      installedAt: Date.now(),
      runtime: 'uvx'
    }

    // Update manifest
    const manifest = this.loadManifest()
    manifest.packages[packageName] = installed
    this.saveManifest(manifest)

    onProgress?.(`Installed ${packageName}@${resolvedVersion}`)
    console.log(`[UvxPackageResolver] Installed ${packageName}@${resolvedVersion}`)
    return installed
  }

  async uninstall(packageName: string): Promise<void> {
    const manifest = this.loadManifest()
    if (!manifest.packages[packageName]) return

    try {
      await this.uvManager.toolUninstall(packageName)
    } catch (err) {
      console.warn(`[UvxPackageResolver] uv tool uninstall failed for ${packageName}:`, err)
    }

    delete manifest.packages[packageName]
    this.saveManifest(manifest)
    console.log(`[UvxPackageResolver] Uninstalled ${packageName}`)
  }

  listInstalled(): McpInstalledPackage[] {
    const manifest = this.loadManifest()
    return Object.values(manifest.packages)
  }

  getInstalled(packageName: string): McpInstalledPackage | undefined {
    const manifest = this.loadManifest()
    return manifest.packages[packageName]
  }

  private async _getInstalledVersion(packageName: string): Promise<string | null> {
    const tools = await this.uvManager.listTools()
    const match = tools.find((t) => t.name === packageName)
    return match?.version ?? null
  }
}
