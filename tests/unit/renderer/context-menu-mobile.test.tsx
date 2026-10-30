import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  compact: true,
  effects: [] as (() => void | (() => void))[],
  menu: null as { current: unknown } | null,
}))
vi.mock('../../../src/renderer/hooks/useCompactWebLayout', () => ({ useCompactWebLayout: () => harness.compact }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect) } }))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (children: unknown) => children }))
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
    if (props.role === 'menu') harness.menu = props.ref as typeof harness.menu
    return (actual.jsxDEV as (...args: unknown[]) => unknown)(type, props, ...rest)
  } }
})
import { ContextMenu } from '../../../src/renderer/components/common/ContextMenu'

beforeEach(() => { harness.compact = true; harness.effects = []; harness.menu = null })
afterEach(() => vi.unstubAllGlobals())

describe('touch menu scrolling', () => {
  function mount(compact: boolean) {
    harness.compact = compact
    const listeners = new Map<string, (event: unknown) => void>()
    const onClose = vi.fn()
    class FakeNode {}
    const scroller = new FakeNode()
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('React', React)
    vi.stubGlobal('window', {
      innerWidth: 375, innerHeight: 667,
      addEventListener: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener),
      removeEventListener: (event: string) => listeners.delete(event),
    })
    vi.stubGlobal('document', { body: {}, addEventListener() {}, removeEventListener() {} })
    renderToStaticMarkup(<ContextMenu position={{ x: 300, y: 600 }} onClose={onClose} items={[{ label: 'Tasks', onSelect() {} }]} />)
    harness.menu!.current = { contains: (target: unknown) => target === scroller }
    const cleanups = harness.effects.map(effect => effect())
    return { listeners, onClose, scroller, outside: new FakeNode(), cleanup: () => cleanups.forEach(cleanup => cleanup?.()) }
  }

  it('allows scrolling inside the compact menu, dismisses on outside scroll, and removes listeners', () => {
    const menu = mount(true)
    menu.listeners.get('scroll')!({ target: menu.scroller })
    expect(menu.onClose).not.toHaveBeenCalled()
    menu.listeners.get('scroll')!({ target: menu.outside })
    expect(menu.onClose).toHaveBeenCalledOnce()
    menu.cleanup()
    expect(menu.listeners.size).toBe(0)
  })

  it('preserves desktop dismissal on every scroll', () => {
    const menu = mount(false)
    menu.listeners.get('scroll')!({ target: menu.scroller })
    expect(menu.onClose).toHaveBeenCalledOnce()
    menu.cleanup()
  })
})
