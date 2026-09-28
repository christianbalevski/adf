// Central key router. Ink calls every active `useInput` for every keypress
// with no propagation control, so the shell owns the ONE `useInput` and routes
// each key through layers in order until a handler returns true:
//
//   1. overlay  — the topmost open overlay only
//   2. zone     — the focused zone: input | sidebar | main (the active view)
//   3. view     — the active view's always-on keys (any zone except input)
//   4. global   — shell keys (view hotkeys, help, palette, quit, focus cycle)
//
// Components register with `useKeys(handler, { layer, active })`. A handler
// returns true when it consumed the key.

import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { DOMElement, Key } from 'ink'
import type { FocusZone } from '../state/types'
import type { MouseEvent } from './terminal'

export type { Key }
export type KeyHandler = (input: string, key: Key) => boolean | void

export type KeyLayer = 'overlay' | FocusZone | 'view' | 'global'

interface Binding {
  id: number
  layer: KeyLayer
  handler: { current: KeyHandler }
  active: { current: boolean }
}

export type WheelHandler = (delta: number, event: MouseEvent) => void

interface WheelBinding {
  layer: KeyLayer
  ref: RefObject<DOMElement | null>
  handler: { current: WheelHandler }
  active: { current: boolean }
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Absolute cell rectangle of a laid-out ink element (null before layout). */
export function elementRect(element: DOMElement | null | undefined): Rect | null {
  if (!element?.yogaNode) return null
  let x = 0
  let y = 0
  for (let node: DOMElement | undefined = element; node; node = node.parentNode) {
    if (!node.yogaNode) continue
    x += node.yogaNode.getComputedLeft()
    y += node.yogaNode.getComputedTop()
  }
  return { x, y, width: element.yogaNode.getComputedWidth(), height: element.yogaNode.getComputedHeight() }
}

export function rectContains(rect: Rect | null, x: number, y: number): boolean {
  return !!rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

export interface KeyRouter {
  register(layer: KeyLayer, handler: { current: KeyHandler }, active: { current: boolean }): () => void
  /** Route one keypress. Returns true when some handler consumed it. */
  dispatch(input: string, key: Key, context: { focus: FocusZone; overlayOpen: boolean }): boolean
  /** A scroll region under the pointer (see `useWheel`). */
  registerWheel(binding: WheelBinding): () => void
  /**
   * Route a wheel notch to the innermost active region under the pointer:
   * dialog regions while a dialog is open, else any region on screen
   * (hovered, not focused). Returns true when a region took it.
   */
  wheel(event: MouseEvent, context: { overlayOpen: boolean }): boolean
}

export function createKeyRouter(): KeyRouter {
  const bindings: Binding[] = []
  const wheels: WheelBinding[] = []
  let nextId = 1
  return {
    registerWheel(binding) {
      wheels.push(binding)
      return () => {
        const index = wheels.indexOf(binding)
        if (index >= 0) wheels.splice(index, 1)
      }
    },
    wheel(event, context) {
      let best: { binding: WheelBinding; area: number } | null = null
      for (const binding of wheels) {
        if (!binding.active.current) continue
        if ((binding.layer === 'overlay') !== context.overlayOpen) continue
        const rect = elementRect(binding.ref.current)
        if (!rect || !rectContains(rect, event.x, event.y)) continue
        const area = rect.width * rect.height
        // Innermost wins; on a tie the newest registration (later in the list).
        if (!best || area <= best.area) best = { binding, area }
      }
      if (!best || event.delta === 0) return !!best
      best.binding.handler.current(event.delta, event)
      return true
    },
    register(layer, handler, active) {
      const binding: Binding = { id: nextId++, layer, handler, active }
      bindings.push(binding)
      return () => {
        const index = bindings.indexOf(binding)
        if (index >= 0) bindings.splice(index, 1)
      }
    },
    dispatch(input, key, context) {
      const order: KeyLayer[] = context.overlayOpen
        ? ['overlay', 'global']
        : context.focus === 'input'
          ? ['input', 'global']
          : [context.focus, 'view', 'global']
      for (const layer of order) {
        // Newest registration first within a layer. Only the top overlay is
        // mounted, so the overlay layer never mixes two dialogs.
        const candidates = bindings.filter(b => b.layer === layer && b.active.current)
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (candidates[i].handler.current(input, key) === true) return true
        }
      }
      return false
    },
  }
}

const KeyRouterContext = createContext<KeyRouter | null>(null)

export function KeyRouterProvider({ router, children }: { router: KeyRouter; children?: ReactNode }) {
  return <KeyRouterContext.Provider value={router}>{children}</KeyRouterContext.Provider>
}

export function useKeyRouter(): KeyRouter {
  const router = useContext(KeyRouterContext)
  if (!router) throw new Error('useKeys must be used inside the TUI shell')
  return router
}

export interface UseKeysOptions {
  /** Which layer the handler lives in. Views normally use 'main' (their zone) or 'view'. */
  layer: KeyLayer
  /** Disable without unmounting (e.g. a list that is not the focused one). Default true. */
  active?: boolean
}

/** Register a key handler. Return true from the handler to consume the key. */
export function useKeys(handler: KeyHandler, options: UseKeysOptions): void {
  const router = useKeyRouter()
  const handlerRef = useRef(handler)
  const activeRef = useRef(options.active !== false)
  handlerRef.current = handler
  activeRef.current = options.active !== false
  useEffect(() => router.register(options.layer, handlerRef, activeRef), [router, options.layer])
}

export interface UseWheelOptions {
  /** 'overlay' for dialogs; anything else is a region of the main screen. */
  layer?: KeyLayer
  active?: boolean
}

/** Rows (or list items) one wheel notch moves. */
export const WHEEL_STEP = 3

/**
 * Scroll `ref`'s box with the mouse wheel. `onWheel(delta)` gets -1 (up,
 * towards the top / older) or +1 (down) per notch; move WHEEL_STEP rows.
 */
export function useWheel(ref: RefObject<DOMElement | null>, onWheel: WheelHandler, options: UseWheelOptions = {}): void {
  const router = useKeyRouter()
  const handler = useRef(onWheel)
  const active = useRef(options.active !== false)
  handler.current = onWheel
  active.current = options.active !== false
  const layer = options.layer ?? 'main'
  useEffect(() => router.registerWheel({ layer, ref, handler, active }), [router, layer, ref])
}

// --- key helpers ---------------------------------------------------------------

/**
 * Human label for a key spec, one notation everywhere: `ctrl+k` → `Ctrl+K`,
 * `alt+enter` → `Alt+Enter`, `shift+left` → `Shift+←`, `e` → `e`, `A` → `A`.
 */
export function keyLabel(spec: string): string {
  const parts = spec.split('+')
  const ctrl = parts.some(p => p.toLowerCase() === 'ctrl')
  return parts
    .map(part => {
      const p = part.toLowerCase()
      if (p === 'ctrl') return 'Ctrl+'
      if (p === 'alt' || p === 'meta') return 'Alt+'
      if (p === 'shift') return 'Shift+'
      if (p === 'enter' || p === 'return') return 'Enter'
      if (p === 'esc' || p === 'escape') return 'Esc'
      if (p === 'tab') return 'Tab'
      if (p === 'up') return '↑'
      if (p === 'down') return '↓'
      if (p === 'left') return '←'
      if (p === 'right') return '→'
      if (p === 'pgup' || p === 'pageup') return 'PgUp'
      if (p === 'pgdn' || p === 'pagedown') return 'PgDn'
      return part.length === 1 && ctrl ? part.toUpperCase() : part
    })
    .join('')
}

/** True when `key`/`input` match a spec like `ctrl+k`, `esc`, `enter`, `alt+2`, `?`. */
export function matchKey(spec: string, input: string, key: Key): boolean {
  const parts = spec.toLowerCase().split('+')
  const base = parts[parts.length - 1]
  const wantCtrl = parts.includes('ctrl')
  const wantMeta = parts.includes('alt') || parts.includes('meta')
  const wantShift = parts.includes('shift')
  if (wantCtrl !== key.ctrl) return false
  if (wantMeta !== key.meta) return false
  switch (base) {
    case 'esc':
    case 'escape': return key.escape
    case 'enter':
    case 'return': return key.return && (!wantShift || key.shift)
    case 'tab': return key.tab && wantShift === key.shift
    case 'up': return key.upArrow
    case 'down': return key.downArrow
    case 'left': return key.leftArrow
    case 'right': return key.rightArrow
    case 'pgup':
    case 'pageup': return key.pageUp
    case 'pgdn':
    case 'pagedown': return key.pageDown
    case 'home': return key.home
    case 'end': return key.end
    case 'backspace': return key.backspace
    case 'delete': return key.delete
    case 'space': return input === ' '
    default:
      return input.toLowerCase() === base && (base.length !== 1 || !/[a-z]/.test(base) || wantShift === key.shift || wantCtrl || wantMeta)
  }
}
