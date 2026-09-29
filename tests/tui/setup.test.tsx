import React from 'react'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { loadPrefs, resetPrefs } from '../../src/main/tui/app/prefs'
import { WELCOME_LAUNCHES, dismissWelcome, recordWelcomeLaunch, welcomeFacts, welcomeSteps, nextStepIndex } from '../../src/main/tui/setup/welcome'
import { adapterLiveState, channelEntries, credentialFields, findChannel, validateCredentials } from '../../src/main/tui/setup/channels'
import { findProviderRow, providerInput, providerRows, validateProvider } from '../../src/main/tui/setup/provider'
import { openWelcome } from '../../src/main/tui/setup/open'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createIdentityFetch, type IdentityMockOptions } from './fixtures/identity-daemon'
import { createSetupFetch, type SetupMock, type SetupMockOptions } from './fixtures/setup-daemon'
import { createAuthFetch } from './fixtures/auth-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', ctrlS: '\u0013', down: '\u001b[B', up: '\u001b[A' }

const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'
const API_KEY = 'sk-or-v1-9f8e7d6c5b4a39281706f5e4d3c2b1a0'

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null
let prefsDir: string | null = null

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
  resetPrefs()
  if (prefsDir) rmSync(prefsDir, { recursive: true, force: true })
  prefsDir = null
})

interface MountOptions { identity?: IdentityMockOptions; setup?: SetupMockOptions; columns?: number; rows?: number; signedIn?: boolean }

async function mount(options: MountOptions = {}): Promise<{ tui: RenderedTui; setup: SetupMock; store: TuiStore }> {
  mock = await startMockDaemon({ stepMs: 5 })
  const identity = createIdentityFetch(mock, options.identity ?? {})
  const auth = createAuthFetch({ signedIn: { chatgpt: !!options.signedIn } }, identity.fetch)
  const setup = createSetupFetch(options.setup ?? {}, auth.fetch)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: setup.fetch }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: options.columns ?? 110, rows: options.rows ?? 34 })
  await store.start()
  return { tui: ui, setup, store }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60))

async function slash(tui: RenderedTui, text: string) {
  store!.actions.prefillPrompt('')
  await tui.waitFor(() => store!.getState().focus === 'input')
  await new Promise(resolve => setTimeout(resolve, 40))
  await tui.type(text)
  await tui.waitFor(text)
  await tui.press(KEY.enter)
}

const base = { identityReady: true, modelReady: false, agentLoaded: false, messagingConnected: false, tasksGiven: false }

describe('welcome model', () => {
  it('counts launches and stops after the first few or "don’t show again"', () => {
    prefsDir = mkdtempSync(join(tmpdir(), 'adf-welcome-'))
    const file = join(prefsDir, 'tui-prefs.json')
    loadPrefs(file)
    const shown = Array.from({ length: WELCOME_LAUNCHES + 2 }, () => recordWelcomeLaunch())
    expect(shown).toEqual([true, true, true, false, false])
    expect(JSON.parse(readFileSync(file, 'utf8')).welcome.launches).toBe(5)

    loadPrefs(join(prefsDir, 'other.json'))
    expect(recordWelcomeLaunch()).toBe(true)
    // `d` in the dialog
    dismissWelcome()
    expect(recordWelcomeLaunch()).toBe(false)
  })

  it('puts identity first only when it is not ready, and ticks steps from the state', () => {
    expect(welcomeSteps({ ...base, identityReady: false })[0]).toMatchObject({ id: 'identity', run: '/identity', done: false })
    expect(welcomeSteps(base).map(s => s.id)).toEqual(['model', 'agent', 'messaging', 'tasks'])
    expect(welcomeSteps({ ...base, identityReady: null }).map(s => s.id)).not.toContain('identity')
    const steps = welcomeSteps({ ...base, modelReady: true, agentLoaded: true })
    expect(steps.filter(s => s.done).map(s => s.id)).toEqual(['model', 'agent'])
    expect(steps[nextStepIndex(steps)].id).toBe('messaging')

    const agent = { summary: { id: 'a', handle: 'agent-1' }, loops: [{ info: { name: 'main', entryCount: 0 } }], config: { adapters: { telegram: { enabled: true } } } }
    const facts = welcomeFacts({
      identity: { status: 'ready' } as never,
      auth: { chatgpt: { authenticated: false }, grok: { authenticated: false }, providers: [{ hasApiKey: true }] } as never,
      agents: { a: agent } as never,
      agentOrder: ['a'],
    })
    expect(facts).toEqual({ identityReady: true, modelReady: true, agentLoaded: true, messagingConnected: true, tasksGiven: false })
    expect(welcomeFacts({ identity: null, auth: null, agents: { a: agent } as never, agentOrder: ['a'] }, { adapters: {}, timers: { a: 1 } }).tasksGiven).toBe(true)
  })
})

describe('channels + provider models', () => {
  it('uses Studio’s channel registry and checks obvious mistakes', () => {
    expect(channelEntries().map(e => e.type)).toEqual(['telegram', 'discord', 'slack', 'email', 'whatsapp'])
    const telegram = findChannel('Telegram')!
    expect(credentialFields(telegram).map(f => f.key)).toEqual(['TELEGRAM_BOT_TOKEN'])
    expect(credentialFields(telegram)[0].hint).toContain('BotFather')
    expect(validateCredentials(telegram, {})).toEqual({ TELEGRAM_BOT_TOKEN: 'Bot token is required.' })
    expect(validateCredentials(telegram, { TELEGRAM_BOT_TOKEN: 'nope' }).TELEGRAM_BOT_TOKEN).toContain('123456789:AA')
    expect(validateCredentials(telegram, { TELEGRAM_BOT_TOKEN: TG_TOKEN })).toEqual({})
    const slack = findChannel('slack')!
    expect(Object.keys(validateCredentials(slack, { SLACK_APP_TOKEN: 'xoxb-1', SLACK_BOT_TOKEN: 'xoxb-2' }))).toEqual(['SLACK_APP_TOKEN'])
    expect(credentialFields(findChannel('whatsapp')!)).toEqual([])
    expect(adapterLiveState({ configured: [{ type: 'telegram' }], states: [] }, 'telegram').status).toBe('not running')
    expect(adapterLiveState({ configured: [], states: [{ type: 'telegram', status: 'error', error: 'bad' }] }, 'telegram')).toEqual({ status: 'error', error: 'bad' })
  })

  it('lists subscriptions (sign in) before API providers and validates the form', () => {
    const rows = providerRows()
    expect(rows[0].signIn).toBe('chatgpt')
    expect(rows.find(r => r.entry.key === 'openrouter')?.signIn).toBeUndefined()
    const groq = findProviderRow('groq')!.entry
    expect(validateProvider(groq, { name: '', baseUrl: groq.baseUrl!, apiKey: '', defaultModel: '' })).toEqual({ apiKey: 'Paste the API key.' })
    const cf = findProviderRow('cloudflare')!.entry
    expect(validateProvider(cf, { name: '', baseUrl: cf.baseUrl!, apiKey: 'k', defaultModel: '' }).baseUrl).toContain('YOUR_')
    const ollama = findProviderRow('ollama')!.entry
    expect(validateProvider(ollama, { name: '', baseUrl: 'http://localhost:11434/v1', apiKey: '', defaultModel: '' })).toEqual({})
    expect(providerInput(groq, { name: '', baseUrl: groq.baseUrl!, apiKey: ' k ', defaultModel: 'm' })).toEqual({ type: 'openai-compatible', name: 'Groq', baseUrl: groq.baseUrl, defaultModel: 'm', preset: 'groq', apiKey: 'k' })
  })
})

describe('welcome dialog', () => {
  it('opens over the UI, ticks what is done, and Enter runs the next step', async () => {
    const { tui, store } = await mount({ signedIn: true })
    openWelcome(store)
    const frame = await tui.waitFor('Get started')
    expect(frame).toContain('Welcome to ADF')
    expect(frame).toContain('portable and self-contained')
    expect(frame).toContain('host access (compute_exec)')
    expect(frame).not.toContain('Set up your identity')
    expect(frame).toMatch(/✓ Connect a model/)
    expect(frame).toMatch(/✓ Create an agent/)
    expect(frame).toMatch(/› ○ Connect a channel\s+\/channels add/)
    expect(frame).toContain('don’t show again')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('Channels · agent-1') && f.includes('Telegram'))
    expect(store.getState().overlays.map(o => o.kind)).toEqual(['channels'])
  }, 15000)

  it('identity not ready: identity is the first step and Enter opens its dialog', async () => {
    const { tui, store } = await mount({ identity: { status: 'none' } })
    openWelcome(store)
    await tui.waitFor(f => f.includes('Set up your identity') && f.includes('/identity'))
    expect(tui.lastFrame()).toMatch(/› ○ Set up your identity/)
    await tui.press(KEY.enter)
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'identity'))
  }, 15000)

  it('↑/↓ pick a step, Esc closes, d hides it for good', async () => {
    prefsDir = mkdtempSync(join(tmpdir(), 'adf-welcome-'))
    loadPrefs(join(prefsDir, 'tui-prefs.json'))
    const { tui, store } = await mount({ signedIn: true })
    openWelcome(store)
    await tui.waitFor('Get started')
    await tui.press(KEY.up)
    await tui.waitFor(f => /› ✓ Create an agent/.test(f))
    await tui.press(KEY.esc)
    await tui.waitFor(() => store.getState().overlays.length === 0)
    openWelcome(store)
    await tui.waitFor('Get started')
    await tui.press('d')
    await tui.waitFor(() => store.getState().overlays.length === 0)
    expect(loadPrefs(join(prefsDir, 'tui-prefs.json')).welcome?.dismissed).toBe(true)
  }, 15000)

  it('fits 80×24', async () => {
    const { tui, store } = await mount({ columns: 80, rows: 24 })
    openWelcome(store)
    const frame = await tui.waitFor('Get started')
    expect(frame).toContain('Welcome to ADF')
    expect(frame).toContain('Give it tasks')
    expect(frame).toContain('Esc close')
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
  }, 15000)
})

describe('/channels', () => {
  it('adds Telegram: masked token, sealed credential, switch on, live state', async () => {
    const { tui, setup } = await mount()
    await slash(tui, '/channels add telegram')
    let frame = await tui.waitFor('Telegram · agent-1')
    expect(frame).toContain('@BotFather')
    expect(frame).toContain('From @BotFather after /newbot.')
    await tui.type(TG_TOKEN)
    frame = await tui.waitFor(`${TG_TOKEN.length} chars`)
    expect(frame).not.toContain(TG_TOKEN)
    expect(frame).not.toContain('AAHdqTcv')
    await tui.press(KEY.enter)
    frame = await tui.waitFor(f => f.includes('switched on for agent-1') && f.includes('connected'))
    expect(frame).toContain('sealed in the agent')
    expect(setup.calls).toEqual(['PUT /agents/' + AGENT_1_ID + '/adapters/credentials', 'POST /agents/' + AGENT_1_ID + '/adapters'])
    expect(setup.credentials.get(AGENT_1_ID)?.get('telegram')?.get('TELEGRAM_BOT_TOKEN')).toBe(TG_TOKEN)
    expect(setup.channels.get(AGENT_1_ID)?.get('telegram')?.config).toEqual({ enabled: true, policy: { dm: 'all', groups: 'mention' } })
    for (const f of tui.frames) expect(f).not.toContain(TG_TOKEN)
    await tui.press('i')
    await tui.waitFor(() => store!.getState().activeView === 'inspect')
  }, 15000)

  it('validates before anything is sent', async () => {
    const { tui, setup } = await mount()
    await slash(tui, '/channels add telegram')
    await tui.waitFor('Telegram · agent-1')
    await tui.press(KEY.ctrlS)
    await tui.waitFor('Bot token is required.')
    await tui.type('not-a-token')
    await tui.press(KEY.enter)
    await tui.waitFor('digits, a colon')
    expect(setup.calls).toEqual([])
  }, 15000)

  it('identity not ready: routes to the identity dialog first', async () => {
    const { tui, setup, store } = await mount({ identity: { status: 'none' } })
    await slash(tui, '/channels add telegram')
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'identity'))
    const overlay = store.getState().overlays.find(o => o.kind === 'identity')!
    expect(overlay.props).toMatchObject({ then: 'channels', thenProps: { agentId: AGENT_1_ID, channel: 'telegram' } })
    expect(tui.lastFrame()).toContain('Channel credentials are sealed under your owner identity')
    expect(setup.calls).toEqual([])
  }, 15000)

  it('lists channels with state and removes one after asking', async () => {
    const { tui, setup } = await mount({ setup: { channels: { 'agent-1': ['telegram'] }, connectAfterPolls: 0 } })
    await slash(tui, '/channels')
    let frame = await tui.waitFor(f => f.includes('Channels · agent-1') && f.includes('connected'))
    expect(frame).toMatch(/Discord\s+off/)
    await tui.press('d')
    await tui.waitFor('Disconnect agent-1 from Telegram?')
    await tui.press('y')
    frame = await tui.waitFor(f => /Telegram\s+off/.test(f))
    expect(setup.calls).toContain(`DELETE /agents/${AGENT_1_ID}/adapters/telegram`)
  }, 15000)

  it('locked credentials: explains, Cancel keeps the form, Replace asks first then re-sends with replace', async () => {
    const { tui, setup } = await mount({ setup: { credentialsLocked: true } })
    await slash(tui, '/channels add telegram')
    await tui.waitFor('Telegram · agent-1')
    await tui.type(TG_TOKEN)
    await tui.press(KEY.enter)
    let frame = await tui.waitFor('r Replace · c/Esc Cancel'); await settle()
    expect(frame.replace(/[│\s]+/g, ' ')).toContain("This agent's saved Telegram is locked and can't be read (identity not unlocked). Unlock first (/identity), or replace it — the old value is discarded.")
    expect(setup.credentialWrites).toEqual([{ path: `/agents/${AGENT_1_ID}/adapters/credentials`, replace: false }])
    await tui.press('c')
    frame = await tui.waitFor(`${TG_TOKEN.length} chars`); await settle()
    expect(frame).toContain('@BotFather')
    await tui.press(KEY.enter)
    await tui.waitFor('r Replace · c/Esc Cancel'); await settle()
    await tui.press('r')
    await tui.waitFor('Replace the saved Telegram?'); await settle()
    await tui.press('n')
    await tui.waitFor('r Replace · c/Esc Cancel'); await settle()
    expect(setup.credentialWrites.filter(w => w.replace)).toEqual([])
    await tui.press('r')
    await tui.waitFor('Replace the saved Telegram?'); await settle()
    await tui.press('y')
    await tui.waitFor(f => f.includes('switched on for agent-1'))
    expect(setup.credentialWrites.at(-1)).toEqual({ path: `/agents/${AGENT_1_ID}/adapters/credentials`, replace: true })
    expect(setup.credentials.get(AGENT_1_ID)?.get('telegram')?.get('TELEGRAM_BOT_TOKEN')).toBe(TG_TOKEN)
    for (const f of tui.frames) expect(f).not.toContain(TG_TOKEN)
  }, 20000)

  it('locked credentials: Unlock opens the identity flow and resumes the channel after', async () => {
    const { tui, store } = await mount({ setup: { credentialsLocked: true } })
    await slash(tui, '/channels add telegram')
    await tui.waitFor('Telegram · agent-1')
    await tui.type(TG_TOKEN)
    await tui.press(KEY.enter)
    await tui.waitFor('r Replace · c/Esc Cancel'); await settle()
    await tui.press('u')
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'identity'))
    expect(store.getState().overlays.find(o => o.kind === 'identity')?.props).toMatchObject({ then: 'channels', thenProps: { agentId: AGENT_1_ID, channel: 'telegram' } })
    expect(JSON.stringify(store.getState())).not.toContain(TG_TOKEN)
  }, 15000)

  it('editing shows what is stored, never the value', async () => {
    const { tui, setup } = await mount()
    await slash(tui, '/channels add telegram')
    await tui.waitFor('Telegram · agent-1')
    await tui.type(TG_TOKEN)
    await tui.press(KEY.enter)
    await tui.waitFor('switched on for agent-1'); await settle()
    await tui.press('e')
    const frame = await tui.waitFor('set • (hidden) · type to replace')
    expect(frame).not.toContain(TG_TOKEN)
    expect(setup.credentials.get(AGENT_1_ID)?.get('telegram')?.size).toBe(1)
  }, 15000)

  it('WhatsApp: no credentials, switch on, then how to pair by QR', async () => {
    const { tui } = await mount()
    await slash(tui, '/channels add whatsapp')
    await tui.waitFor('No credentials needed')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('switched on') && f.includes('pairing-qr.png'))
  }, 15000)
})

describe('/provider add', () => {
  it('stores the key through POST /runtime/providers and never renders it', async () => {
    const { tui, setup } = await mount()
    await slash(tui, '/provider add openrouter')
    await tui.waitFor('Connect OpenRouter')
    expect(tui.lastFrame()).toContain('https://openrouter.ai/keys')
    await tui.type(API_KEY)
    await tui.waitFor(`${API_KEY.length} chars`)
    await tui.press(KEY.ctrlS)
    const frame = await tui.waitFor('OpenRouter added')
    expect(frame).toContain('never in the settings file')
    expect(setup.providerBodies).toEqual([{ type: 'openrouter', name: 'OpenRouter', preset: 'openrouter', apiKey: API_KEY }])
    expect(setup.keys.get('custom:000001')).toBe(API_KEY)
    for (const f of tui.frames) expect(f).not.toContain(API_KEY)
    expect(JSON.stringify(store!.getState())).not.toContain(API_KEY)
    // It shows in /model's picker.
    await tui.press('m')
    await tui.waitFor(f => f.includes('OpenRouter') && f.includes('key set'))
  }, 15000)

  it('secret store locked: routes to the identity dialog', async () => {
    const { tui, store } = await mount({ setup: { secretStoreLocked: true } })
    await slash(tui, '/provider add anthropic')
    await tui.waitFor('Connect Anthropic')
    await tui.type('sk-ant-test-key')
    await tui.press(KEY.ctrlS)
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'identity'))
    expect(store.getState().overlays.find(o => o.kind === 'identity')?.props).toMatchObject({ then: 'provider.add', thenProps: { preset: 'anthropic' } })
  }, 15000)

  it('subscriptions sign in instead', async () => {
    const { tui, store } = await mount()
    await slash(tui, '/provider add')
    await tui.waitFor('Connect a model')
    // The list starts on the first API provider; ↑↑ reaches ChatGPT.
    await tui.press(KEY.up)
    await tui.press(KEY.up)
    await tui.press(KEY.enter)
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'auth'))
  }, 15000)
})
