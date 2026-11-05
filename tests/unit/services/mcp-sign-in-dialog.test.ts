import { describe, expect, it, vi } from 'vitest'
import { showMcpSignInDialog } from '../../../src/main/services/mcp-sign-in-dialog'

function ui(responses: number[], onShow?: () => void) {
  const shown: Record<string, unknown>[] = []
  const showMessageBox = vi.fn(async (...args: unknown[]) => {
    shown.push(args[args.length - 1] as Record<string, unknown>)
    onShow?.()
    return { response: responses.shift() ?? 0, checkboxChecked: false }
  })
  return {
    shown,
    ui: {
      dialog: { showMessageBox } as never,
      BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] } as never,
    },
  }
}

describe('showMcpSignInDialog', () => {
  it('Open sign-in page opens the link and shows the dialog again; Cancel returns', async () => {
    const { shown, ui: deps } = ui([1, 0])
    const opened: string[] = []
    await showMcpSignInDialog(deps, {
      serverName: 'gmail',
      authUrl: () => 'https://accounts.example.test/auth',
      openUrl: (url) => { opened.push(url) },
      signal: new AbortController().signal,
    })
    expect(opened).toEqual(['https://accounts.example.test/auth'])
    expect(shown).toHaveLength(2)
    expect(shown[0]).toMatchObject({ title: 'Sign in — gmail', buttons: ['Cancel', 'Open sign-in page'], cancelId: 0 })
  })

  it('without a link only Cancel is offered', async () => {
    const { shown, ui: deps } = ui([0])
    await showMcpSignInDialog(deps, { serverName: 'gmail', authUrl: () => null, openUrl: () => {}, signal: new AbortController().signal })
    expect(shown[0]).toMatchObject({ buttons: ['Cancel'], detail: 'This closes by itself when sign-in is done.' })
  })

  it('returns without opening anything once the sign-in finished', async () => {
    const finished = new AbortController()
    const { shown, ui: deps } = ui([1], () => finished.abort())
    const openUrl = vi.fn()
    await showMcpSignInDialog(deps, { serverName: 'gmail', authUrl: () => 'https://accounts.example.test/auth', openUrl, signal: finished.signal })
    expect(shown).toHaveLength(1)
    expect(openUrl).not.toHaveBeenCalled()
  })
})
