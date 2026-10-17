import { resolve } from 'node:path'

/**
 * Which `.adf` paths this computer itself handed to the renderer to open: a
 * double-clicked file (OS open-file, command-line argument, second
 * instance) and the Open Recent menu. In remote mode only such a path may
 * be read from this computer's disk and offered as an upload
 * (daemon-mode/remote/handlers.ts). Every other FILE_OPEN path comes from
 * the renderer, which shows paths the daemon sent (tracked folders, the
 * fleet map, approvals); trusting it would let a hostile daemon make
 * Studio read, or offer to upload, any file of this computer (W4-B review).
 *
 * Main records a grant where it sends the path; the renderer cannot add
 * one. Grants expire after 10 minutes.
 */

const TTL_MS = 10 * 60_000
const grants = new Map<string, number>()

function keyOf(filePath: string): string {
  const abs = resolve(filePath)
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs
}

/** Main hands `filePath` of this computer to the renderer to open. */
export function grantLocalOpen(filePath: string, now = Date.now()): void {
  if (typeof filePath !== 'string' || !filePath) return
  for (const [k, expires] of grants) if (expires <= now) grants.delete(k)
  grants.set(keyOf(filePath), now + TTL_MS)
}

/** Did main hand `filePath` to the renderer recently? Reads no file. */
export function hasLocalOpenGrant(filePath: string, now = Date.now()): boolean {
  if (typeof filePath !== 'string' || !filePath || unsafeLocalPath(filePath)) return false
  const expires = grants.get(keyOf(filePath))
  return expires !== undefined && expires > now
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Why `filePath` must not reach a file-system call, or null: a network
 * (UNC) or device path (`\\server\share`, `//server`, `\\?\`, `\\.\`, a
 * Windows device name) makes Windows connect to another machine and send
 * the user's NTLM credentials, or opens a device; a relative path resolves
 * against Studio's working directory.
 */
export function unsafeLocalPath(filePath: string, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) return 'it is not a path'
  if (/^[\\/]{2}/.test(filePath)) return 'it is a network or device path'
  if (platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(filePath)) return 'it is not an absolute path on this computer'
    if (filePath.split(/[\\/]/).some((part) => DEVICE_NAME.test(part))) return 'it names a device'
  } else if (!filePath.startsWith('/')) {
    return 'it is not an absolute path on this computer'
  }
  return null
}

/** Tests. */
export function _resetLocalOpenGrants(): void {
  grants.clear()
}
