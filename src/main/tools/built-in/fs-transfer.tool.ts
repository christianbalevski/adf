/**
 * fs_transfer — Transfer files or directories between any two environments:
 * vfs (agent's virtual filesystem in SQLite), isolated container, shared
 * container, or host workspace.
 *
 * `from` and `to` must be different environments.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  writeFileSync, readFileSync, mkdirSync, mkdtempSync,
  rmSync, cpSync, readdirSync, statSync,
} from 'fs'
import { join, dirname, relative } from 'path'
import { tmpdir } from 'os'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { PodmanService } from '../../services/podman.service'
import type { ComputeCapabilities, ComputeTarget } from './compute-target'
import { ensureHostWorkspace } from '../../services/host-exec.service'

const Endpoint = z.enum(['vfs', 'isolated', 'shared', 'host'])
type Endpoint = z.infer<typeof Endpoint>

const InputSchema = z.object({
  from: Endpoint.describe("Source environment: 'vfs', 'isolated', 'shared', or 'host'."),
  to: Endpoint.describe("Destination environment: 'vfs', 'isolated', 'shared', or 'host'."),
  path: z.string().describe('Path of the file or directory to transfer (relative to the environment root).'),
  save_as: z.string().optional().describe('Destination path. Defaults to the source path.'),
})

export class FsTransferTool implements Tool {
  readonly name = 'fs_transfer'
  readonly description =
    "Transfer files or directories between environments: 'vfs' (agent virtual filesystem), " +
    "'isolated' (agent container), 'shared' (shared container), or 'host' (host workspace). " +
    "'from' and 'to' must differ."
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  constructor(
    private podmanService: PodmanService | null,
    private capabilities: ComputeCapabilities,
  ) {}

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { from, to, path, save_as } = input as z.infer<typeof InputSchema>
    const destPath = save_as ?? path

    if (from === to) {
      return { content: `'from' and 'to' must be different (both are '${from}').`, isError: true }
    }

    const err = this.validateEndpoint(from) ?? this.validateEndpoint(to)
    if (err) return { content: err, isError: true }

    try {
      const tmpDir = mkdtempSync(join(tmpdir(), 'adf-transfer-'))
      try {
        // Materialize source into tmpDir
        await this.pull(from, path, tmpDir, workspace)
        // Push from tmpDir into destination
        await this.push(to, destPath, tmpDir, workspace)

        return {
          content: JSON.stringify({ from, to, path, dest_path: destPath }),
          isError: false,
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    } catch (err) {
      return {
        content: `fs_transfer error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validate that an endpoint is available given agent capabilities
  // ---------------------------------------------------------------------------

  private validateEndpoint(ep: Endpoint): string | null {
    if (ep === 'vfs') return null
    if (ep === 'isolated' && !this.capabilities.hasIsolated)
      return "Target 'isolated' is not available. Set compute.enabled to true."
    if (ep === 'shared' && !this.capabilities.hasShared)
      return "Target 'shared' is not available. Ensure Podman is running."
    if (ep === 'host' && !this.capabilities.hasHost)
      return "Target 'host' is not available. Set compute.host_access to true."
    return null
  }

  // ---------------------------------------------------------------------------
  // Pull: environment → tmpDir/payload  (file or directory)
  // ---------------------------------------------------------------------------

  private async pull(ep: Endpoint, path: string, tmpDir: string, workspace: AdfWorkspace): Promise<void> {
    const staging = join(tmpDir, 'payload')

    if (ep === 'vfs') {
      this.pullVfs(path, staging, workspace)
      return
    }

    if (ep === 'host') {
      const hostPath = join(ensureHostWorkspace(this.capabilities.agentId), path)
      cpSync(hostPath, staging, { recursive: true })
      return
    }

    // Container (isolated or shared)
    const containerName = this.containerName(ep)
    const containerPath = `/workspace/${this.capabilities.agentId}/${path}`
    mkdirSync(staging, { recursive: true })
    await this.podmanService!.copyFromContainer(
      containerPath, staging, containerName
    )
  }

  // ---------------------------------------------------------------------------
  // Push: tmpDir/payload → environment  (file or directory)
  // ---------------------------------------------------------------------------

  private async push(ep: Endpoint, destPath: string, tmpDir: string, workspace: AdfWorkspace): Promise<void> {
    const staging = join(tmpDir, 'payload')

    if (ep === 'vfs') {
      this.pushVfs(destPath, staging, workspace)
      return
    }

    if (ep === 'host') {
      const hostDest = join(ensureHostWorkspace(this.capabilities.agentId), destPath)
      mkdirSync(dirname(hostDest), { recursive: true })
      cpSync(staging, hostDest, { recursive: true })
      return
    }

    // Container (isolated or shared)
    const containerName = this.containerName(ep)
    const containerDest = `/workspace/${this.capabilities.agentId}/${destPath}`
    await this.podmanService!.copyToContainer(
      staging, containerDest, containerName
    )
  }

  // ---------------------------------------------------------------------------
  // VFS helpers (handle both files and "directories" via path prefix)
  // ---------------------------------------------------------------------------

  private pullVfs(path: string, staging: string, workspace: AdfWorkspace): void {
    // Try single file first
    const data = workspace.readFileBuffer(path)
    if (data) {
      mkdirSync(dirname(staging), { recursive: true })
      writeFileSync(staging, data)
      return
    }

    // Treat as directory prefix — collect all files under path/
    const prefix = path.endsWith('/') ? path : path + '/'
    const allFiles = workspace.listFiles()
    const matched = allFiles.filter(f => f.path.startsWith(prefix))
    if (matched.length === 0) {
      throw new Error(`No file or directory found in VFS at "${path}"`)
    }

    mkdirSync(staging, { recursive: true })
    for (const f of matched) {
      const relPath = f.path.slice(prefix.length)
      const buf = workspace.readFileBuffer(f.path)
      if (buf) {
        const dest = join(staging, relPath)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, buf)
      }
    }
  }

  private pushVfs(destPath: string, staging: string, workspace: AdfWorkspace): void {
    const stat = statSync(staging)

    if (stat.isFile()) {
      const data = readFileSync(staging)
      workspace.writeFileBuffer(destPath, data, workspace.getMimeType(destPath))
      return
    }

    // Directory — walk and write each file
    const prefix = destPath.endsWith('/') ? destPath : destPath + '/'
    this.walkDir(staging, (filePath) => {
      const relPath = relative(staging, filePath)
      const vfsPath = prefix + relPath
      const data = readFileSync(filePath)
      workspace.writeFileBuffer(vfsPath, data, workspace.getMimeType(vfsPath))
    })
  }

  private walkDir(dir: string, callback: (filePath: string) => void): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        this.walkDir(full, callback)
      } else {
        callback(full)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private containerName(ep: 'isolated' | 'shared'): string {
    return ep === 'isolated' ? this.capabilities.isolatedContainerName! : 'adf-mcp'
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
