import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'

/**
 * Atomically persist JSON: write to a sibling temp file, then rename.
 * rename() on the same volume is atomic on both NTFS and POSIX, so a
 * crash mid-write can never leave a truncated file at `path`.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, path)
}

export interface ReadJsonResult<T> {
  data: T | null
  /** Path the unparseable original was moved to, if corruption was found. */
  quarantinedTo: string | null
}

/**
 * Read + parse a JSON file. On parse failure the corrupt file is moved
 * aside (never silently discarded) so user data remains recoverable,
 * and { data: null, quarantinedTo } is returned for the caller to
 * surface loudly before falling back to defaults.
 */
export function readJsonOrQuarantine<T = unknown>(path: string): ReadJsonResult<T> {
  if (!existsSync(path)) return { data: null, quarantinedTo: null }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { data: null, quarantinedTo: null }
  }
  try {
    return { data: JSON.parse(raw) as T, quarantinedTo: null }
  } catch {
    const quarantine = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, quarantine)
      return { data: null, quarantinedTo: quarantine }
    } catch {
      return { data: null, quarantinedTo: null }
    }
  }
}
