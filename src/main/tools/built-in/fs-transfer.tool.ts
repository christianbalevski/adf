/**
 * fs_transfer — Transfer files or directories between any two environments:
 * vfs (agent's virtual filesystem in SQLite), isolated container, shared
 * container, or host workspace.
 *
 * `from` and `to` must be different environments.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
// fs/promises throughout: transfers copy whole directory trees, and the sync
// calls ran on the Electron main thread — a large tree froze the UI for the
// duration of the copy.
import {
  writeFile, readFile, mkdir, mkdtemp,
  rm, cp, readdir, stat,
} from 'fs/promises'
import { join, dirname, relative, resolve, isAbsolute, posix, sep } from 'path'
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
    let sourcePath: string
    let destPath: string
    try {
      sourcePath = safeRelativePath(path)
      destPath = safeRelativePath(save_as ?? path)
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }

    if (from === to) {
      return { content: `'from' and 'to' must be different (both are '${from}').`, isError: true }
    }

    const err = this.validateEndpoint(from) ?? this.validateEndpoint(to)
    if (err) return { content: err, isError: true }

    try {
      const tmpDir = await mkdtemp(join(tmpdir(), 'adf-transfer-'))
      try {
        // Materialize source into tmpDir
        await this.pull(from, sourcePath, tmpDir, workspace)
        // Push from tmpDir into destination
        await this.push(to, destPath, tmpDir, workspace)

        return {
          content: JSON.stringify({ from, to, path: sourcePath, dest_path: destPath }),
          isError: false,
        }
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
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
      await this.pullVfs(path, staging, workspace)
      return
    }

    if (ep === 'host') {
      const hostPath = containedHostPath(ensureHostWorkspace(this.capabilities.agentId), path)
      await cp(hostPath, staging, { recursive: true })
      return
    }

    // Container (isolated or shared).
    // `staging` must NOT exist yet: `podman cp` copies a source *into* an
    // existing directory (yielding payload/<basename>), but onto a
    // non-existent path exactly — a file becomes the file, a directory's
    // contents become the directory. Pre-creating it doubled the name
    // (e.g. screenshots/foo.png/foo.png) on every container → vfs transfer.
    const containerName = this.containerName(ep)
    const containerPath = posix.join(this.containerWorkspaceRoot(ep), path)
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
      await this.pushVfs(destPath, staging, workspace)
      return
    }

    if (ep === 'host') {
      const hostDest = containedHostPath(ensureHostWorkspace(this.capabilities.agentId), destPath)
      await mkdir(dirname(hostDest), { recursive: true })
      await cp(staging, hostDest, { recursive: true })
      return
    }

    // Container (isolated or shared).
    // For directories copy `payload/.` (contents) so the tree lands at
    // containerDest whether or not it already exists; a bare `payload` would
    // nest as containerDest/payload/... when the destination directory exists.
    const containerName = this.containerName(ep)
    const containerDest = posix.join(this.containerWorkspaceRoot(ep), destPath)
    const source = (await stat(staging)).isDirectory() ? `${staging}${sep}.` : staging
    await this.podmanService!.copyToContainer(
      source, containerDest, containerName
    )
  }

  // ---------------------------------------------------------------------------
  // VFS helpers (handle both files and "directories" via path prefix)
  // ---------------------------------------------------------------------------

  private async pullVfs(path: string, staging: string, workspace: AdfWorkspace): Promise<void> {
    // Try single file first
    const data = workspace.readFileBuffer(path)
    if (data) {
      await mkdir(dirname(staging), { recursive: true })
      await writeFile(staging, data)
      return
    }

    // Treat as directory prefix — collect all files under path/
    const prefix = path.endsWith('/') ? path : path + '/'
    const allFiles = workspace.listFiles()
    const matched = allFiles.filter(f => f.path.startsWith(prefix))
    if (matched.length === 0) {
      throw new Error(`No file or directory found in VFS at "${path}"`)
    }

    await mkdir(staging, { recursive: true })
    for (const f of matched) {
      const relPath = f.path.slice(prefix.length)
      const buf = workspace.readFileBuffer(f.path)
      if (buf) {
        const dest = join(staging, relPath)
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, buf)
      }
    }
  }

  private async pushVfs(destPath: string, staging: string, workspace: AdfWorkspace): Promise<void> {
    const info = await stat(staging)

    if (info.isFile()) {
      const data = await readFile(staging)
      workspace.writeFileBuffer(destPath, data, workspace.getMimeType(destPath))
      return
    }

    // Directory — walk and write each file
    const prefix = destPath.endsWith('/') ? destPath : destPath + '/'
    await this.walkDir(staging, async (filePath) => {
      const relPath = relative(staging, filePath)
      const vfsPath = prefix + relPath
      const data = await readFile(filePath)
      workspace.writeFileBuffer(vfsPath, data, workspace.getMimeType(vfsPath))
    })
  }

  /** Sequential on purpose: preserves readdir order (and the resulting VFS
   *  write order) exactly as the sync walk did. */
  private async walkDir(dir: string, callback: (filePath: string) => Promise<void>): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.walkDir(full, callback)
      } else {
        await callback(full)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private containerName(ep: 'isolated' | 'shared'): string {
    return ep === 'isolated' ? this.capabilities.isolatedContainerName! : 'adf-mcp'
  }

  private containerWorkspaceRoot(ep: 'isolated' | 'shared'): string {
    return ep === 'isolated' ? '/workspace' : `/workspace/${this.capabilities.agentId}`
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}

function safeRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.startsWith('/') || value.startsWith('\\')) {
    throw new Error('Transfer paths must be non-empty paths relative to the selected environment.')
  }
  const normalized = posix.normalize(value.replace(/\\/g, '/'))
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Transfer paths may not escape the selected environment.')
  }
  return normalized
}

function containedHostPath(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath)
  const fromRoot = relative(root, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Transfer path escapes the host workspace.')
  }
  return candidate
}
