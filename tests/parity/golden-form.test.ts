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
import { darwinMenuInOtherForm } from './harness/normalize'

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
    expect(darwinMenuInOtherForm(mac)).toEqual(windows)
  })

  it('leaves a menu without the app menu alone', () => {
    const windows = menuOn('win32')
    expect(darwinMenuInOtherForm(windows)).toBe(windows)
  })
})
