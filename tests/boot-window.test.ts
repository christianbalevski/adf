import { describe, expect, it, vi } from 'vitest'

/** A BrowserWindow stand-in: records close, fires 'closed'. */
const { FakeWindow, windows } = vi.hoisted(() => {
  const windows: Array<{ closed: boolean }> = []
  class FakeWindow {
    closed = false
    private listeners: Array<() => void> = []
    constructor() { windows.push(this) }
    on(event: string, fn: () => void) { if (event === 'closed') this.listeners.push(fn); return this }
    loadURL() { return Promise.resolve() }
    show() {}
    focus() {}
    isDestroyed() { return this.closed }
    close() { this.closed = true; for (const fn of this.listeners) fn() }
  }
  return { FakeWindow, windows }
})
type FakeWindow = InstanceType<typeof FakeWindow>

vi.mock('electron', () => ({ app: { focus: () => {} }, dialog: {}, BrowserWindow: FakeWindow, nativeTheme: { shouldUseDarkColors: false } }))

import { closeBootWindow, showBootWindow } from '../src/main/utils/boot-window'

describe('boot window (characterization)', () => {
  it('closeBootWindow closes the open boot window at once', () => {
    const win = showBootWindow('Reading the keychain.') as unknown as FakeWindow
    expect(win.closed).toBe(false)
    closeBootWindow()
    expect(win.closed).toBe(true)
  })

  it('showBootWindow reuses the open window; closeBootWindow without one does nothing', () => {
    const before = windows.length
    const a = showBootWindow('one')
    const b = showBootWindow('two')
    expect(a).toBe(b)
    expect(windows.length).toBe(before + 1)
    closeBootWindow()
    expect(() => closeBootWindow()).not.toThrow()
  })
})
