/**
 * The browser Computer tab's noVNC client: one RFB per connection, "Match
 * tab size" applied to the live client, a 2 s reconnect after a drop, a fresh
 * client on reload, and nothing left behind on unmount.
 *
 * No jsdom here: the shared test host (support/host-render) renders the
 * component, so refs, ref cleanups and state updates run as they do in the
 * browser, against plain objects instead of DOM nodes.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeRFB, instances } = vi.hoisted(() => {
  const instances: InstanceType<typeof FakeRFB>[] = []
  class FakeRFB extends EventTarget {
    scaleViewport = false
    resizeSession = false
    background = ''
    disconnects = 0
    constructor(public target: unknown, public url: string, public options?: { wsProtocols?: string[] }) {
      super()
      instances.push(this)
    }
    disconnect() { this.disconnects++ }
  }
  return { FakeRFB, instances }
})
vi.mock('@novnc/novnc', () => ({ default: FakeRFB }))

import WebDesktopView from '../../../src/renderer/components/editor/WebDesktopView'
import { useAppStore } from '../../../src/renderer/stores/app.store'
import { mount as hostMount } from './support/host-render'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React
// act() flushes the renders the component's own timer and events schedule.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(element: React.ReactElement) {
  let view!: ReturnType<typeof hostMount>
  act(() => { view = hostMount(element) })
  return { text: view.text, render: (el: React.ReactElement) => act(() => view.rerender(el)), unmount: () => act(() => view.unmount()) }
}

// Only the component's timers are faked: React schedules its own work on setImmediate.
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
const drop = (rfb: { dispatchEvent(e: Event): boolean }) => act(() => { rfb.dispatchEvent(new Event('disconnect')) })

const URL = 'wss://studio.example/web/desktop/c1/websockify'
const live = () => instances[instances.length - 1]

beforeEach(() => {
  instances.length = 0
  useAppStore.setState({ computerMatchTab: false })
})
afterEach(() => { vi.useRealTimers() })

describe('WebDesktopView', () => {
  it('mounting creates one RFB for the url, binary subprotocol, scale and resize from the store', () => {
    useAppStore.setState({ computerMatchTab: true })
    const view = mount(<WebDesktopView url={URL} />)
    expect(instances).toHaveLength(1)
    expect(live().url).toBe(URL)
    expect(live().options).toEqual({ wsProtocols: ['binary'] })
    expect(live().scaleViewport).toBe(false)
    expect(live().resizeSession).toBe(true)
    view.unmount()
  })

  it('"Match tab size" updates the live RFB without a new one', () => {
    const view = mount(<WebDesktopView url={URL} />)
    expect(live().scaleViewport).toBe(true)
    expect(live().resizeSession).toBe(false)
    act(() => useAppStore.setState({ computerMatchTab: true }))
    expect(instances).toHaveLength(1)
    expect(live().scaleViewport).toBe(false)
    expect(live().resizeSession).toBe(true)
    act(() => useAppStore.setState({ computerMatchTab: false }))
    expect(instances).toHaveLength(1)
    expect(live().scaleViewport).toBe(true)
    expect(live().resizeSession).toBe(false)
    view.unmount()
  })

  it('a dropped stream reconnects after 2 s; the dead client is not told to disconnect', () => {
    fakeTimers()
    const view = mount(<WebDesktopView url={URL} />)
    const first = live()
    drop(first)
    advance(1999)
    expect(instances).toHaveLength(1)
    advance(1)
    expect(instances).toHaveLength(2)
    expect(first.disconnects).toBe(0)
    expect(live()).not.toBe(first)
    // The dead client no longer follows "Match tab size"; the live one does.
    act(() => useAppStore.setState({ computerMatchTab: true }))
    expect([first.scaleViewport, first.resizeSession]).toEqual([true, false])
    expect(live().resizeSession).toBe(true)
    view.unmount()
  })

  it('a reload disconnects the old RFB and creates a new one', () => {
    const view = mount(<WebDesktopView url={URL} reloadNonce={1} />)
    const first = live()
    view.render(<WebDesktopView url={URL} reloadNonce={2} />)
    expect(first.disconnects).toBe(1)
    expect(instances).toHaveLength(2)
    expect(live().disconnects).toBe(0)
    view.unmount()
  })

  it('a reloaded display waits for its new client and ignores late events from the old one', () => {
    fakeTimers()
    const view = mount(<WebDesktopView url={URL} reloadNonce={1} />)
    const first = live()
    act(() => first.dispatchEvent(new Event('connect')))
    expect(view.text()).toBe('')
    view.render(<WebDesktopView url={URL} reloadNonce={2} />)
    expect(view.text()).toBe('Connecting to the display…')
    act(() => live().dispatchEvent(new Event('connect')))
    drop(first)
    advance(2000)
    expect(view.text()).toBe('')
    expect(instances).toHaveLength(2)
    view.unmount()
  })

  it('an unrelated re-render keeps the same RFB', () => {
    const view = mount(<WebDesktopView url={URL} reloadNonce={1} />)
    view.render(<WebDesktopView url={URL} reloadNonce={1} />)
    expect(instances).toHaveLength(1)
    expect(live().disconnects).toBe(0)
    view.unmount()
  })

  it('unmounting disconnects the live RFB, and a pending retry never fires', () => {
    fakeTimers()
    const view = mount(<WebDesktopView url={URL} />)
    view.unmount()
    expect(instances).toHaveLength(1)
    expect(live().disconnects).toBe(1)

    const again = mount(<WebDesktopView url={URL} />)
    drop(live())
    again.unmount()
    expect(live().disconnects).toBe(0)
    advance(5000)
    expect(instances).toHaveLength(2)
  })
})
