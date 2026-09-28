// Small per-user TUI preferences that outlive a session: sidebar shown or
// hidden, mouse capture, one-time tips. One JSON file next to the Studio
// settings (`<config dir>/adf-studio/tui-prefs.json`), or ADF_TUI_PREFS=<path>
// (`off` keeps everything in memory). Never holds secrets. Unloaded (tests
// rendering <App/> directly) everything stays in memory.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TuiPrefs {
  /** false = the fleet sidebar is hidden (Ctrl+B, /sidebar). */
  sidebar?: boolean
  /** false = the terminal's own mouse (/mouse off); absent / true = mouse mode with in-app selection. */
  mouse?: boolean
  /** Tips already shown once (e.g. `shiftEnter`). */
  tips?: Record<string, boolean>
}

let file: string | null = null
let prefs: TuiPrefs = {}

export function defaultPrefsPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const override = env.ADF_TUI_PREFS
  if (override !== undefined) return override === '' || override === 'off' ? null : override
  const base = platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : platform === 'win32'
      ? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'adf-studio', 'tui-prefs.json')
}

/** Read the prefs file (missing or unreadable = defaults). Later saves write to `path`. */
export function loadPrefs(path: string | null): TuiPrefs {
  file = path
  prefs = {}
  if (!path || !existsSync(path)) return prefs
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed as TuiPrefs
  } catch {
    // A corrupt prefs file only costs the defaults; it is rewritten on the next change.
  }
  return prefs
}

export function getPrefs(): TuiPrefs {
  return prefs
}

/** Merge and persist. Best effort: a read-only disk keeps the change for this session. */
export function savePrefs(patch: Partial<TuiPrefs>): void {
  prefs = { ...prefs, ...patch, ...(patch.tips ? { tips: { ...prefs.tips, ...patch.tips } } : {}) }
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch {
    // Keep going; the choice still holds for this session.
  }
}

/** Forget the loaded file (tests). */
export function resetPrefs(): void {
  file = null
  prefs = {}
}
