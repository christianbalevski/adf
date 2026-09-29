import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { identityBadge, identityErrorText, isLoopbackUrl, normalizePhrase, onboardingChoices, passphraseProblem, phraseWords, shortDid } from '../../src/main/tui/identity/model'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createIdentityFetch, MOCK_PASSPHRASE, MOCK_PHRASE, MOCK_WORDS, OTHER_PHRASE, OWNER_DID, type IdentityMock, type IdentityMockOptions } from './fixtures/identity-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', ctrlS: '\u0013', down: '\u001b[B', right: '\u001b[C' }

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
})

async function mount(options: IdentityMockOptions = {}): Promise<{ tui: RenderedTui; identity: IdentityMock; store: TuiStore; mock: MockDaemon }> {
  mock = await startMockDaemon({ stepMs: 5 })
  const identity = createIdentityFetch(mock, options)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: identity.fetch }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 120, rows: 34 })
  await store.start()
  return { tui: ui, identity, store, mock }
}

/** The distinctive words of the mock phrase (legal/winner/thank repeat on purpose). */
const SECRET_WORDS = ['sausage', 'useful', 'yellow']

describe('identity model', () => {
  it('normalises pasted phrases, numbering and case included', () => {
    expect(normalizePhrase('  Legal\tWINNER\n thank  ')).toBe('legal winner thank')
    expect(phraseWords('1. legal 2. winner\n3) thank 4 year')).toEqual(['legal', 'winner', 'thank', 'year'])
    expect(phraseWords(MOCK_WORDS.map((w, i) => `${i + 1} ${w}`).join('\n'))).toEqual(MOCK_WORDS)
  })

  it('shortens DIDs, spots loopback URLs and maps error codes', () => {
    expect(shortDid(OWNER_DID)).toBe('did:key:z6Mkha…2doK')
    expect(isLoopbackUrl('http://127.0.0.1:7385')).toBe(true)
    expect(isLoopbackUrl('http://localhost:7385')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:7385')).toBe(true)
    expect(isLoopbackUrl('http://10.0.0.5:7385')).toBe(false)
    expect(identityErrorText('owner_mismatch', 'x', { ownerDid: OWNER_DID } as never)).toContain('did:key:z6Mkha…2doK')
    expect(identityErrorText('invalid_mnemonic', 'x')).toContain('not 12 valid seed words')
    expect(identityErrorText('something_else', 'fallback')).toBe('fallback')
    expect(passphraseProblem('short', null, true)).toContain('8')
    expect(passphraseProblem('long enough', 'different', true)).toContain('differ')
    expect(passphraseProblem('x', null, false)).toBeNull()
  })

  it('offers per-status choices and a header badge', () => {
    const base = { ownerDid: OWNER_DID, runtimeDid: null, storage: 'keychain' as const, backupConfirmed: true, passphraseRequired: false, message: '' }
    expect(onboardingChoices({ ...base, status: 'none', ownerDid: null }).map(c => c.key)).toEqual(['c', 'r'])
    expect(onboardingChoices({ ...base, status: 'restore-needed' }).map(c => c.key)).toEqual(['r'])
    expect(onboardingChoices({ ...base, status: 'locked', storage: 'file', passphraseRequired: true }).map(c => c.key)).toEqual(['u'])
    expect(identityBadge(null)).toBeNull()
    expect(identityBadge({ ...base, status: 'ready' })?.text).toBe('owner z6Mk…2doK')
    expect(identityBadge({ ...base, status: 'ready', backupConfirmed: false })?.tone).toBe('warn')
    expect(identityBadge({ ...base, status: 'none', ownerDid: null })?.text).toBe('no owner')
  })
})

describe('identity onboarding', () => {
  it('first run: explains the owner identity in place of the empty fleet and offers create / restore', async () => {
    const { tui } = await mount({ status: 'none', emptyFleet: true })
    const frame = await tui.waitFor('Set up your owner identity')
    expect(frame).toContain('proves these agents are yours')
    expect(frame).toContain('[c] Create new')
    expect(frame).toContain('[r] Restore from seed phrase')
    expect(frame).toContain('no owner')
    expect(frame).not.toContain('No agents loaded')
  })

  it('create shows the 12 words once, confirms the backup, and leaves no words behind', async () => {
    const { tui, identity, store } = await mount({ status: 'none', emptyFleet: true })
    await tui.waitFor('[c] Create new')
    await tui.press('c')
    const shown = await tui.waitFor('Your seed phrase')
    for (const word of SECRET_WORDS) expect(shown).toContain(word)
    expect(shown).toContain(' 1 legal')
    expect(shown).toContain('12 yellow')
    expect(shown).toContain('shown once')
    // The words live in the dialog only: not in state, overlay props or toasts.
    const json = JSON.stringify(store.getState())
    for (const word of SECRET_WORDS) expect(json).not.toContain(word)
    expect(identity.calls).toContain('POST /identity/create')
    expect(identity.calls).not.toContain('POST /identity/confirm-backup')

    // Enter alone does not confirm: the user must type "saved".
    await tui.press(KEY.enter)
    await tui.waitFor('Type saved once')
    await tui.type('saved')
    await tui.press(KEY.enter)
    await tui.waitFor(f => !f.includes('Your seed phrase'))
    await tui.waitFor(() => identity.calls.includes('POST /identity/confirm-backup'))
    const after = await tui.waitFor('owner z6Mk…2doK')
    for (const word of SECRET_WORDS) expect(after).not.toContain(word)
    for (const word of SECRET_WORDS) expect(JSON.stringify(store.getState())).not.toContain(word)
    expect(store.getState().identity?.backupConfirmed).toBe(true)
  })

  it('closing the words without confirming asks first and keeps the backup unconfirmed', async () => {
    const { tui, identity, store } = await mount({ status: 'none', emptyFleet: true })
    await tui.waitFor('[c] Create new')
    await tui.press('c')
    await tui.waitFor('Your seed phrase')
    await tui.press(KEY.esc)
    await tui.waitFor('Close without confirming?')
    await tui.press('n')
    await tui.waitFor(f => f.includes('Your seed phrase') && !f.includes('Close without confirming?'))
    await tui.press(KEY.esc)
    await tui.press('y')
    const frame = await tui.waitFor(f => !f.includes('Your seed phrase'))
    for (const word of SECRET_WORDS) expect(frame).not.toContain(word)
    expect(identity.calls).not.toContain('POST /identity/confirm-backup')
    expect(store.getState().identity?.backupConfirmed).toBe(false)
    await tui.waitFor('not backed up')
  })

  it('file storage: a new passphrase needs 8+ characters, typed twice, masked', async () => {
    const { tui, identity } = await mount({ status: 'none', storage: 'file', emptyFleet: true })
    await tui.waitFor('[c] Create new')
    await tui.press('c')
    await tui.waitFor('Protect your owner identity')
    await tui.type('short')
    let frame = await tui.waitFor('•••••')
    expect(frame).not.toContain('short')
    await tui.press(KEY.enter)
    await tui.waitFor('At least 8 characters')
    await tui.type('er one')
    await tui.press(KEY.enter)
    await tui.waitFor('Type it again')
    await tui.type('something else')
    await tui.press(KEY.enter)
    await tui.waitFor('The two passphrases differ')
    await tui.type(MOCK_PASSPHRASE)
    await tui.press(KEY.enter)
    await tui.waitFor('Type it again')
    await tui.type(MOCK_PASSPHRASE)
    await tui.press(KEY.enter)
    frame = await tui.waitFor('Your seed phrase')
    expect(frame).not.toContain(MOCK_PASSPHRASE)
    expect(identity.state.hasFile).toBe(true)
  })

  it('restore-needed: restore only, names the expected owner, maps invalid and mismatched phrases', async () => {
    const { tui, store } = await mount({ status: 'restore-needed', emptyFleet: true })
    const panel = await tui.waitFor('Restore your owner identity')
    expect(panel).toContain('did:key:z6Mkha…2doK')
    expect(panel).toContain('[r] Restore')
    expect(panel).not.toContain('[c]')
    await tui.press('r')
    await tui.waitFor('Enter the phrase for this owner')
    await tui.type('legal winner thank')
    let frame = await tui.waitFor('3/12 words')
    expect(frame).not.toContain('winner')
    await tui.press(KEY.enter)
    await tui.waitFor('That is 3 words')
    // A valid phrase of another owner.
    await tui.press('\u0015') // Ctrl+U clears the line
    await tui.type(OTHER_PHRASE)
    await tui.press(KEY.enter)
    frame = await tui.waitFor('belongs to a different owner')
    expect(frame).toContain('did:key:z6Mkha…2doK')
    // Twelve words that are not a valid phrase.
    await tui.press('\u0015')
    await tui.type('one two three four five six seven eight nine ten eleven twelve')
    await tui.press(KEY.enter)
    await tui.waitFor('not 12 valid seed words')
    // Pasted with numbering and mixed case: normalised, accepted.
    await tui.press('\u0015')
    await tui.type(MOCK_WORDS.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join(' '))
    await tui.waitFor('12/12 words')
    await tui.press(KEY.enter)
    await tui.waitFor('Owner identity restored')
    expect(store.getState().identity?.status).toBe('ready')
    expect(JSON.stringify(store.getState())).not.toContain('sausage')
  })

  it('locked: unlock with the passphrase, wrong one reported inline', async () => {
    const { tui, store } = await mount({ status: 'locked', storage: 'file', emptyFleet: true })
    await tui.waitFor('Your owner identity is locked')
    await tui.press('u')
    await tui.waitFor('Unlock owner identity')
    await tui.type('nope nope')
    await tui.press(KEY.enter)
    await tui.waitFor('Wrong passphrase.')
    await tui.press('\u0015')
    await tui.type(MOCK_PASSPHRASE)
    await tui.press(KEY.enter)
    await tui.waitFor('Owner identity unlocked')
    expect(store.getState().identity?.status).toBe('ready')
  })

  it('a remote daemon: create explains to run it on the daemon machine', async () => {
    const { tui, store } = await mount({ status: 'none', emptyFleet: true, remote: true })
    await tui.waitFor('[c] Create new')
    // Same answer the daemon would give a non-loopback caller.
    const result = await store.actions.createIdentity()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(identityErrorText(result.code, result.error)).toContain('daemon’s own machine')
  })

  it('shows a dismissible banner above a non-empty fleet and the /identity status dialog', async () => {
    const { tui } = await mount({ status: 'none' })
    await tui.waitFor('No owner identity yet')
    await tui.press('I')
    await tui.waitFor(f => !f.includes('No owner identity yet') && f.includes('agent-1'))
    await tui.press(KEY.tab)
    await tui.type('/identity')
    await tui.press(KEY.enter)
    const frame = await tui.waitFor('Owner identity')
    expect(frame).toContain('not set up')
    expect(frame).toContain('c create new')
  })
})

describe('/new agent wizard', () => {
  it('creates an agent from a template, selects it and opens its chat', async () => {
    const { tui, identity, store, mock } = await mount({ status: 'ready' })
    await tui.waitFor('agent-1')
    await tui.press('n')
    let frame = await tui.waitFor('Standard (default)')
    expect(frame).toContain('New agent')
    await tui.type('agent-3')
    await tui.press(KEY.enter) // → template
    await tui.press(KEY.right) // Coder, with its warning
    frame = await tui.waitFor('Runs code and reaches your host')
    await tui.press(KEY.ctrlS)
    await tui.waitFor('Created agent-3 and started it')
    await tui.waitFor(() => store.getState().activeView === 'chat')
    const selected = store.getState().selectedAgentId!
    expect(store.getState().agents[selected]?.summary.name).toBe('agent-3')
    expect(identity.created).toEqual([expect.objectContaining({ name: 'agent-3', template: 'coder', start: true })])
    expect(mock.agents.has(selected)).toBe(true)
    await tui.waitFor(f => /agent-3 › ↻ main/.test(f))
  })

  it('name taken is shown on the name field', async () => {
    const { tui, identity } = await mount({ status: 'ready' })
    await tui.waitFor('agent-1')
    await tui.press(KEY.tab)
    await tui.type('/new agent-2')
    await tui.press(KEY.enter)
    await tui.waitFor('Standard (default)')
    await tui.press(KEY.ctrlS)
    await tui.waitFor('already exists in the folder')
    expect(identity.created).toEqual([])
  })

  it('routes 409 identity_not_ready to the identity dialog, then back to the wizard', async () => {
    const { tui, identity, store } = await mount({ status: 'ready' })
    await tui.waitFor('agent-1')
    // Another client wiped the identity since we last looked.
    identity.state.status = 'none'
    identity.state.ownerDid = null
    await tui.press('n')
    let frame = await tui.waitFor('Agents are sealed under your owner identity')
    expect(frame).toContain('not set up')
    expect(store.getState().identity?.status).toBe('none')
    await tui.press('c')
    await tui.waitFor('Your seed phrase')
    await tui.type('saved')
    await tui.press(KEY.enter)
    frame = await tui.waitFor('Standard (default)')
    expect(frame).toContain('New agent')
    for (const word of SECRET_WORDS) expect(frame).not.toContain(word)
  })

  it('with no identity, n goes to the identity dialog first', async () => {
    const { tui, identity } = await mount({ status: 'none' })
    await tui.waitFor('agent-1')
    await tui.press('n')
    await tui.waitFor('set it up first')
    expect(identity.calls).not.toContain('GET /templates')
    expect(MOCK_PHRASE.split(' ')).toHaveLength(12)
  })
})
