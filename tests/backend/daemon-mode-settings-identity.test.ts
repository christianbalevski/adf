/**
 * Daemon-mode handlers of W3-B (tracker W3-B): providers, models,
 * subscription sign-in and identity, against a scripted daemon. What the
 * parity scenarios (tests/parity/settings, tests/parity/identity) cannot
 * reach on a fixture: the locked-envelope choices, "Copy app key", the
 * owner-status shapes of every daemon identity status, the ChatGPT relay,
 * and the secrets that must not cross into the renderer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { LOCAL_PROOF_HEADER, mintLocalProof } from '../../src/main/daemon/local-access'
import identityFixture from '../parity/harness/identity.fixture.json'

const BASE = 'http://127.0.0.1:47391'
const TOKEN = 'b'.repeat(43)
const AGENT = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'
const FILE = join(tmpdir(), 'agents', 'agent-1.adf')
const fixture = identityFixture as Record<string, unknown>
/** The fixture's `safe:` values use the parity electron fake's encoding. */
const PHRASE = Buffer.from(String(fixture.ownerMnemonic).replace(/^safe:/, ''), 'base64').toString('utf-8').slice('parity-safe:'.length)

let dir: string
let handle: DaemonModeHandle
const daemon = createFakeDaemon(BASE)
let keychain: string | null = PHRASE
const logs: string[] = []
const log = { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (...m: unknown[]) => { logs.push(m.join(' ')) } }

const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electronStub.handlers.get(channel)!({}, ...args))
const requests = (method: string, path: string) => daemon.requests.filter((r) => r.method === method && r.path === path)
const locked = (message: string) => ({ status: 409, body: { error: message, code: 'credentials_locked' } })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-w3b-'))
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  handle = registerDaemonModeHandlers({
    mode: 'local',
    userDataDir: dir,
    connect: async () => ({ baseUrl: BASE, logFile: null, description: 'the fake daemon', source: { token: () => TOKEN } }),
    leases: { registerClient: async () => {} },
    fetch: daemon.fetch,
    createSession: () => createFakeClientSession(),
    sharedMnemonic: () => ({ read: () => keychain, write: () => { throw new Error('Studio never writes the shared phrase in daemon mode') } }),
    log,
  })
  expect(await handle.ready).toBe(true)
})

afterAll(async () => {
  await handle.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  daemon.requests.length = 0
  electronStub.calls.length = 0
  electronStub.dialogResponse = 0
})

describe('provider keys never cross as values they are not', () => {
  it('"Copy app key" sends no key: the daemon copies the app key it holds', async () => {
    daemon.routes.set('POST /files/agent/providers/parity-llm/credential/copy-app-key', () => ({ success: true, filePath: FILE, loaded: false }))
    const result = await invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath: FILE, providerId: 'parity-llm', value: '__redacted__' })
    expect(result).toEqual({ success: true })
    expect(requests('POST', '/files/agent/providers/parity-llm/credential/copy-app-key')).toHaveLength(1)
    expect(daemon.requests.some((r) => JSON.stringify(r.body ?? {}).includes('__redacted__'))).toBe(false)
  })

  it('PROVIDER_ATTACH drops fields the embedded schema drops (an apiKey never lands in the agent config)', async () => {
    daemon.routes.set('POST /files/agent/providers', () => ({ success: true, alreadyAttached: false }))
    const provider = { id: 'p1', type: 'openai', name: 'OpenAI', baseUrl: '', apiKey: '__redacted__', credentialStorage: 'app' }
    expect(await invoke(IPC.PROVIDER_ATTACH, { filePath: FILE, provider })).toEqual({ success: true })
    const sent = requests('POST', '/files/agent/providers')[0]
    expect(sent.query).toEqual({ path: FILE })
    expect(sent.body).toEqual({ provider: { id: 'p1', type: 'openai', name: 'OpenAI', baseUrl: '' } })
  })

  it('PROVIDER_CREDENTIAL_GET reads values through the local-only reveal route, keyed as embedded keys them', async () => {
    daemon.routes.set('GET /files/agent/providers/p1/credentials', () => ({ credentials: { apiKey: { present: true } }, providerConfig: { defaultModel: 'm', params: [], requestDelayMs: 5 } }))
    daemon.routes.set('POST /files/agent/identity/reveal', ({ body }) => {
      expect(body).toEqual({ prefix: 'provider:p1:' })
      return { filePath: FILE, loaded: false, values: { 'provider:p1:apiKey': 'sk-agent' } }
    })
    expect(await invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath: FILE, providerId: 'p1' })).toEqual({
      credentials: { apiKey: 'sk-agent' },
      providerConfig: { defaultModel: 'm', params: [], requestDelayMs: 5 },
    })
  })
})

describe('locked-envelope choices (409 credentials_locked)', () => {
  const route = 'PUT /files/agent/providers/p1/credential'
  const lockedThenOk = (msg: string) => ({ body }: { body: unknown }) => ((body as { replace?: boolean }).replace ? { success: true } : locked(msg))

  it('Replace: the owner is asked, then the daemon stores it with replace', async () => {
    daemon.routes.set(route, lockedThenOk('The credentials envelope of this agent is locked on this daemon — refusing to store "provider:p1:apiKey" unsealed.'))
    electronStub.dialogResponse = 0
    expect(await invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath: FILE, providerId: 'p1', value: 'sk-new' })).toEqual({ success: true })
    const dialogCall = electronStub.calls.find((c) => c.api === 'dialog.showMessageBox')
    expect(dialogCall?.args[0]).toMatchObject({ buttons: ['Replace', 'Cancel'], cancelId: 1 })
    expect(requests('PUT', '/files/agent/providers/p1/credential').map((r) => r.body)).toEqual([{ value: 'sk-new' }, { value: 'sk-new', replace: true }])
    expect(logs.some((l) => l.includes('the owner chose to replace'))).toBe(true)
  })

  it('a sealed value is named as such; Cancel stores nothing and shows the daemon\'s refusal', async () => {
    const msg = 'This agent\'s saved "provider:p1:apiKey" is sealed and its credentials envelope is locked on this daemon, so it can\'t be read or overwritten.'
    daemon.routes.set(route, lockedThenOk(msg))
    electronStub.dialogResponse = 1
    expect(await invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath: FILE, providerId: 'p1', value: 'sk-new' })).toEqual({ success: false, error: `Error: ${msg}` })
    expect((electronStub.calls.find((c) => c.api === 'dialog.showMessageBox')?.args[0] as { message: string }).message).toContain('is sealed')
    expect(requests('PUT', '/files/agent/providers/p1/credential')).toHaveLength(1)
  })

  it('IDENTITY_SET on the open agent has the same choice', async () => {
    await handle.session.openFile(FILE, async () => AGENT)
    const path = `/agents/${AGENT}/identity/${encodeURIComponent('app:token')}`
    daemon.routes.set(`PUT ${path}`, lockedThenOk('The credentials envelope of this agent is locked on this daemon — refusing to store "app:token" unsealed.'))
    electronStub.dialogResponse = 0
    expect(await invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: 'v' })).toBeUndefined()
    expect(requests('PUT', path).map((r) => r.body)).toEqual([{ value: 'v' }, { value: 'v', replace: true }])
    electronStub.dialogResponse = 1
    await expect(invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: 'v' })).rejects.toThrow(/refusing to store/)
    await handle.session.closeFile()
  })
})

describe('identity of the open agent', () => {
  it('with no file open answers what embedded answers without a workspace, and calls nothing', async () => {
    await handle.session.closeFile()
    expect(await invoke(IPC.IDENTITY_GET, { purpose: 'x' })).toBeNull()
    expect(await invoke(IPC.IDENTITY_REVEAL, { purpose: 'x' })).toEqual({ value: null })
    expect(await invoke(IPC.IDENTITY_LIST, {})).toEqual([])
    expect(await invoke(IPC.IDENTITY_DELETE_PREFIX, { prefix: 'x' })).toBe(0)
    expect(await invoke(IPC.IDENTITY_PASSWORD_CHECK)).toEqual({ needsPassword: false })
    expect(await invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'p' })).toEqual({ success: false, error: 'No ADF open' })
    expect(await invoke(IPC.IDENTITY_ENVELOPE_STATUS)).toEqual({ success: false, error: 'No ADF open' })
    expect(await invoke(IPC.IDENTITY_SET, { purpose: 'x', value: 'y' })).toEqual({ error: 'No ADF open' })
    expect(daemon.requests).toEqual([])
  })

  it('a file whose agent the daemon does not have open fails visibly (W2-B)', async () => {
    await handle.session.openFile(FILE, async () => null)
    await expect(invoke(IPC.IDENTITY_GET_DID)).rejects.toMatchObject({ code: 'daemon_mode_unavailable', message: expect.stringContaining('W2-B') })
    await handle.session.closeFile()
  })

  it('unlock keeps the key in the daemon and maps a wrong password as embedded does', async () => {
    await handle.session.openFile(FILE, async () => AGENT)
    daemon.routes.set(`POST /agents/${AGENT}/identity/password/unlock`, ({ body }) => ((body as { password: string }).password === 'right'
      ? { agentId: AGENT, success: true }
      : { status: 403, body: { error: 'Wrong password', code: 'wrong_password' } }))
    expect(await invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'wrong' })).toEqual({ success: false, error: 'Wrong password' })
    expect(handle.session.isUnlocked(FILE)).toBe(false)
    expect(await invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'right' })).toEqual({ success: true, converted: false })
    expect(handle.session.isUnlocked(FILE)).toBe(true)
    daemon.routes.set(`DELETE /agents/${AGENT}/identity/password`, () => locked('locked'))
    expect(await invoke(IPC.IDENTITY_PASSWORD_REMOVE)).toEqual({ success: false, error: 'Not unlocked' })
    await handle.session.closeFile()
  })
})

describe('owner identity (§5.4)', () => {
  const settings = {
    legacyOwnerDids: ['did:key:old-owner'],
    legacyRuntimeDids: ['did:key:old-studio-runtime'],
    daemonLegacyRuntimeDids: ['did:key:old-daemon-runtime'],
    runtimeDelegation: fixture.runtimeDelegation,
    daemonRuntimeDelegation: { ...(fixture.runtimeDelegation as object), signature: 'not-valid' },
  }
  const runtime = (state: string) => ({
    state,
    source: state === 'adopted' ? 'studio' : 'daemon',
    reason: state === 'rejected' ? 'owner_mismatch' : null,
    daemonRuntimeDid: 'did:key:daemon-own',
    daemonEncPublicKey: null,
    message: `runtime ${state}`,
  })
  const identity = (status: string, state = 'adopted', storage = 'keychain') => ({
    status,
    ownerDid: status === 'none' ? null : fixture.ownerDid,
    runtimeDid: state === 'adopted' ? fixture.runtimeDid : 'did:key:daemon-own',
    runtime: runtime(state),
    storage,
    backupConfirmed: false,
    passphraseRequired: status === 'locked',
    message: 'x',
  })
  const statusFor = async (id: ReturnType<typeof identity>) => {
    // A body with a `status` field goes in a full answer (the fake reads a bare `status` as the HTTP status).
    daemon.routes.set('GET /identity', () => ({ status: 200, body: id }))
    daemon.routes.set('GET /settings', () => ({ filePath: join(dir, 'adf-settings.json'), settings }))
    return invoke(IPC.IDENTITY_OWNER_STATUS) as Promise<Record<string, unknown>>
  }

  it('ready + adopted runtime: the shape of Studio\'s getStatus, with Studio\'s runtime and a valid delegation', async () => {
    expect(await statusFor(identity('ready'))).toEqual({
      ownerDid: fixture.ownerDid,
      runtimeDid: fixture.runtimeDid,
      hasMnemonic: true,
      mnemonicLocked: false,
      restoreRequired: false,
      backupConfirmed: false,
      legacyOwnerDids: ['did:key:old-owner'],
      legacyRuntimeDids: ['did:key:old-studio-runtime'],
      safeStorageAvailable: true,
      runtimeDelegation: fixture.runtimeDelegation,
      runtimeDelegationValid: true,
    })
  })

  it('a runtime the daemon did not adopt: its own runtime DID, delegation and legacy DIDs, and the reason logged', async () => {
    const s = await statusFor(identity('ready', 'rejected'))
    expect(s).toMatchObject({ runtimeDid: 'did:key:daemon-own', legacyRuntimeDids: ['did:key:old-daemon-runtime'], runtimeDelegationValid: false })
    expect(logs.some((l) => l.includes('own runtime (rejected: owner_mismatch): runtime rejected'))).toBe(true)
  })

  it('each daemon identity status maps onto the panel', async () => {
    expect(await statusFor(identity('none'))).toMatchObject({ ownerDid: '', hasMnemonic: false, mnemonicLocked: false, restoreRequired: false })
    expect(await statusFor(identity('locked', 'unavailable', 'file'))).toMatchObject({ hasMnemonic: false, mnemonicLocked: true, restoreRequired: false })
    expect(await statusFor(identity('restore-needed'))).toMatchObject({ hasMnemonic: false, mnemonicLocked: false, restoreRequired: true })
    // File storage: the phrase is not in the keychain, so Studio cannot show it.
    expect(await statusFor(identity('ready', 'unavailable', 'file'))).toMatchObject({ hasMnemonic: false })
  })

  it('reveal reads the shared keychain entry, never a route; another owner\'s phrase is not shown', async () => {
    daemon.routes.set('GET /identity', () => ({ status: 200, body: identity('ready') }))
    keychain = PHRASE
    expect(await invoke(IPC.IDENTITY_OWNER_REVEAL_MNEMONIC)).toEqual({ mnemonic: PHRASE })
    expect(daemon.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /identity'])
    keychain = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    expect(await invoke(IPC.IDENTITY_OWNER_REVEAL_MNEMONIC)).toEqual({ mnemonic: null })
    keychain = null
    expect(await invoke(IPC.IDENTITY_OWNER_REVEAL_MNEMONIC)).toEqual({ mnemonic: null })
    keychain = PHRASE
  })

  it('import sends this machine\'s local proof and switches owners unless restoring', async () => {
    const settingsDir = join(dir, 'daemon-settings')
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(join(settingsDir, 'adf-settings.json'), '{}')
    const { proof } = mintLocalProof(settingsDir, 47391)
    daemon.routes.set('GET /settings', () => ({ filePath: join(settingsDir, 'adf-settings.json'), settings: {} }))
    daemon.routes.set('POST /identity/import', () => ({ ownerDid: fixture.ownerDid, restamp: { restamped: 2, attested: 1, failures: [] } }))
    expect(await invoke(IPC.IDENTITY_OWNER_IMPORT, `  ${PHRASE.toUpperCase()} `)).toEqual({ success: true, ownerDid: fixture.ownerDid, restamped: 2, attested: 1, failures: [] })
    const sent = requests('POST', '/identity/import')[0]
    expect(sent.headers[LOCAL_PROOF_HEADER]).toBe(proof)
    expect(sent.body).toEqual({ mnemonic: PHRASE, switchOwner: true })

    // Restore: only the owner on record; another phrase is refused before the daemon is asked.
    daemon.requests.length = 0
    expect(await invoke(IPC.IDENTITY_OWNER_IMPORT, PHRASE, fixture.ownerDid)).toMatchObject({ success: true })
    expect(requests('POST', '/identity/import')[0].body).toEqual({ mnemonic: PHRASE })
    const other = await invoke(IPC.IDENTITY_OWNER_IMPORT, PHRASE, 'did:key:someone-else') as { success: boolean; error: string }
    expect(other.success).toBe(false)
    expect(other.error).toContain('not this machine\'s owner did:key:someone-else')
    expect(await invoke(IPC.IDENTITY_OWNER_IMPORT, 'not a phrase')).toEqual({ success: false, error: 'Invalid mnemonic phrase' })
  })
})

describe('models and subscription sign-in', () => {
  it('MODELS_LIST says "not found in settings" as embedded does, and drops the daemon\'s extra field', async () => {
    daemon.routes.set('GET /runtime/models', ({ query }) => ({ provider: query.provider, models: [], error: `Provider "${query.provider}" not found.` }))
    expect(await invoke(IPC.MODELS_LIST, { provider: 'nope' })).toEqual({ models: [], error: 'Provider "nope" not found in settings.' })
    daemon.routes.set('GET /runtime/models', ({ query }) => ({ provider: query.provider, models: ['m1'] }))
    expect(await invoke(IPC.MODELS_LIST, { provider: 'p1' })).toEqual({ models: ['m1'] })
  })

  it('ChatGPT: relay sign-in; the callback lands on this machine and only the code reaches the daemon', async () => {
    let redirectUri = ''
    daemon.routes.set('POST /auth/chatgpt/start', ({ body }) => {
      redirectUri = (body as { redirectUri: string }).redirectUri
      expect(body).toMatchObject({ mode: 'relay' })
      // The browser comes back to Studio's callback server.
      setTimeout(() => { void fetch(`${redirectUri}?code=the-code&state=s1`).catch(() => {}) }, 20)
      return { started: true, mode: 'relay', flowId: 'f1', authUrl: 'https://auth.openai.com/oauth/authorize?x=1', state: 's1', expiresAt: Date.now() + 60_000 }
    })
    daemon.routes.set('POST /auth/chatgpt/complete', () => ({ status: 200, body: { success: true, status: { authenticated: true } } }))
    expect(await invoke(IPC.CHATGPT_AUTH_START)).toEqual({ success: true })
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
    expect(electronStub.calls.filter((c) => c.api === 'shell.openExternal').map((c) => c.args[0])).toEqual(['https://auth.openai.com/oauth/authorize?x=1'])
    expect(requests('POST', '/auth/chatgpt/complete')[0].body).toEqual({ flowId: 'f1', code: 'the-code', state: 's1' })
  })

  it('Grok: the approval page opens in this machine\'s browser', async () => {
    daemon.routes.set('POST /auth/grok/start', () => ({ started: true, userCode: 'ABCD', verificationUri: 'https://x.ai/device', verificationUriComplete: 'https://x.ai/device?c=ABCD', expiresIn: 600 }))
    expect(await invoke(IPC.GROK_AUTH_START)).toEqual({ success: true, userCode: 'ABCD', verificationUri: 'https://x.ai/device', verificationUriComplete: 'https://x.ai/device?c=ABCD', expiresIn: 600 })
    expect(electronStub.calls.filter((c) => c.api === 'shell.openExternal').map((c) => c.args[0])).toEqual(['https://x.ai/device?c=ABCD'])
  })

  it('Claude: "not installed" in embedded words in local mode; status errors keep the embedded shape', async () => {
    daemon.routes.set('POST /auth/claude/start', () => ({ status: 409, body: { error: 'Claude Code is not installed on the daemon host.', code: 'claude_code_not_installed', installUrl: 'https://claude.com/code' } }))
    expect(await invoke(IPC.CLAUDE_AUTH_START)).toEqual({ success: false, error: 'Claude Code is not installed. Install it (https://claude.com/code), then sign in with Claude.' })
    daemon.routes.set('GET /auth/claude/status', () => ({ status: 500, body: { error: 'boom' } }))
    expect(await invoke(IPC.CLAUDE_AUTH_STATUS, { recheck: true })).toEqual({ authenticated: false, installed: true, version: '', flowError: 'boom' })
    expect(requests('GET', '/auth/claude/status')[0].query).toEqual({ recheck: '1' })
  })
})
