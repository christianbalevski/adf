/**
 * Recovery of images an MCP server saved next to itself but only *linked*.
 *
 * Stdio MCP servers run with cwd = the agent's MCP scratch dir (host) or the
 * agent's container workspace (Podman). Some tools (e.g. Playwright's
 * browser_take_screenshot when given a filename) write the image there and
 * return only a file link with no inline image block, leaving the agent
 * unable to see what it captured. The manager recovers them by resolving
 * image-file references in the result text against the server's cwd and
 * loading the ones that actually live inside it.
 *
 * The reader abstracts *where* that cwd is: host filesystem, or a container
 * reached through `podman exec` / `podman cp`.
 */
import { extname, posix, resolve, sep } from 'path'
import { readFileSync, statSync } from 'fs'
import type { PodmanService } from './podman.service'

/** Claude rejects images over ~5MB — skip larger linked files rather than poison the turn. */
export const MAX_LINKED_IMAGE_BYTES = 4.5 * 1024 * 1024
export const MAX_LINKED_IMAGES = 3
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export interface McpLinkedFileReader {
  /** Absolute path under the server cwd for a link found in result text, or null when it escapes the root. */
  resolve(ref: string): string | null
  /** Byte size of a regular file, or null when the path is not one. */
  size(path: string): Promise<number | null>
  read(path: string): Promise<Buffer>
}

export function hostLinkedFileReader(scratchDir: string): McpLinkedFileReader {
  const root = resolve(scratchDir)
  const rootPrefix = (root + sep).toLowerCase()
  return {
    resolve(ref) {
      const resolved = resolve(root, ref)
      return resolved.toLowerCase().startsWith(rootPrefix) ? resolved : null
    },
    async size(path) {
      try {
        const stat = statSync(path)
        return stat.isFile() ? stat.size : null
      } catch {
        return null
      }
    },
    async read(path) {
      return readFileSync(path)
    },
  }
}

/**
 * Reader for a server running inside a managed container. Paths are POSIX
 * regardless of the host platform; bytes come out via `podman cp`.
 */
export function containerLinkedFileReader(
  podmanService: Pick<PodmanService, 'containerFileSize' | 'readContainerFile'>,
  containerName: string,
  cwd: string,
): McpLinkedFileReader {
  const root = posix.resolve('/', cwd)
  const rootPrefix = root === '/' ? '/' : root + '/'
  return {
    resolve(ref) {
      const resolved = posix.resolve(root, ref.replace(/\\/g, '/'))
      return resolved.startsWith(rootPrefix) ? resolved : null
    },
    size(path) {
      return podmanService.containerFileSize(containerName, path)
    },
    read(path) {
      return podmanService.readContainerFile(containerName, path)
    },
  }
}

export async function loadLinkedImages(
  text: string,
  reader: McpLinkedFileReader,
): Promise<{ images: Array<{ data: string; mimeType: string }>; notes: string[] }> {
  const images: Array<{ data: string; mimeType: string }> = []
  const notes: string[] = []
  const seen = new Set<string>()
  const refs = text.match(/[^\s"'`()[\]]+\.(?:png|jpe?g|webp|gif)/gi) ?? []
  for (const ref of refs) {
    if (images.length >= MAX_LINKED_IMAGES) break
    const resolved = reader.resolve(ref)
    if (!resolved) continue
    const key = resolved.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const size = await reader.size(resolved)
      if (size === null) continue
      if (size > MAX_LINKED_IMAGE_BYTES) {
        notes.push(`[Image "${ref}" is ${Math.round(size / 1024)}KB — too large to attach inline. Retake without a filename (or not fullPage) to view it.]`)
        continue
      }
      images.push({
        data: (await reader.read(resolved)).toString('base64'),
        mimeType: IMAGE_EXT_MIME[extname(resolved).toLowerCase()] ?? 'image/png',
      })
    } catch { /* file not present — link didn't refer to a server-cwd file */ }
  }
  return { images, notes }
}
