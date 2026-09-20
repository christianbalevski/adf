/**
 * Panel sizes the user dragged, remembered across restarts. Same best-effort
 * localStorage idiom as the chat placement pref: a failed read falls back to
 * the default, a failed write just means the size won't stick.
 */

export const SIDEBAR_WIDTH_KEY = 'adf-sidebar-width'
export const SIDEBAR_RUNNING_CAP_KEY = 'adf-sidebar-running-cap'
export const RIGHT_PANEL_WIDTH_KEY = 'adf-right-panel-width'
export const LOGS_PANEL_HEIGHT_KEY = 'adf-logs-panel-height'

export function clampSize(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** A stored size outside [min, max] (limits changed between versions) is clamped, not dropped. */
export function loadStoredSize(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampSize(Math.round(parsed), min, max) : fallback
  } catch {
    return fallback
  }
}

export function saveStoredSize(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)))
  } catch { /* storage full/unavailable — non-fatal, the size just won't stick */ }
}
