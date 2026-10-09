/**
 * On-disk cache of rendered agent orbitals (PNG), shared by the main-process
 * IPC handlers and the renderer that draws them.
 *
 * Layout: <userData>/orbitals/v<ORBITAL_RENDER_REV>/<sha256(seed)>-<theme>-<kind>.png
 *
 * The seed is hashed so a DID or file path never becomes part of a file name.
 * Bump ORBITAL_RENDER_REV whenever the drawing changes (a re-vendored
 * orbital.js, or a new frame count or size in the renderer); the old
 * directory is then never read again.
 */

export const ORBITAL_RENDER_REV = 1

export type OrbitalTheme = 'light' | 'dark'
/** `static`: one frame at t = 0. `strip`: one rotation as a horizontal sprite strip. */
export type OrbitalImageKind = 'static' | 'strip'

/** What the renderer asks the disk cache for. */
export interface OrbitalCacheRequest {
  seed: string
  theme: OrbitalTheme
  kind: OrbitalImageKind
}

export const ORBITAL_CACHE_DIR = `orbitals/v${ORBITAL_RENDER_REV}`
/** Longest seed accepted over IPC. DIDs and file paths fit with room to spare. */
export const ORBITAL_SEED_MAX = 4096
/** Largest PNG accepted for caching. A strip is well under this. */
export const ORBITAL_PNG_MAX_BYTES = 4 * 1024 * 1024

export function isOrbitalTheme(v: unknown): v is OrbitalTheme {
  return v === 'light' || v === 'dark'
}

export function isOrbitalImageKind(v: unknown): v is OrbitalImageKind {
  return v === 'static' || v === 'strip'
}

/** File name inside ORBITAL_CACHE_DIR. `seedHash` is the hex sha256 of the seed. */
export function orbitalCacheFileName(seedHash: string, theme: OrbitalTheme, kind: OrbitalImageKind): string {
  return `${seedHash}-${theme}-${kind}.png`
}
