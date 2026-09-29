// Ctrl+C twice to quit: the first press arms and says so, a second press
// within the window leaves. Wired by the shell's global key handler.

export const QUIT_WINDOW_MS = 1500

export function createQuitGuard(windowMs = QUIT_WINDOW_MS, now: () => number = Date.now) {
  let armedAt = -Infinity
  /** Returns true when this press quits. */
  return function press(exit: () => void, notify: (text: string) => void): boolean {
    const t = now()
    if (t - armedAt <= windowMs) {
      armedAt = -Infinity
      exit()
      return true
    }
    armedAt = t
    notify('Press Ctrl+C again to quit. Agents keep running in the daemon.')
    return false
  }
}
