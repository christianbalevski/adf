import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateCompactOverlay } from '../../../src/renderer/components/layout/compact-overlay-focus'

// Minimal DOM seam: exercise keyboard/focus ownership without a browser dependency.
class Element {
  inert = false
  hidden = false
  isConnected = true
  children: Element[] = []
  parent: Element | null = null
  surface = false
  focus = vi.fn(() => { page.activeElement = this })
  append(child: Element) { child.parent = this; this.children.push(child); return child }
  contains(target: Element): boolean { return target === this || this.children.some(child => child.contains(target)) }
  closest(selector: string): Element | null {
    const match = selector.startsWith('[inert]') ? this.inert || (selector.includes('[hidden]') && this.hidden) : this.surface
    return match ? this : this.parent?.closest(selector) ?? null
  }
  querySelectorAll() { return this.children }
  getClientRects() { return this.hidden ? [] : [{}] }
}
const listeners = new Map<string, (event: any) => void>()
let page: { activeElement: Element | null; body: { children: Element[] }; addEventListener: typeof vi.fn; removeEventListener: typeof vi.fn }
const element = (value: Element) => value as unknown as HTMLElement
function key(target: Element, key: string, shiftKey = false) {
  const event = { target, key, shiftKey, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  listeners.get('keydown')?.(event)
  return event
}
function setup() {
  const background = new Element()
  const trigger = background.append(new Element())
  const root = new Element(); root.surface = true
  const first = root.append(new Element())
  const last = root.append(new Element())
  page.body.children = [background, root]
  page.activeElement = trigger
  const close = vi.fn()
  const cleanup = activateCompactOverlay(element(root), element(first), close)
  return { background, trigger, root, first, last, close, cleanup }
}
beforeEach(() => {
  listeners.clear()
  page = { activeElement: null, body: { children: [] }, addEventListener: vi.fn((name, fn) => listeners.set(name, fn)), removeEventListener: vi.fn(name => listeners.delete(name)) }
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('document', page)
})
afterEach(() => vi.unstubAllGlobals())

describe('compact navigation focus', () => {
  it('blocks the background and restores the triggering control after closing', () => {
    const h = setup()
    expect(h.background.inert).toBe(true)
    expect(page.activeElement).toBe(h.first)
    key(h.first, 'Escape')
    expect(h.close).toHaveBeenCalledOnce()
    h.cleanup()
    expect(h.background.inert).toBe(false)
    expect(page.activeElement).toBe(h.trigger)
    expect(listeners.size).toBe(0)
  })
  it('wraps forward and backward keyboard traversal inside navigation', () => {
    const h = setup()
    h.last.focus()
    expect(key(h.last, 'Tab').preventDefault).toHaveBeenCalledOnce()
    expect(page.activeElement).toBe(h.first)
    key(h.first, 'Tab', true)
    expect(page.activeElement).toBe(h.last)
    h.cleanup()
  })
  it('allows nested menu/modal focus and Escape without dismissing navigation', () => {
    const h = setup()
    const menu = new Element(); menu.surface = true
    const item = menu.append(new Element())
    item.focus()
    listeners.get('focusin')?.({ target: item })
    expect(page.activeElement).toBe(item)
    key(item, 'Escape')
    expect(h.close).not.toHaveBeenCalled()
    const outside = new Element(); outside.focus()
    listeners.get('focusin')?.({ target: outside })
    expect(page.activeElement).toBe(h.first)
    h.cleanup()
  })
  it('preserves existing inert state and does not re-inert a hidden overlay opened during cleanup', () => {
    const background = new Element(); background.inert = true
    const hidden = new Element(); hidden.inert = true; hidden.hidden = true
    const root = new Element(); root.surface = true
    const first = root.append(new Element())
    page.body.children = [background, hidden, root]
    const cleanup = activateCompactOverlay(element(root), element(first), vi.fn())
    hidden.hidden = false; hidden.inert = false // React opens the next overlay.
    cleanup()
    expect(hidden.inert).toBe(false)
    expect(background.inert).toBe(true)
  })
  it('leaves keyboard ownership to a nested overlay while this one is inert', () => {
    const h = setup()
    h.root.inert = true
    key(h.first, 'Escape')
    expect(h.close).not.toHaveBeenCalled()
    h.cleanup()
  })
})
