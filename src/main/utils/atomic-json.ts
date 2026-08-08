import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  statSync,
  readdirSync,
} from 'fs'
import { dirname, basename, join } from 'path'
import { randomBytes } from 'crypto'

/** Attempts before giving up on an atomic rename over an open destination. */
const RENAME_ATTEMPTS = 3
const RENAME_RETRY_DELAY_MS = 50
/** Temp files older than this are considered abandoned and are cleaned up. */
const STALE_TMP_AGE_MS = 60 * 60 * 1000

/** Synchronous sleep without spinning (Node allows Atomics.wait on the main thread). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Permission bits of an existing file, or null when absent/unreadable. */
function existingFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}

/**
 * Atomically persist JSON: write to a process-unique sibling temp file, then
 * rename. rename() on the same volume is atomic on both NTFS and POSIX, so a
 * crash mid-write can never leave a truncated file at `path`.
 *
 * The temp name embeds pid + random bytes so concurrent writers (Studio and
 * the daemon share adf-settings.json) never interleave into one temp file.
 *
 * On Windows, MoveFileEx cannot replace a destination held open by another
 * process (EPERM/EACCES). We retry briefly, then fall back to a direct
 * write of the destination — non-atomic, but a settings write must never
 * fail outright just because another process has the file open.
 *
 * Settings hold secrets: a brand-new file is created with mode 0o600; an
 * existing file's mode is preserved (fresh-inode renames would otherwise
 * reset it on POSIX).
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2)
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, json, { encoding: 'utf-8', mode: existingFileMode(path) ?? 0o600 })
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(tmp, path)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err
        if (attempt >= RENAME_ATTEMPTS) {
          // Destination held open elsewhere — last resort: direct overwrite,
          // accepting non-atomicity over never persisting at all.
          writeFileSync(path, json, 'utf-8')
          try {
            unlinkSync(tmp)
          } catch {
            // best effort
          }
          break
        }
        sleepSync(RENAME_RETRY_DELAY_MS)
      }
    }
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw err
  }
  cleanStaleTmpFiles(path)
}

/** Remove abandoned `${path}.*.tmp` files (crashed writers) older than ~1h. */
function cleanStaleTmpFiles(path: string): void {
  try {
    const dir = dirname(path)
    const prefix = `${basename(path)}.`
    const cutoff = Date.now() - STALE_TMP_AGE_MS
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch {
        // best effort — another process may have removed it already
      }
    }
  } catch {
    // best effort
  }
}

export interface ReadJsonResult<T> {
  data: T | null
  /** Path the unparseable original was moved (or copied) to, if corruption was found. */
  quarantinedTo: string | null
  /**
   * True when the file was corrupt AND could be neither moved nor copied
   * aside. The corrupt bytes are the ONLY copy of the user's data —
   * callers MUST NOT write to this path until a later read succeeds
   * (or quarantines), or they would destroy recoverable data.
   */
  corruptUnpreserved: boolean
}

/**
 * Read + parse a JSON file. On parse failure the corrupt file is moved
 * aside (never silently discarded) so user data remains recoverable,
 * and { data: null, quarantinedTo } is returned for the caller to
 * surface loudly before falling back to defaults.
 *
 * If the rename fails (file held open by another process), the file is
 * copied to the quarantine name instead. If even that fails,
 * `corruptUnpreserved` is set and callers must refuse to overwrite.
 */
export function readJsonOrQuarantine<T = unknown>(path: string): ReadJsonResult<T> {
  if (!existsSync(path)) return { data: null, quarantinedTo: null, corruptUnpreserved: false }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { data: null, quarantinedTo: null, corruptUnpreserved: false }
  }
  try {
    return { data: JSON.parse(raw) as T, quarantinedTo: null, corruptUnpreserved: false }
  } catch {
    const quarantine = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, quarantine)
      return { data: null, quarantinedTo: quarantine, corruptUnpreserved: false }
    } catch {
      try {
        copyFileSync(path, quarantine)
        return { data: null, quarantinedTo: quarantine, corruptUnpreserved: false }
      } catch {
        return { data: null, quarantinedTo: null, corruptUnpreserved: true }
      }
    }
  }
}
