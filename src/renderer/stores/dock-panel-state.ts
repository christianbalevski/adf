import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useDocumentStore } from './document.store'

/**
 * What a dock panel was showing, per agent and panel, for this session. The
 * dock mounts only the active panel (a dozen mounted panels would keep
 * re-rendering and refetching off screen), so a tab switch unmounts the rest;
 * this map is what brings their filter, collapsed folders and scroll position
 * back. Session only: nothing here is worth keeping across restarts, and it
 * is not shared between windows.
 */
const memory = new Map<string, unknown>()

/** Oldest entries go first past this many; one agent uses well under twenty. */
const MAX_ENTRIES = 500

export function dockStateKey(filePath: string | null, panel: string, field: string): string {
  return `${filePath ?? ''}\u0000${panel}\u0000${field}`
}

export function readDockState<T>(key: string, fallback: T): T {
  return memory.has(key) ? (memory.get(key) as T) : fallback
}

export function writeDockState(key: string, value: unknown): void {
  memory.delete(key)
  memory.set(key, value)
  if (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value
    if (oldest !== undefined) memory.delete(oldest)
  }
}

/** Test hook. */
export function clearDockState(): void {
  memory.clear()
}

/**
 * useState that survives the panel unmounting, keyed by the open agent: a
 * different agent gets its own value (or `initial`), and coming back to this
 * one restores what it was.
 */
export function useDockPanelState<T>(panel: string, field: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const filePath = useDocumentStore((s) => s.filePath)
  const key = dockStateKey(filePath, panel, field)
  const initialRef = useRef(initial)
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: readDockState(key, initial) }))
  // The agent changed under a mounted panel: show that agent's value now.
  const current = state.key === key ? state.value : readDockState(key, initialRef.current)
  if (state.key !== key) setState({ key, value: current })

  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setState((prev) => {
      const base = prev.key === key ? prev.value : readDockState(key, initialRef.current)
      const value = typeof next === 'function' ? (next as (p: T) => T)(base) : next
      writeDockState(key, value)
      return { key, value }
    })
  }, [key])

  return [current, set]
}

/**
 * Where a scroll happened inside a dock panel: the child-index path from the
 * panel's container to the element that scrolled. Scroll containers sit near
 * the top of each panel, so the path is short and stable across re-renders.
 */
export function elementPath(root: Element, target: Element): number[] | null {
  const path: number[] = []
  let node: Element | null = target
  while (node && node !== root) {
    const parent: Element | null = node.parentElement
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.children, node))
    node = parent
  }
  return node === root ? path : null
}

export function elementAtPath(root: Element, path: readonly number[]): Element | null {
  let node: Element | null = root
  for (const index of path) {
    node = node?.children[index] ?? null
    if (!node) return null
  }
  return node
}

export interface DockScroll {
  path: number[]
  top: number
}
