/**
 * Per-loop identity colour.
 *
 * An agent's inner loops are separate cognition streams that all publish into
 * the same surfaces (tab strip, timers, `loop_send` cards in main's thread), so
 * each one needs a stable visual signature the eye can follow across those
 * surfaces. The signature is derived from the loop NAME, not from its position
 * in the config, so adding/removing/reordering loops never repaints the others.
 *
 * Two hard rules:
 *
 *  1. Identity is NEVER a dot. The state dot (yellow = active, green = idle,
 *     purple = hibernate, red = error, neutral = off) is the app's canonical
 *     state language; a second dot-shaped colour next to it would make "the
 *     loop is running" ambiguous. Identity only ever paints borders, rails,
 *     underlines, chips and label text.
 *  2. The palette avoids the state hues (yellow/green/purple/red/neutral) and
 *     the app accent blue (which `main` owns), so an identity colour can't be
 *     misread as a state or as the host loop even out of context.
 *
 * Class strings are written out in full: Tailwind scans source text, so an
 * interpolated `border-${hue}-500` would never be generated.
 */

/** Mirrors `MAIN_LOOP` in the agent store — kept literal so this stays a leaf module. */
const MAIN_LOOP_NAME = 'main'

export interface LoopColor {
  /** Text accent for the active tab's label. */
  accent: string
  /** Active-tab underline colour (pairs with `border-b-2`). */
  underline: string
  /** Left rail on a `loop_send` card (pairs with `border-l-[3px]`). */
  rail: string
  /** The `from loop:<name>` / chip label text. */
  label: string
  /** Timer target-loop chip — background + text. */
  badge: string
  /** Composer focus ring for this loop's thread. */
  focus: string
}

/**
 * Ten curated hues, ordered so that neighbouring indices are far apart on the
 * wheel — an agent with two or three loops still gets obviously different
 * colours even when the hash lands them adjacently.
 */
export const LOOP_PALETTE: readonly LoopColor[] = [
  {
    accent: 'text-indigo-700 dark:text-indigo-300',
    underline: 'border-indigo-500 dark:border-indigo-400',
    rail: 'border-l-indigo-500 dark:border-l-indigo-400',
    label: 'text-indigo-600 dark:text-indigo-400',
    badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
    focus: 'focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/25',
  },
  {
    accent: 'text-orange-700 dark:text-orange-300',
    underline: 'border-orange-500 dark:border-orange-400',
    rail: 'border-l-orange-500 dark:border-l-orange-400',
    label: 'text-orange-600 dark:text-orange-400',
    badge: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    focus: 'focus-within:border-orange-400 focus-within:ring-2 focus-within:ring-orange-500/25',
  },
  {
    accent: 'text-teal-700 dark:text-teal-300',
    underline: 'border-teal-500 dark:border-teal-400',
    rail: 'border-l-teal-500 dark:border-l-teal-400',
    label: 'text-teal-600 dark:text-teal-400',
    badge: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
    focus: 'focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-500/25',
  },
  {
    accent: 'text-pink-700 dark:text-pink-300',
    underline: 'border-pink-500 dark:border-pink-400',
    rail: 'border-l-pink-500 dark:border-l-pink-400',
    label: 'text-pink-600 dark:text-pink-400',
    badge: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
    focus: 'focus-within:border-pink-400 focus-within:ring-2 focus-within:ring-pink-500/25',
  },
  {
    accent: 'text-sky-700 dark:text-sky-300',
    underline: 'border-sky-500 dark:border-sky-400',
    rail: 'border-l-sky-500 dark:border-l-sky-400',
    label: 'text-sky-600 dark:text-sky-400',
    badge: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    focus: 'focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-500/25',
  },
  {
    accent: 'text-rose-700 dark:text-rose-300',
    underline: 'border-rose-500 dark:border-rose-400',
    rail: 'border-l-rose-500 dark:border-l-rose-400',
    label: 'text-rose-600 dark:text-rose-400',
    badge: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
    focus: 'focus-within:border-rose-400 focus-within:ring-2 focus-within:ring-rose-500/25',
  },
  {
    accent: 'text-emerald-700 dark:text-emerald-300',
    underline: 'border-emerald-500 dark:border-emerald-400',
    rail: 'border-l-emerald-500 dark:border-l-emerald-400',
    label: 'text-emerald-600 dark:text-emerald-400',
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    focus: 'focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-500/25',
  },
  {
    accent: 'text-fuchsia-700 dark:text-fuchsia-300',
    underline: 'border-fuchsia-500 dark:border-fuchsia-400',
    rail: 'border-l-fuchsia-500 dark:border-l-fuchsia-400',
    label: 'text-fuchsia-600 dark:text-fuchsia-400',
    badge: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
    focus: 'focus-within:border-fuchsia-400 focus-within:ring-2 focus-within:ring-fuchsia-500/25',
  },
  {
    accent: 'text-cyan-700 dark:text-cyan-300',
    underline: 'border-cyan-500 dark:border-cyan-400',
    rail: 'border-l-cyan-500 dark:border-l-cyan-400',
    label: 'text-cyan-600 dark:text-cyan-400',
    badge: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
    focus: 'focus-within:border-cyan-400 focus-within:ring-2 focus-within:ring-cyan-500/25',
  },
  {
    accent: 'text-violet-700 dark:text-violet-300',
    underline: 'border-violet-500 dark:border-violet-400',
    rail: 'border-l-violet-500 dark:border-l-violet-400',
    label: 'text-violet-600 dark:text-violet-400',
    badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
    focus: 'focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-500/25',
  },
]

/**
 * `main` is the host loop, not one identity among many — it keeps the app's
 * neutral/default accent so the palette reads as "these are the inner loops".
 */
export const MAIN_LOOP_COLOR: LoopColor = {
  accent: 'text-neutral-800 dark:text-neutral-100',
  underline: 'border-[var(--adf-ui-accent)]',
  rail: 'border-l-neutral-300 dark:border-l-neutral-600',
  label: 'text-neutral-500 dark:text-neutral-400',
  badge: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400',
  focus: 'focus-within:border-[var(--adf-ui-accent)] focus-within:ring-2 focus-within:ring-[var(--adf-ui-focus)]',
}

/** FNV-1a (32-bit) — small, stable across sessions and processes. */
function hashName(name: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Deterministic identity colour for a loop name. `main` always gets neutral. */
export function loopColor(name: string): LoopColor {
  if (!name || name === MAIN_LOOP_NAME) return MAIN_LOOP_COLOR
  return LOOP_PALETTE[hashName(name) % LOOP_PALETTE.length]
}
