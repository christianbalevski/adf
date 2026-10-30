import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWebViewport } from '../../src/web/viewport'
import { isCompactWebLayout } from '../../src/renderer/hooks/useCompactWebLayout'

function browser(compact = true, visual = true) {
  const properties = new Map<string, string>()
  const root = { dataset: {} as Record<string, string>, style: {
    setProperty: (name: string, value: string) => properties.set(name, value),
    removeProperty: (name: string) => properties.delete(name),
  } }
  const media = Object.assign(new EventTarget(), { matches: compact })
  const viewport = Object.assign(new EventTarget(), { height: 780, offsetTop: 0, scale: 1 })
  let pending: FrameRequestCallback | undefined
  const win = Object.assign(new EventTarget(), {
    document: { documentElement: root }, innerHeight: 800,
    matchMedia: () => media, visualViewport: visual ? viewport : null,
    requestAnimationFrame: (callback: FrameRequestCallback) => { pending = callback; return 1 },
    cancelAnimationFrame: () => { pending = undefined },
  })
  return { win: win as unknown as Window, media, viewport, root, properties, flush: () => { const callback = pending; pending = undefined; callback?.(0) } }
}

afterEach(() => vi.unstubAllGlobals())

describe('compact browser viewport', () => {
  it('follows the keyboard visible height and pan, and restores on dismiss', () => {
    const b = browser()
    const stop = installWebViewport(b.win)
    b.viewport.height = 350
    b.viewport.offsetTop = 48
    b.viewport.dispatchEvent(new Event('resize'))
    b.viewport.dispatchEvent(new Event('scroll'))
    b.flush()
    expect(b.properties.get('--web-viewport-height')).toBe('350px')
    expect(b.properties.get('--web-viewport-top')).toBe('48px')
    b.viewport.height = 780
    b.viewport.offsetTop = 0
    b.viewport.dispatchEvent(new Event('resize'))
    b.flush()
    expect(b.properties.get('--web-viewport-height')).toBe('780px')
    expect(b.properties.get('--web-viewport-top')).toBe('0px')
    stop()
    b.viewport.dispatchEvent(new Event('resize'))
    b.flush()
    expect(b.properties.size).toBe(0)
    expect(b.root.dataset.compactWeb).toBeUndefined()
  })

  it('does not resize or reposition the app to counteract pinch zoom', () => {
    const b = browser()
    const stop = installWebViewport(b.win)
    b.viewport.scale = 2
    b.viewport.height = 390
    b.viewport.offsetTop = 120
    b.viewport.dispatchEvent(new Event('resize'))
    b.flush()
    expect(b.properties.get('--web-viewport-height')).toBe('780px')
    expect(b.properties.get('--web-viewport-top')).toBe('0px')
    stop()
  })

  it('leaves desktop alone and removes compact sizing after crossing the breakpoint', () => {
    const b = browser(false)
    const stop = installWebViewport(b.win)
    expect(b.properties.size).toBe(0)
    expect(b.root.dataset.compactWeb).toBeUndefined()
    b.media.matches = true
    b.media.dispatchEvent(new Event('change'))
    b.flush()
    expect(b.root.dataset.compactWeb).toBe('')
    b.media.matches = false
    b.media.dispatchEvent(new Event('change'))
    b.flush()
    expect(b.root.dataset.compactWeb).toBeUndefined()
    expect(b.properties.size).toBe(0)
    stop()
  })

  it('falls back to window height when the visual viewport API is absent', () => {
    const b = browser(true, false)
    const stop = installWebViewport(b.win)
    expect(b.properties.get('--web-viewport-height')).toBe('800px')
    stop()
  })

  it('never opts Electron into mobile layout even on a narrow touch display', () => {
    const b = browser()
    vi.stubGlobal('window', Object.assign(b.win, { adfApi: { platform: 'darwin' } }))
    expect(isCompactWebLayout()).toBe(false)
    Object.assign(b.win, { adfApi: { platform: 'web' } })
    expect(isCompactWebLayout()).toBe(true)
    b.media.matches = false
    expect(isCompactWebLayout()).toBe(false)
  })
})
