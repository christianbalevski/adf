/**
 * Apply one daemon setting when its value changes, as Studio's SETTINGS_SET
 * applies `sandboxMaxWorkers` at once. The daemon's settings file has more
 * than one writer (PATCH /settings, an embedded Studio on the same file,
 * a hand edit), and FileSettingsStore re-reads it on `get` when it changed on
 * disk, so the value is polled rather than hooked into one writer.
 */

export interface LiveSettingSource {
  get(key: string): unknown
}

export interface LiveSettingOptions {
  /** Poll interval; default 2 s. */
  intervalMs?: number
}

/**
 * Calls `apply(value, true)` now and `apply(value, false)` on every later
 * change of `key` (compared with Object.is). Returns the
 * stop function. The timer does not keep the process alive.
 */
export function applySettingLive(
  settings: LiveSettingSource,
  key: string,
  apply: (value: unknown, initial: boolean) => void,
  opts: LiveSettingOptions = {},
): () => void {
  let applied = settings.get(key)
  apply(applied, true)
  const timer = setInterval(() => {
    let next: unknown
    try {
      next = settings.get(key)
    } catch (err) {
      console.error(`[ADF Daemon] Reading setting ${key} failed:`, err)
      return
    }
    if (Object.is(next, applied)) return
    applied = next
    try {
      apply(next, false)
    } catch (err) {
      console.error(`[ADF Daemon] Applying setting ${key} failed:`, err)
    }
  }, opts.intervalMs ?? 2_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
