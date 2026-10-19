/**
 * Agent windows (docs/design/agent-windows.md): the relays in Studio main
 * that keep things from being lost between windows. Menu actions sent to a
 * page that is not listening yet wait until it takes them; an agent
 * window's queued messages are handed to the main window when it closes.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { deliverMenuAction, setMenuWindowResolver, takePendingMenuActions } from '../../src/main/menu'
import { QueueHandover } from '../../src/main/backend/queue-handover'
import { IPC } from '../../src/shared/constants/ipc-channels'

function fakeWindow(id: number) {
  const sent: string[] = []
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const webContents = {
    id,
    isDestroyed: () => false,
    send: (channel: string, action: string) => { if (channel === IPC.MENU_ACTION) sent.push(action) },
    on: (event: string, fn: (...args: unknown[]) => void) => { listeners.set(event, fn) },
    once: (event: string, fn: (...args: unknown[]) => void) => { listeners.set(event, fn) },
  }
  const win = { isDestroyed: () => false, webContents }
  return { win: win as unknown as Electron.BrowserWindow, webContents: webContents as unknown as Electron.WebContents, sent, emit: (event: string) => listeners.get(event)?.() }
}

describe('menu actions for a page that is not listening yet', () => {
  it('wait until the page takes them, then go straight to it; a reload waits again', () => {
    setMenuWindowResolver(() => null)
    const w = fakeWindow(41)
    deliverMenuAction(w.win, 'open-settings-at:providers')
    deliverMenuAction(w.win, 'new-file')
    expect(w.sent).toEqual([])
    expect(takePendingMenuActions(w.webContents)).toEqual(['open-settings-at:providers', 'new-file'])
    expect(takePendingMenuActions(w.webContents)).toEqual([])
    deliverMenuAction(w.win, 'save')
    expect(w.sent).toEqual(['save'])
    // A navigation main blocked in will-navigate starts but never commits: not a new page.
    w.emit('did-start-navigation')
    w.emit('did-navigate-in-page')
    deliverMenuAction(w.win, 'close-file')
    expect(w.sent).toEqual(['save', 'close-file'])
    // A reload commits.
    w.emit('did-navigate')
    deliverMenuAction(w.win, 'open-settings')
    expect(w.sent).toEqual(['save', 'close-file'])
    expect(takePendingMenuActions(w.webContents)).toEqual(['open-settings'])
  })
})

describe('queued messages of a closed agent window', () => {
  const entry = (filePath: string, text: string) => ({ filePath, loop: 'main', messages: [{ id: `m-${text}`, text }] })

  it('the last mirror of a closed window is handed over once', () => {
    const relay = new QueueHandover()
    relay.mirror(7, [entry('/agents/agent-1.adf', 'first')])
    relay.mirror(7, [entry('/agents/agent-1.adf', 'first'), entry('/agents/agent-1.adf', 'second')])
    relay.mirror(8, [entry('/agents/agent-2.adf', 'other')])
    expect(relay.closed(7)).toBe(true)
    expect(relay.take()).toEqual([entry('/agents/agent-1.adf', 'first'), entry('/agents/agent-1.adf', 'second')])
    expect(relay.take()).toEqual([])
    // Window 8 emptied its queue before it closed: nothing to hand over.
    relay.mirror(8, [])
    expect(relay.closed(8)).toBe(false)
  })

  it('waits for the main window (macOS without one) and ignores malformed entries', () => {
    const relay = new QueueHandover()
    relay.mirror(7, [entry('/agents/agent-1.adf', 'kept'), { filePath: '', loop: 'main', messages: [] }, 'nonsense'])
    relay.closed(7)
    relay.mirror(9, [entry('/agents/agent-2.adf', 'later')])
    relay.closed(9)
    expect(relay.waiting).toBe(2)
    expect(relay.take().map((e) => e.messages[0].text)).toEqual(['kept', 'later'])
  })
})
