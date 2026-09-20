import { useRef } from 'react'

/**
 * Stable React keys for editable list rows.
 *
 * Every field these rows expose (id, name, path, origin, the bare lambda
 * string) is rewritten on each keystroke, so nothing inside an item works as a
 * key: keying on it remounts the row and steals focus on every character.
 * Keying on the array index is worse — removing row N hands row N+1's DOM
 * node, focus, uncontrolled `defaultValue` and local `useState` to a different
 * item.
 *
 * Keys therefore live beside the list, never inside the config objects: the
 * items handed to `sync` are only read, so the object written to SQLite and
 * sent over IPC keeps exactly the fields it had.
 */

export type RowKey = string

/** Keys for the current items, plus the hooks the mutation sites call. */
export interface RowKeys {
  keys: RowKey[]
  /** Row `index` is being deleted — drop its key, keep every other one. */
  removeAt(index: number): void
  /** A row is being inserted at `index` — mint a key for it. */
  insertAt(index: number): void
  /** A row is being appended — mint a key for it. */
  append(): void
  /** A row moved — carry its key along. */
  move(from: number, to: number): void
}

const EMPTY: readonly unknown[] = []

/** Stands in for a not-yet-rendered inserted row inside the tracked snapshot. */
const PENDING = Object.freeze({ __rowKeysPending: true })

/** Structural equality over the JSON-shaped values these lists hold. */
export function rowsEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    return x.length === y.length && x.every((v, i) => rowsEqual(v, y[i]))
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const xk = Object.keys(x)
  if (xk.length !== Object.keys(y).length) return false
  return xk.every((k) => Object.prototype.hasOwnProperty.call(y, k) && rowsEqual(x[k], y[k]))
}

/**
 * Carry keys across a list the component did not mutate itself — a config
 * echoed back from main after the debounced save, a `sys_update_config` write,
 * an agent switch.
 *
 * Same length means an in-place edit (or an echo of what we already have):
 * every key stays put, which is the whole point — a row whose text changed
 * must never get a new key. A different length is a real insert or removal
 * from outside, so the longest matching prefix and suffix keep their keys and
 * only the rows in between are minted fresh.
 */
export function alignRowKeys(
  prevKeys: readonly RowKey[],
  prevItems: readonly unknown[],
  nextItems: readonly unknown[],
  mint: () => RowKey
): RowKey[] {
  if (prevKeys.length === nextItems.length) return prevKeys.slice()

  const n = Math.min(prevKeys.length, prevItems.length)
  let prefix = 0
  while (prefix < n && prefix < nextItems.length && rowsEqual(prevItems[prefix], nextItems[prefix])) prefix++
  let suffix = 0
  while (
    suffix < n - prefix &&
    suffix < nextItems.length - prefix &&
    rowsEqual(prevItems[n - 1 - suffix], nextItems[nextItems.length - 1 - suffix])
  ) suffix++

  const keys: RowKey[] = []
  for (let i = 0; i < prefix; i++) keys.push(prevKeys[i])
  for (let i = prefix; i < nextItems.length - suffix; i++) keys.push(mint())
  for (let i = n - suffix; i < n; i++) keys.push(prevKeys[i])
  return keys
}

interface Track {
  owner: unknown
  items: readonly unknown[]
  keys: RowKey[]
  seq: number
}

/** Keys are never recycled, so a reset can't collide with a live row. */
function mint(track: Track): RowKey {
  return `row-${track.seq++}`
}

function syncTrack(track: Track, items: readonly unknown[], owner: unknown): void {
  if (!Object.is(track.owner, owner)) {
    // Another agent/file owns the list now — nothing carries over.
    track.owner = owner
    track.keys = items.map(() => mint(track))
    track.items = items
    return
  }
  if (track.items === items && track.keys.length === items.length) return
  track.keys = alignRowKeys(track.keys, track.items, items, () => mint(track))
  track.items = items
}

/**
 * The helpers run from the click that also calls `save`, i.e. before the
 * re-render: they keep the tracked snapshot the same length as the keys, so
 * the render that follows lands on the same-length fast path above.
 */
function trackApi(track: Track): RowKeys {
  const removeAt = (index: number) => {
    if (index < 0 || index >= track.keys.length) return
    track.keys = track.keys.filter((_, i) => i !== index)
    track.items = track.items.filter((_, i) => i !== index)
  }
  const insertAt = (index: number) => {
    const at = Math.max(0, Math.min(index, track.keys.length))
    track.keys = [...track.keys.slice(0, at), mint(track), ...track.keys.slice(at)]
    track.items = [...track.items.slice(0, at), PENDING, ...track.items.slice(at)]
  }
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || from >= track.keys.length) return
    const at = Math.max(0, Math.min(to, track.keys.length - 1))
    const keys = track.keys.slice()
    const items = track.items.slice()
    keys.splice(at, 0, ...keys.splice(from, 1))
    items.splice(at, 0, ...items.splice(from, 1))
    track.keys = keys
    track.items = items
  }
  return {
    keys: track.keys,
    removeAt,
    insertAt,
    append: () => insertAt(track.keys.length),
    move
  }
}

/** Hook-free core, so the alignment can be tested without a DOM. */
export interface RowKeyStore {
  sync(items: readonly unknown[] | undefined, owner?: unknown): RowKeys
}

export function createRowKeyStore(): RowKeyStore {
  const track: Track = { owner: undefined, items: EMPTY, keys: [], seq: 0 }
  let started = false
  return {
    sync(items, owner) {
      const list = items ?? EMPTY
      if (!started) {
        started = true
        track.owner = owner
        track.items = list
        track.keys = list.map(() => mint(track))
      } else {
        syncTrack(track, list, owner)
      }
      return trackApi(track)
    }
  }
}

/** Stable keys for one editable list. `owner` resets them (agent/file switch). */
export function useRowKeys(items: readonly unknown[] | undefined, owner?: unknown): RowKeys {
  const store = useRef<RowKeyStore | null>(null)
  if (store.current === null) store.current = createRowKeyStore()
  return store.current.sync(items, owner)
}

/**
 * Same thing for lists nested inside a row (a route's middleware), where the
 * number of lists is only known while rendering and a hook per list is not an
 * option. Ids are caller-chosen and must be stable — the parent row's key is.
 */
export interface RowKeysGroup {
  for(id: string, items: readonly unknown[] | undefined): RowKeys
}

interface GroupState {
  owner: unknown
  stores: Map<string, RowKeyStore>
  seen: Set<string>
}

export function useRowKeysGroup(owner?: unknown): RowKeysGroup {
  const ref = useRef<GroupState | null>(null)
  if (ref.current === null) ref.current = { owner, stores: new Map(), seen: new Set() }
  const group = ref.current
  // Drop lists the previous render never asked for — their parent row is gone.
  for (const id of [...group.stores.keys()]) if (!group.seen.has(id)) group.stores.delete(id)
  group.seen = new Set()
  return {
    for(id, items) {
      group.seen.add(id)
      let store = group.stores.get(id)
      if (!store) {
        store = createRowKeyStore()
        group.stores.set(id, store)
      }
      return store.sync(items, owner)
    }
  }
}
