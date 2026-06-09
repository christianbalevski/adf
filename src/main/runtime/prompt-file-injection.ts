/**
 * System-prompt file injection: resolves `{{<path>}}` placeholders in the base
 * prompt / agent instructions to the contents of an `adf_files` entry.
 *
 * Design (see ADF spec §5):
 * - Files only. `{{<path>}}` resolves against the agent's virtual filesystem
 *   (`adf_files`) via the provided reader — never `adf_identity`/`adf_meta`/
 *   `adf_config`. Dynamic / queried values are a lambda + `loop_inject` concern.
 * - Single pass. Injected content is not re-scanned, so a file cannot
 *   chain-inject another (no recursion).
 * - Snapshot. Callers pass a snapshot Map that is filled once and reused for the
 *   session, so injected content is stable mid-session and only refreshes when
 *   the caller clears the map (on compaction / loop_clear).
 * - Missing paths render a visible `[missing file: <path>]` marker so typos are
 *   auditable rather than silently empty.
 */

export type FileReader = (path: string) => string | null

/** Sentinel stored in the snapshot when a referenced file does not exist. */
export const MISSING_FILE_SENTINEL = ' __adf_missing_file__ '

const PLACEHOLDER_SOURCE = '\\{\\{([^{}\\n]+)\\}\\}'

/**
 * Find every `{{<path>}}` placeholder in `sources` and snapshot each referenced
 * file (reading once) into `snapshot`. Returns the sorted, de-duplicated list of
 * referenced paths so the caller can hash their snapshotted contents.
 */
export function collectInjectedFiles(
  sources: string,
  read: FileReader,
  snapshot: Map<string, string>
): string[] {
  const re = new RegExp(PLACEHOLDER_SOURCE, 'g')
  const referenced: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sources)) !== null) {
    const path = m[1].trim()
    if (!referenced.includes(path)) referenced.push(path)
    if (!snapshot.has(path)) snapshot.set(path, read(path) ?? MISSING_FILE_SENTINEL)
  }
  referenced.sort()
  return referenced
}

/**
 * Replace every `{{<path>}}` placeholder in `text` with the snapshotted content
 * of that file. Reads (once) into `snapshot` on demand. Single pass.
 */
export function resolveInjectedFiles(
  text: string,
  read: FileReader,
  snapshot: Map<string, string>
): string {
  const re = new RegExp(PLACEHOLDER_SOURCE, 'g')
  return text.replace(re, (_full, raw: string) => {
    const path = raw.trim()
    if (!snapshot.has(path)) snapshot.set(path, read(path) ?? MISSING_FILE_SENTINEL)
    const val = snapshot.get(path)!
    return val === MISSING_FILE_SENTINEL ? `[missing file: ${path}]` : val
  })
}
