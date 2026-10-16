import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, dialog: {} }))

import { showWindowlessMessageBox } from '../src/main/utils/windowless-dialog'

describe('showWindowlessMessageBox', () => {
  it('logs what waits, flushes the log and brings Studio forward before the dialog opens', async () => {
    const order: string[] = []
    const result = await showWindowlessMessageBox('ChatGPT session: choose which account to keep', { message: 'Two accounts', buttons: ['A', 'B'] }, {
      log: (line) => order.push(`log ${line}`),
      flushLog: () => order.push('flush'),
      bringToFront: () => order.push('front'),
      show: async (options) => { order.push(`show ${options.message}`); return { response: 1, checkboxChecked: false } },
    })
    expect(result.response).toBe(1)
    expect(order).toEqual([
      '[App] Waiting for an answer in a dialog (no window yet): ChatGPT session: choose which account to keep',
      'flush',
      'front',
      'show Two accounts',
    ].map((s, i) => (i === 0 ? `log ${s}` : s)))
  })

  it('still opens the dialog when Studio cannot be brought forward', async () => {
    const show = vi.fn(async () => ({ response: 0, checkboxChecked: false }))
    await showWindowlessMessageBox('x', { message: 'm' }, { log: () => {}, flushLog: () => {}, bringToFront: () => { throw new Error('no dock') }, show })
    expect(show).toHaveBeenCalledOnce()
  })
})
