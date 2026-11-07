/**
 * Node's largest timer delay. A larger delay (or execFile `timeout`) overflows:
 * Node warns and fires the timer after 1 ms. limits.execution_timeout_ms has no
 * upper bound, so every timer it feeds clamps here.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Clamp `ms` to a delay a timer can hold, leaving room for `headroomMs` added on top later. */
export function clampTimerDelay(ms: number, headroomMs = 0): number {
  return Math.min(ms, MAX_TIMER_DELAY_MS - headroomMs)
}
