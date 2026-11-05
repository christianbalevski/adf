/**
 * Release notes for the running version, bundled at build time from
 * docs/release-notes/v<version>.md — the same file scripts/release-notes.mjs
 * puts at the top of the GitHub release. A version without a file has none.
 *
 * A release that needs something from the user carries an "## Action needed"
 * section; the status bar opens those notes once, on the first launch of
 * that version.
 */

const BUNDLED = import.meta.glob('../../../docs/release-notes/v*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** The bundled notes of `version` (e.g. "0.8.8"), or null. */
export function bundledReleaseNotes(version: string): string | null {
  for (const [path, text] of Object.entries(BUNDLED)) {
    if (path.endsWith(`/v${version}.md`)) return text.trim() || null
  }
  return null
}

/** Whether the notes ask the user to do something. */
export function needsAction(notes: string): boolean {
  return /^##\s+Action needed\b/im.test(notes)
}

const SEEN_KEY = 'adf.releaseNotesSeen'

/** The last version whose notes were opened here, or null (never, or storage unavailable). */
export function seenReleaseNotesVersion(): string | null {
  try { return localStorage.getItem(SEEN_KEY) } catch { return null }
}

export function markReleaseNotesSeen(version: string): void {
  try { localStorage.setItem(SEEN_KEY, version) } catch { /* the dot comes back next launch */ }
}
