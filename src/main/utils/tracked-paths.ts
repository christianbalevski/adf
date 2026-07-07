import { realpathSync } from 'fs'
import * as nodePath from 'path'

/**
 * Path containment helpers for tracked directories.
 *
 * Tracked-dir paths arrive from many sources (native dialogs, agent tools,
 * chokidar events, persisted settings) with inconsistent separators, casing,
 * trailing slashes, and symlinks (e.g. macOS /tmp → /private/tmp). All
 * containment decisions must go through these helpers rather than string
 * prefix checks.
 */

/** Filesystems are case-insensitive by default on Windows and macOS. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

export interface ContainsPathOptions {
  caseInsensitive?: boolean
  /** Path implementation, injectable for cross-platform tests. */
  pathMod?: nodePath.PlatformPath
}

/**
 * Canonicalize a path: absolute, symlinks resolved when the path exists,
 * trailing separators stripped. Falls back to resolve() for paths that
 * don't exist (yet).
 */
export function canonicalizePath(p: string): string {
  const abs = nodePath.resolve(p)
  try {
    return realpathSync.native(abs)
  } catch {
    // Path doesn't exist (yet): canonicalize the nearest existing ancestor
    // and re-append the remainder, so symlinks and Windows 8.3 short names
    // in the existing portion still resolve consistently.
    const parent = nodePath.dirname(abs)
    if (parent === abs) return abs // filesystem root
    return nodePath.join(canonicalizePath(parent), nodePath.basename(abs))
  }
}

/**
 * True if `child` is `parent` itself or located anywhere beneath it.
 * Expects already-canonical absolute paths (see canonicalizePath).
 */
export function containsPath(parent: string, child: string, opts?: ContainsPathOptions): boolean {
  const pathMod = opts?.pathMod ?? nodePath
  const caseInsensitive = opts?.caseInsensitive ?? CASE_INSENSITIVE_FS
  const a = caseInsensitive ? parent.toLowerCase() : parent
  const b = caseInsensitive ? child.toLowerCase() : child
  const rel = pathMod.relative(a, b)
  if (rel === '') return true
  if (pathMod.isAbsolute(rel)) return false
  // First segment must not be '..' — startsWith('..') alone would
  // misclassify siblings like '..foo'.
  return rel.split(pathMod.sep)[0] !== '..'
}

/**
 * True if `child` is `parent` itself or located anywhere beneath it,
 * canonicalizing both sides first.
 */
export function isSameOrSubPath(parent: string, child: string): boolean {
  return containsPath(canonicalizePath(parent), canonicalizePath(child))
}

/**
 * Collapse a tracked-directory list so no entry is a duplicate of, or a
 * subdirectory of, another entry. Keeps the original (non-canonicalized)
 * strings of the surviving entries, preserving first-seen order.
 */
export function dedupeTrackedDirectories(dirs: string[]): string[] {
  const result: string[] = []
  for (const dir of dirs) {
    if (result.some((kept) => isSameOrSubPath(kept, dir))) continue
    // A new parent absorbs previously kept subdirectories
    for (let i = result.length - 1; i >= 0; i--) {
      if (isSameOrSubPath(dir, result[i])) result.splice(i, 1)
    }
    result.push(dir)
  }
  return result
}
