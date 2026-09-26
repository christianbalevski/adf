import { describe, expect, it, vi } from 'vitest'
import { showOrCreateMainWindow, type ShowableWindow } from '../../../src/main/utils/main-window'

function fakeWindow(state: Partial<{ destroyed: boolean; minimized: boolean; visible: boolean; loading: boolean }> = {}) {
  const s = { destroyed: false, minimized: false, visible: true, loading: false, ...state }
  const win = {
    isDestroyed: () => s.destroyed,
    isMinimized: () => s.minimized,
    restore: vi.fn(() => { s.minimized = false }),
    isVisible: () => s.visible,
    show: vi.fn(() => { s.visible = true }),
    focus: vi.fn(),
    webContents: { isLoading: () => s.loading },
  } satisfies ShowableWindow
  return win
}

describe('showOrCreateMainWindow', () => {
  it('does nothing before startup completes or once shutdown begins', () => {
    const create = vi.fn(() => fakeWindow())
    expect(showOrCreateMainWindow({ current: () => null, create, canShow: () => false })).toBeNull()
    expect(create).not.toHaveBeenCalled()

    // The gate also covers an existing window: no restore/focus while quitting.
    const existing = fakeWindow({ minimized: true })
    expect(showOrCreateMainWindow({ current: () => existing, create, canShow: () => false })).toBeNull()
    expect(existing.restore).not.toHaveBeenCalled()
  })

  it('creates a window when there is none, and returns it', () => {
    const created = fakeWindow()
    const create = vi.fn(() => created)
    expect(showOrCreateMainWindow({ current: () => null, create, canShow: () => true })).toBe(created)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('replaces a destroyed window instead of calling into it', () => {
    const destroyed = fakeWindow({ destroyed: true })
    const created = fakeWindow()
    const result = showOrCreateMainWindow({ current: () => destroyed, create: () => created, canShow: () => true })
    expect(result).toBe(created)
    expect(destroyed.focus).not.toHaveBeenCalled()
  })

  it('restores, shows and focuses an existing window', () => {
    const win = fakeWindow({ minimized: true, visible: false })
    const create = vi.fn(() => fakeWindow())
    expect(showOrCreateMainWindow({ current: () => win, create, canShow: () => true })).toBe(win)
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('leaves a still-loading window to its ready-to-show handler', () => {
    const win = fakeWindow({ visible: false, loading: true })
    showOrCreateMainWindow({ current: () => win, create: () => fakeWindow(), canShow: () => true })
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })
})
