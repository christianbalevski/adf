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

import type { BrowserWindow, MessageBoxReturnValue } from 'electron'
import { closeBootWindow, holdBootWindow, showBootWindow } from '../src/main/utils/boot-window'
import { showWindowlessMessageBox } from '../src/main/utils/windowless-dialog'

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

describe('boot window under a dialog (review 4300792043)', () => {
  it('the main window becoming ready does not close the boot window while its dialog is open; the answer does', async () => {
    let answer!: (r: MessageBoxReturnValue) => void
    let parent: BrowserWindow | null = null
    const pending = showWindowlessMessageBox('daemon version differs', { message: 'ADF daemon version', buttons: ['Restart', 'Inside Studio'] }, {
      log: () => {},
      flushLog: () => {},
      parent: (status) => showBootWindow(status),
      hold: () => holdBootWindow(),
      show: (p) => { parent = p; return new Promise((r) => { answer = r }) },
    })
    while (!answer) await new Promise((r) => setTimeout(r, 0))
    const win = parent as unknown as FakeWindow
    // ready-to-show on the main window
    closeBootWindow()
    expect(win.closed).toBe(false)
    answer({ response: 0, checkboxChecked: false })
    expect((await pending).response).toBe(0)
    expect(win.closed).toBe(true)
  })
})
