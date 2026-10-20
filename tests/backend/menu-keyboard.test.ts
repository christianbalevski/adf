/**
 * Keyboard navigation in the application menu (menu.ts): View's Home, fleet
 * map, sidebar and panel items; Go to Agent; File's Close Tab (shown, not
 * registered) and Open in New Window (daemon mode only); Window's role; Help's
 * Keyboard Shortcuts; each item's action; and which window each acts on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { actsOnFocusedWindow, initApplicationMenu } from '../../src/main/menu'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { ACCELERATORS, SHORTCUT_SECTIONS } from '../../src/shared/constants/keyboard-shortcuts'

interface Item { label?: string; role?: string; type?: string; accelerator?: string; registerAccelerator?: boolean; click?: () => void; submenu?: Item[] }

const settings = { get: () => undefined, set: () => {} }
const daemon = { logFile: () => null, problem: () => null, canReconnect: () => false, openLog: () => {}, reconnect: () => {} }

function menu(): Item[] {
  const last = [...electronStub.calls].reverse().find((c) => c.api === 'Menu.setApplicationMenu')
  return (last?.args[0] ?? []) as Item[]
}
const top = (label: string) => menu().find((m) => m.label === label || m.role === label)
const item = (menuLabel: string, label: string) => top(menuLabel)?.submenu?.find((i) => i.label === label)

/** Every accelerator in the menu, depth first. */
function accelerators(items: Item[]): string[] {
  return items.flatMap((i) => [...(i.accelerator ? [i.accelerator] : []), ...accelerators(i.submenu ?? [])])
}

beforeEach(() => { electronStub.calls.length = 0; electronStub.pushes.length = 0 })

describe('application menu keyboard items', () => {
  it('View: Go to Agent, Home, Mesh, Toggle Sidebar, Toggle Panel with their accelerators', () => {
    initApplicationMenu(settings)
    const labels = (top('View')?.submenu ?? []).map((i) => i.label ?? i.role ?? `<${i.type}>`)
    expect(labels.slice(0, 8)).toEqual(['Go to Agent…', '<separator>', 'Home', 'Mesh', '<separator>', 'Toggle Sidebar', 'Toggle Panel', '<separator>'])
    expect(item('View', 'Go to Agent…')?.accelerator).toBe(ACCELERATORS.goToAgent)
    expect(item('View', 'Home')?.accelerator).toBe(ACCELERATORS.home)
    expect(item('View', 'Mesh')?.accelerator).toBe(ACCELERATORS.fleetMap)
    expect(item('View', 'Toggle Sidebar')?.accelerator).toBe(ACCELERATORS.toggleSidebar)
    expect(item('View', 'Toggle Panel')?.accelerator).toBe(ACCELERATORS.togglePanel)
  })

  it('no two items share an accelerator', () => {
    initApplicationMenu(settings, daemon)
    const all = accelerators(menu())
    expect(new Set(all).size).toBe(all.length)
  })

  it('File: Close Tab shows Cmd/Ctrl+W without registering it (the page handles the key)', () => {
    initApplicationMenu(settings)
    const close = item('File', 'Close Tab')
    expect(close).toMatchObject({ accelerator: 'CmdOrCtrl+W', registerAccelerator: false })
    expect(item('File', 'Close Agent')?.accelerator).toBe('CmdOrCtrl+Shift+W')
  })

  it('File: Open in New Window in daemon mode only', () => {
    initApplicationMenu(settings)
    expect(item('File', 'Open in New Window')).toBeUndefined()
    initApplicationMenu(settings, daemon)
    expect(item('File', 'Open in New Window')?.accelerator).toBe('CmdOrCtrl+Shift+N')
  })

  it('Window has role window (macOS lists the windows); Help starts with Keyboard Shortcuts', () => {
    initApplicationMenu(settings)
    expect(top('Window')?.role).toBe('window')
    expect((top('help')?.submenu ?? []).map((i) => i.label)).toEqual(['Keyboard Shortcuts', 'ADF Studio Documentation'])
  })

  it('each item sends its action to the page', () => {
    initApplicationMenu(settings, daemon)
    const clicks: Array<[string, string]> = [
      ['View', 'Go to Agent…'], ['View', 'Home'], ['View', 'Mesh'], ['View', 'Toggle Sidebar'], ['View', 'Toggle Panel'],
      ['File', 'Close Tab'], ['File', 'Open in New Window'], ['help', 'Keyboard Shortcuts'],
    ]
    for (const [m, label] of clicks) item(m, label)!.click!()
    expect(electronStub.pushes.filter((p) => p.channel === IPC.MENU_ACTION).map((p) => p.args[0])).toEqual([
      'go-to-agent', 'go-home', 'show-fleet-map', 'toggle-sidebar', 'toggle-panel', 'close-tab', 'open-in-new-window', 'show-shortcuts',
    ])
  })

  it('actions for the window in front, and for the main window', () => {
    for (const a of ['save', 'close-tab', 'toggle-sidebar', 'toggle-panel', 'go-to-agent', 'open-in-new-window', 'show-shortcuts']) {
      expect(actsOnFocusedWindow(a), a).toBe(true)
    }
    for (const a of ['go-home', 'show-fleet-map', 'new-file', 'open-file', 'add-directory', 'open-settings', 'close-file']) {
      expect(actsOnFocusedWindow(a), a).toBe(false)
    }
  })

  it('the shortcuts sheet lists every accelerator the menu binds', () => {
    const listed = new Set(SHORTCUT_SECTIONS.flatMap((s) => s.rows.flatMap((r) => r.keys)))
    for (const [name, acc] of Object.entries(ACCELERATORS)) expect(listed.has(acc), name).toBe(true)
  })
})
