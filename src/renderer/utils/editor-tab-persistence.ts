/**
 * Per-agent editor tab persistence (localStorage). Pure user convenience —
 * remembers which files were open (and which was focused) for each agent so
 * returning to an agent, or restarting the app, doesn't reset the editor to
 * just README.md. Only tab *identity* is stored; content is re-read on
 * restore, and browser:// tabs are excluded (their container/port may be gone).
 */

const KEY_PREFIX = 'adf-open-tabs:'

export interface SavedTabs {
  paths: string[]
  active: string | null
}

/** Last payload written per agent — skips redundant writes (the tabs store
 *  notifies on every keystroke via updateTabContent). */
const lastWritten = new Map<string, string>()

/**
 * While an agent switch is in flight (loadFileContents), tab-store mutations
 * are transitional: content syncs and the reset fire with the NEW agent's
 * filePath while the OLD agent's tabs are still (partially) in the store.
 * Saving during that window clobbers the new agent's saved list, so
 * loadFileContents suspends persistence until its restore completes.
 */
let suspended = false

export function suspendTabPersistence(): void {
  suspended = true
}

export function resumeTabPersistence(): void {
  suspended = false
}

export function saveOpenTabs(agentFilePath: string, paths: string[], active: string | null): void {
  if (suspended) return
  const payload = JSON.stringify({ paths, active })
  if (lastWritten.get(agentFilePath) === payload) return
  lastWritten.set(agentFilePath, payload)
  try {
    localStorage.setItem(KEY_PREFIX + agentFilePath, payload)
  } catch { /* storage full/unavailable — non-fatal */ }
}

/**
 * Re-key a saved tab set when an .adf file is moved on disk (e.g. accept/claim
 * relocating it into the managed default folder). Best-effort — losing the
 * entry just means the editor falls back to the default tabs.
 */
export function migrateOpenTabs(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return
  try {
    const raw = localStorage.getItem(KEY_PREFIX + oldPath)
    if (raw != null) {
      localStorage.setItem(KEY_PREFIX + newPath, raw)
      localStorage.removeItem(KEY_PREFIX + oldPath)
    }
  } catch { /* storage unavailable — non-fatal */ }
  const last = lastWritten.get(oldPath)
  if (last !== undefined) lastWritten.set(newPath, last)
  lastWritten.delete(oldPath)
}

export function loadOpenTabs(agentFilePath: string): SavedTabs | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + agentFilePath)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedTabs
    if (!Array.isArray(parsed.paths)) return null
    return {
      paths: parsed.paths.filter((p): p is string => typeof p === 'string'),
      active: typeof parsed.active === 'string' ? parsed.active : null
    }
  } catch {
    return null
  }
}
