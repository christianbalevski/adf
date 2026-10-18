/**
 * Rule G2 (harness/normalize.ts): the macOS application menu, put in its
 * Windows and Linux form, is exactly what menu.ts builds on Windows and
 * Linux. Built here by the real menu.ts under each platform value.
 */
import { describe, expect, it, vi } from 'vitest'

const built: unknown[] = []
vi.mock('electron', () => ({
  app: { name: 'ADF Studio' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: (menu: unknown) => { built.push(menu) } },
  shell: { openExternal: async () => {} },
}))

import { buildApplicationMenu, initApplicationMenu } from '../../src/main/menu'
import { DARWIN_APP_SUBMENU, darwinMenuInOtherForm } from './harness/normalize'

type Item = Record<string, unknown>
/** The keys the parity fake records (electron-fake.ts menuShape). */
const shape = (items: unknown): Item[] => (items as Item[]).map((i) => {
  const out: Item = {}
  for (const key of ['label', 'role', 'type', 'accelerator', 'enabled', 'checked', 'visible']) if (i[key] !== undefined) out[key] = i[key]
  if (i.submenu !== undefined) out.submenu = shape(i.submenu)
  return out
})

function menuOn(platform: NodeJS.Platform): Item[] {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    buildApplicationMenu()
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
  return shape(built.pop())
}

describe('golden form G2: the macOS application menu', () => {
  it('becomes the Windows and Linux menu', () => {
    initApplicationMenu({ get: () => undefined, set: () => {} })
    const windows = menuOn('win32')
    expect(menuOn('linux')).toEqual(windows)
    const mac = menuOn('darwin')
    expect(mac).not.toEqual(windows)
    // The app menu menu.ts builds on macOS is exactly the shape G2 expects.
    expect(mac[0]).toEqual({ label: 'ADF Studio', submenu: DARWIN_APP_SUBMENU })
    expect(darwinMenuInOtherForm(mac)).toEqual(windows)
  })

  it('moves the recorded Settings… and Quit items, and converts no other app menu', () => {
    const mac = menuOn('darwin')
    const edit = (menu: Item[]) => (menu.find((m) => m.label === 'Edit')!.submenu as Item[])
    expect(edit(darwinMenuInOtherForm(mac)).at(-1)).toEqual({ label: 'Settings…', accelerator: 'Ctrl+,' })
    // One more item in the app menu, or Window without Bring All to Front: left as recorded.
    const extra = [{ ...mac[0], submenu: [...(mac[0].submenu as Item[]), { label: 'Extra' }] }, ...mac.slice(1)]
    expect(darwinMenuInOtherForm(extra)).toBe(extra)
    const noFront = mac.map((m) => (m.label === 'Window' ? { ...m, submenu: (m.submenu as Item[]).slice(0, -2) } : m))
    expect(darwinMenuInOtherForm(noFront)).toBe(noFront)
  })

  it('leaves a menu without the app menu alone', () => {
    const windows = menuOn('win32')
    expect(darwinMenuInOtherForm(windows)).toBe(windows)
  })
})
