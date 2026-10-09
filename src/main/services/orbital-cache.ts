/**
 * Disk cache for rendered agent orbitals. The renderer draws them (a worker
 * with OffscreenCanvas) and hands the PNG bytes here; the next launch reads
 * them back instead of redrawing. Async fs only: these calls arrive in bursts
 * when the sidebar mounts and must never block the main process.
 */

import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  ORBITAL_CACHE_DIR,
  ORBITAL_PNG_MAX_BYTES,
  ORBITAL_SEED_MAX,
  isOrbitalImageKind,
  isOrbitalTheme,
  orbitalCacheFileName,
  type OrbitalCacheRequest
} from '../../shared/utils/orbital-cache-key'

export type { OrbitalCacheRequest }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isOrbitalCacheRequest(v: unknown): v is OrbitalCacheRequest {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.seed === 'string' && r.seed.length > 0 && r.seed.length <= ORBITAL_SEED_MAX &&
    isOrbitalTheme(r.theme) && isOrbitalImageKind(r.kind)
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/** Absolute path of one cached image under `root` (Studio's userData). */
export function orbitalCachePath(root: string, req: OrbitalCacheRequest): string {
  const hash = createHash('sha256').update(req.seed, 'utf8').digest('hex')
  return join(root, ORBITAL_CACHE_DIR, orbitalCacheFileName(hash, req.theme, req.kind))
}

/** The cached PNG, or null when there is none (or it cannot be read). */
export async function readOrbitalCache(root: string, req: OrbitalCacheRequest): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(orbitalCachePath(root, req))
    return isPng(buf) ? buf : null
  } catch {
    return null
  }
}

/**
 * Store a PNG. Written to a temp name and renamed so a reader never sees a
 * half-written file. Returns false for anything that is not a PNG of
 * acceptable size, or when the write fails.
 */
export async function writeOrbitalCache(root: string, req: OrbitalCacheRequest, bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength > ORBITAL_PNG_MAX_BYTES || !isPng(bytes)) return false
  const target = orbitalCachePath(root, req)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(join(root, ORBITAL_CACHE_DIR), { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, target)
    return true
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
}
