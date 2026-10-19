/**
 * Settings lists more than one window edits (agent windows,
 * docs/design/agent-windows.md): providers, MCP servers, channel adapters.
 * A window writes the whole list, so its edit is applied onto the list
 * stored now instead of replacing it.
 */

/**
 * This window's edit of a list keyed by `id`, applied to `latest` (what is
 * stored now). `saved` is what this window last loaded or wrote; `attempted`
 * is what it shows now. Entries it changed or added since `saved` take its
 * version, entries it removed go, every other entry is the stored one (an
 * entry another window added stays, one another window removed stays gone).
 * Stored order first, this window's additions after.
 */
export function rebaseById<T extends { id: string }>(saved: readonly T[], attempted: readonly T[], latest: readonly T[]): T[] {
  const before = new Map(saved.map((e) => [e.id, JSON.stringify(e)]))
  const mine = new Map(attempted.map((e) => [e.id, e]))
  const changed = (id: string): boolean => {
    const e = mine.get(id)
    return !!e && before.get(id) !== JSON.stringify(e)
  }
  const out = latest
    .filter((e) => !(before.has(e.id) && !mine.has(e.id)))
    .map((e) => (changed(e.id) ? mine.get(e.id)! : e))
  for (const e of attempted) {
    if (!out.some((o) => o.id === e.id) && (changed(e.id) || !before.has(e.id))) out.push(e)
  }
  return out
}

/** A value only this window may have moved: its own when it moved it since `saved`, else the stored one. */
export function rebaseValue<T>(saved: T, attempted: T, latest: T): T {
  return JSON.stringify(saved) !== JSON.stringify(attempted) ? attempted : latest
}

/** Same content (for "did the rebase change anything"). */
export function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
