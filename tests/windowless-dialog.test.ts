import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, dialog: {}, BrowserWindow: class {}, nativeTheme: {} }))

import type { BrowserWindow } from 'electron'
import { showWindowlessMessageBox } from '../src/main/utils/windowless-dialog'

describe('showWindowlessMessageBox', () => {
  it('logs what waits, flushes the log, then opens the dialog on the boot window', async () => {
    const order: string[] = []
    const boot = { id: 'boot' } as unknown as BrowserWindow
    const result = await showWindowlessMessageBox('ChatGPT session: choose which account to keep', { message: 'Two accounts', buttons: ['A', 'B'] }, {
      log: (line) => order.push(`log ${line}`),
      flushLog: () => order.push('flush'),
      parent: (status) => { order.push(`parent ${status}`); return boot },
      show: async (parent, options) => { order.push(`show ${options.message} on ${parent === boot ? 'boot' : 'none'}`); return { response: 1, checkboxChecked: false } },
    })
    expect(result.response).toBe(1)
    expect(order).toEqual([
      'log [App] Waiting for an answer in a dialog (before the main window): ChatGPT session: choose which account to keep',
      'flush',
      'parent Waiting for your answer in the dialog.',
      'show Two accounts on boot',
    ])
  })

  it('still opens the dialog when no boot window can be made', async () => {
    const show = vi.fn(async () => ({ response: 0, checkboxChecked: false }))
    await showWindowlessMessageBox('x', { message: 'm' }, { log: () => {}, flushLog: () => {}, parent: () => { throw new Error('no window') }, show })
    expect(show).toHaveBeenCalledWith(null, { message: 'm' })
  })
})
