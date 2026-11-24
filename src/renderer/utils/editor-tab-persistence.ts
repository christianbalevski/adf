/**
 * Per-agent editor tab persistence (localStorage). Pure user convenience —
 * remembers which files were open (and which was focused) for each agent so
 * returning to an agent, or restarting the app, doesn't reset the editor to
 * just README.md. Only tab *identity* is stored; content is re-read on
 * restore. A browser:// (Computer) tab is kept by path only: its container
 * and port are asked for again on restore, since they may have changed.
 */

import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { BrowserTabMeta } from '../stores/editor-tabs.store'
import { browserSessionAgent } from './browser-session-agent'

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

/** Save the tab store's state: every tab, the Computer tab included. */
export function saveTabState(agentFilePath: string, state: { tabs: { path: string }[]; activeTabPath: string | null }): void {
  saveOpenTabs(agentFilePath, state.tabs.map((t) => t.path), state.activeTabPath)
}

/**
 * The Computer tab a saved `browser://` entry reopens as, for the agent open
 * at `docPath`. The list is the agent's own, so any such entry is its
 * Computer tab, even one saved under an older path (rename, move). Identity
 * only: the viewer asks the container for its current state on mount. Null
 * when the agent no longer has a visible desktop.
 */
export function restoredComputerTab(docPath: string, config: AgentConfig | null | undefined): BrowserTabMeta | null {
  if (!config?.compute?.enabled || config.compute.browser === false) return null
  return {
    agentFilePath: docPath,
    containerName: '',
    ...browserSessionAgent(config),
    hostPort: null,
    phase: 'ready',
  }
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
