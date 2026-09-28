import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { setAuthFlowSeams } from '../../src/main/tui/auth/flow'
import { authNeedOf, describeStatus, formatExpiry, spacedCode, subscriptionOfType } from '../../src/main/tui/auth/model'
import { startMockDaemon, AGENT_2_ID, type MockDaemon } from './fixtures/mock-daemon'
import { createAuthFetch, CHATGPT_AUTH_URL, GROK_CODE, GROK_URL, type AuthMock, type AuthMockOptions } from './fixtures/auth-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', down: '\u001b[B' }

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null
let opened: string[] = []

beforeEach(() => {
  opened = []
  setAuthFlowSeams({ openBrowser: url => { opened.push(url) }, sleep: () => new Promise(r => setTimeout(r, 15)) })
})

afterEach(async () => {
  setAuthFlowSeams(null)
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
})

async function mount(options: AuthMockOptions = {}): Promise<{ tui: RenderedTui; auth: AuthMock; store: TuiStore }> {
  mock = await startMockDaemon({ stepMs: 5 })
  const auth = createAuthFetch(options)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: auth.fetch }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 120, rows: 34 })
  await store.start()
  return { tui: ui, auth, store }
}

async function slash(tui: RenderedTui, text: string) {
  await tui.press(KEY.tab)
  await tui.type(text)
  await tui.press(KEY.enter)
}

describe('auth model', () => {
  it('maps provider types, formats status and codes', () => {
    expect(subscriptionOfType('chatgpt-subscription')).toBe('chatgpt')
    expect(subscriptionOfType('grok-subscription')).toBe('grok')
    expect(subscriptionOfType('openai-compatible', 'chatgpt-proxy')).toBeNull()
    expect(subscriptionOfType(undefined, 'chatgpt-sub')).toBe('chatgpt')
    expect(spacedCode('AB-12')).toBe('A B - 1 2')
    expect(formatExpiry(Date.now() + 3 * 86_400_000)).toBe('3d')
    expect(describeStatus({ authenticated: true, email: 'a@b.c' }).text).toBe('signed in as a@b.c')
    expect(describeStatus({ authenticated: false, flowError: 'denied' }).text).toContain('denied')
    const state = {
      auth: { chatgpt: { authenticated: false }, grok: { authenticated: true }, providers: [{ id: 'chatgpt-sub', type: 'chatgpt-subscription', name: 'ChatGPT', credentialStorage: 'app', hasApiKey: false }] },
      agents: { a: { config: { model: { provider: 'chatgpt-sub' } } }, b: { config: { model: { provider: 'mock' } } } },
    } as never
    expect(authNeedOf(state, 'a')).toBe('chatgpt')
    expect(authNeedOf(state, 'b')).toBeNull()
  })
})

describe('provider sign-in', () => {
  it('shows "not signed in" on the fleet row, the agent details and in chat', async () => {
    const { tui, store } = await mount({ agentProviders: { [AGENT_2_ID]: 'chatgpt-sub' } })
    let frame = await tui.waitFor('signed out')
    expect(frame).toMatch(/agent-2 .*signed out/)
    store.actions.selectAgent(AGENT_2_ID)
    frame = await tui.waitFor('ChatGPT not signed in — /login chatgpt')
    await tui.press('2')
    frame = await tui.waitFor(f => f.includes('agent-2 ›') && f.includes('ChatGPT not signed in — /login chatgpt'))
    expect(frame).toContain('ChatGPT not signed in')
  })

  it('/login chatgpt: opens the browser with the full URL, shows it, waits, then reports success', async () => {
    const { tui, auth, store } = await mount({ agentProviders: { [AGENT_2_ID]: 'chatgpt-sub' } })
    await tui.waitFor('signed out')
    await slash(tui, '/login chatgpt')
    let frame = await tui.waitFor('waiting for you to finish in the browser')
    expect(frame).toContain('Sign in to ChatGPT')
    expect(frame).toContain('https://auth.openai.com/oauth/authorize')
    // Every & parameter reaches the browser intact.
    expect(opened).toEqual([CHATGPT_AUTH_URL])
    expect(auth.calls).toContain('POST /auth/chatgpt/start')
    auth.approve('chatgpt')
    frame = await tui.waitFor('Signed in to ChatGPT as owner@example.test')
    await tui.press(KEY.enter)
    await tui.waitFor(f => !f.includes('Sign in to ChatGPT'))
    await tui.waitFor(() => store.getState().auth?.chatgpt.authenticated === true)
    frame = await tui.waitFor(f => f.includes('agent-2') && !f.includes('signed out'))
    expect(frame).not.toContain('not signed in')
  })

  it('/login grok: shows the device code big with its URL; Esc cancels and stops polling', async () => {
    const { tui, auth } = await mount()
    await tui.waitFor('agent-1')
    await slash(tui, '/login grok')
    const frame = await tui.waitFor(spacedCode(GROK_CODE))
    expect(frame).toContain('Enter this code in the browser')
    expect(frame).toContain(GROK_URL)
    expect(opened).toEqual([GROK_URL])
    await tui.waitFor(() => auth.state.grok.polls >= 1)
    await tui.press(KEY.esc)
    await tui.waitFor('Grok sign-in cancelled')
    const polls = auth.state.grok.polls
    await new Promise(r => setTimeout(r, 120))
    expect(auth.state.grok.polls).toBe(polls)
  })

  it('a failed sign-in is shown clearly and can be retried', async () => {
    const { tui } = await mount({ autoApproveAfterPolls: 1, failWith: 'access_denied' })
    await tui.waitFor('agent-1')
    await slash(tui, '/login grok')
    await tui.waitFor('Sign-in failed: access_denied')
    await tui.press(KEY.esc)
    await tui.waitFor(f => f.includes('Provider sign-in') && f.includes('last attempt: access_denied'))
  })

  it('/auth lists both providers, explains the daemon session once, and signs out after asking', async () => {
    const { tui, auth } = await mount({ signedIn: { chatgpt: true } })
    await tui.waitFor('agent-1')
    await slash(tui, '/auth')
    let frame = await tui.waitFor(f => f.includes('Provider sign-in') && f.includes('signed in as owner@example.test'))
    expect(frame).toContain('separate from ADF Studio')
    expect(frame).toMatch(/Grok\s+. not signed in/)
    await tui.press('o')
    await tui.waitFor('Sign the daemon out of ChatGPT?')
    await tui.press('y')
    await tui.waitFor(() => auth.calls.includes('POST /auth/chatgpt/logout'))
    frame = await tui.waitFor(f => /ChatGPT\s+. not signed in/.test(f))
    expect(frame).toContain('Provider sign-in')
  })

  it('/logout asks first', async () => {
    const { tui, auth } = await mount({ signedIn: { grok: true } })
    await tui.waitFor('agent-1')
    await slash(tui, '/logout grok')
    await tui.waitFor('Sign out of Grok')
    await tui.press('n')
    expect(auth.calls).not.toContain('POST /auth/grok/logout')
    // Focus is still in the prompt.
    await tui.type('/logout grok')
    await tui.press(KEY.enter)
    await tui.waitFor('Sign out of Grok')
    await tui.press('y')
    await tui.waitFor('Signed the daemon out of Grok')
    expect(auth.calls).toContain('POST /auth/grok/logout')
  })
})
