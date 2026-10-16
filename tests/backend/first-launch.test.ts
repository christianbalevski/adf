/**
 * The first launch of the release that made Local daemon the default (W5-I,
 * owner decision 2026-10-16): a 0.7.x-shaped user data folder (no
 * studio-backend.json) upgrades to Local daemon, the handover moves what
 * Studio held, one notice says so over the window, and nothing asks before
 * the window exists. A fresh install sees no dialog.
 *
 * The handover is the real one (handover.ts) on an in-memory keychain that
 * was never used; Studio's safeStorage is a fake codec. Never touches the
 * real keychain.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  responses: [] as number[],
  dialogs: [] as Array<{ parent: unknown; message: string; detail: string; buttons: string[]; type?: string }>,
  opened: [] as string[],
  notifications: [] as string[],
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.8.0', isPackaged: false, relaunch: () => {}, quit: () => {} },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message: string; detail: string; buttons: string[]; type?: string }
      h.dialogs.push({ parent: args.length > 1 ? args[0] : null, ...opts })
      return { response: h.responses.shift() ?? 0 }
    },
  },
  shell: { openExternal: async (url: string) => { h.opened.push(url) } },
  Notification: class {
    static isSupported() { return true }
    constructor(readonly options: { body: string }) { h.notifications.push(options.body) }
    show() {}
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

process.env.ADF_KEYCHAIN = '0'

const { backendConfigPath, resolveBootBackend } = await import('../../src/main/backend/backend-config')
const { runHandover } = await import('../../src/main/backend/handover')
const { resumeSwitchedAgents } = await import('../../src/main/backend/mode-switch')
const {
  bootSessionChooser,
  DEFAULT_SWITCH_FILE,
  SESSION_CHOICE_FILE,
  settleDefaultBackend,
  showBootNotices,
  UPGRADE_GUIDE_URL,
} = await import('../../src/main/backend/first-launch')
const { decryptCredential, encryptCredential, resetCredentialKeyCache } = await import('../../src/main/utils/credential-cipher')
const { createSubscriptionTokenStore } = await import('../../src/main/providers/subscription-token-store')
const { MCP_OAUTH_SETTINGS_KEY } = await import('../../src/main/services/mcp-oauth-store')
const { OWNER_MNEMONIC_ACCOUNT } = await import('../../src/main/services/owner-secret-store')
const { studioRuntimeAccount, studioRuntimeScope } = await import('../../src/main/daemon/studio-runtime-entry')
const { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } = await import('../../src/main/crypto/identity-crypto')
const { generateX25519KeyPair, extractRawX25519PublicKey } = await import('../../src/main/crypto/envelope-crypto')
const { deriveOwnerIdentity, generateMnemonic } = await import('../../src/main/crypto/mnemonic-identity')
const { createAttestation } = await import('../../src/main/services/attestation.service')
const { fakeKeychain } = await import('../helpers/studio-runtime-entry')
import type { HandoverDeps, HandoverReport, SessionConflict, StudioSecretCodec } from '../../src/main/backend/handover'
import type { BrowserWindow } from 'electron'

const studioCodec: StudioSecretCodec = {
  available: () => true,
  encrypt: (plain) => 'safe:' + Buffer.from(`studio-safe:${plain}`).toString('base64'),
  decrypt: (stored) => {
    if (!stored.startsWith('safe:')) return null
    const text = Buffer.from(stored.slice(5), 'base64').toString('utf-8')
    return text.startsWith('studio-safe:') ? text.slice('studio-safe:'.length) : null
  },
}

const WINDOW = { id: 'main-window' } as unknown as BrowserWindow
const AGENT_1 = 'C:/agents/agent-1.adf'
const quiet = () => {}

let dir: string
let settingsPath: string
let keychain: ReturnType<typeof fakeKeychain>
const previousUserData = process.env.ADF_USER_DATA_DIR

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-first-launch-'))
  settingsPath = join(dir, 'adf-settings.json')
  process.env.ADF_USER_DATA_DIR = dir
  resetCredentialKeyCache()
  keychain = fakeKeychain()
  h.responses.length = 0
  h.dialogs.length = 0
  h.opened.length = 0
  h.notifications.length = 0
})

afterEach(() => {
  process.env.ADF_USER_DATA_DIR = previousUserData
  resetCredentialKeyCache()
})

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

const session = (account: string) => ({ access_token: `at-${account}`, refresh_token: `rt-${account}`, expires_at: Date.now() + 3_600_000, account_id: account })

/** A user data folder as Studio 0.7.x leaves it: settings with client keys, identity, MCP sign-in, a ChatGPT session; no studio-backend.json. */
function write07xUserData(opts: { identity?: boolean; chatgpt?: string } = {}): { phrase: string } {
  const phrase = generateMnemonic()
  const settings: Record<string, unknown> = {
    theme: 'dark',
    recentFiles: [AGENT_1],
    trackedDirectories: ['C:/agents'],
    providers: [{ id: 'p1' }],
    [MCP_OAUTH_SETTINGS_KEY]: studioCodec.encrypt(JSON.stringify({ 'https://mcp.example.com/mcp': { serverUrl: 'https://mcp.example.com/mcp', tokens: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' }, updatedAt: 1 } })),
  }
  if (opts.identity !== false) {
    const owner = deriveOwnerIdentity(phrase)
    const signing = generateEd25519KeyPair()
    const enc = generateX25519KeyPair()
    const runtimeDid = publicKeyToDid(extractRawPublicKey(signing.publicKey))
    Object.assign(settings, {
      ownerDid: owner.did,
      ownerMnemonic: studioCodec.encrypt(phrase),
      runtimeDid,
      runtimeDelegation: createAttestation({ issuer: owner.did, subject: runtimeDid, role: 'runtime', issued_at: new Date().toISOString() }, owner.privateKeyPkcs8),
      runtimePrivateKey: studioCodec.encrypt(signing.privateKey.toString('base64')),
      runtimeEncPrivateKey: studioCodec.encrypt(enc.privateKey.toString('base64')),
      runtimeEncPublicKey: extractRawX25519PublicKey(enc.publicKey).toString('base64'),
    })
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  if (opts.chatgpt) {
    mkdirSync(join(dir, 'chatgpt-subscription'), { recursive: true })
    writeFileSync(join(dir, 'chatgpt-subscription', 'auth.json'), studioCodec.encrypt(JSON.stringify(session(opts.chatgpt))))
  }
  return { phrase }
}

/** One Studio boot as main/index.ts runs it: resolve, handover (with the boot chooser), settle. */
async function boot(opts: { keychain?: boolean } = {}) {
  const backend = resolveBootBackend(backendConfigPath(dir), {}, { log: quiet, warn: quiet })
  const chooser = bootSessionChooser(dir, { defer: backend.source === 'default', log: quiet })
  const deps: HandoverDeps = {
    userDataDir: dir,
    settingsPath,
    studioSecrets: studioCodec,
    daemonCipher: { encrypt: encryptCredential, decrypt: (raw) => decryptCredential(raw, '[test]') },
    daemonSecrets: opts.keychain === false ? null : keychain.backend,
    daemonSecretsUnavailable: opts.keychain === false ? 'no OS keychain is available (Linux without a Secret Service)' : undefined,
    chooseSession: async (c: SessionConflict) => (await chooser(c)) ?? (() => { throw new Error('the windowless accounts dialog must not be asked') })(),
    log: quiet,
  }
  const report: HandoverReport = await runHandover(backend.mode as 'local', deps)
  const notice = await settleDefaultBackend(backend, dir, report, { version: '0.8.0', log: quiet })
  return { backend, report, notice }
}

describe('fresh install', () => {
  it('boots Local daemon, saves it, and shows no dialog', async () => {
    const first = await boot()
    expect(first.backend).toMatchObject({ mode: 'local', source: 'default' })
    expect(first.report).toMatchObject({ changed: false, failed: false })
    expect(first.notice).toBeNull()
    expect(readJson(backendConfigPath(dir))).toMatchObject({ v: 1, mode: 'local' })
    expect(existsSync(join(dir, DEFAULT_SWITCH_FILE))).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
    await showBootNotices({ report: first.report, mode: 'local', notice: first.notice, window: WINDOW, userDataDir: dir, log: quiet })
    expect(h.dialogs).toEqual([])
    // Settings → Backend: no default switch to report.
    expect(first.backend.defaultSwitch).toBeNull()
    const second = await boot()
    expect(second.backend.source).toBe('file')
    expect(second.notice).toBeNull()
  })
})

describe('upgrade from 0.7.x', () => {
  it('moves what Studio held into the daemon on a keychain never used, and says so once, over the window', async () => {
    const { phrase } = write07xUserData({ chatgpt: 'acct-1' })
    const first = await boot()
    expect(first.backend).toMatchObject({ mode: 'local', source: 'default' })
    expect(first.report.failed).toBe(false)
    // K12 adoption on an empty keychain: the runtime entry and the owner phrase are written.
    expect(keychain.backend.get(studioRuntimeAccount(studioRuntimeScope(settingsPath)))).not.toBeNull()
    expect(keychain.backend.get(OWNER_MNEMONIC_ACCOUNT)).toBe(phrase)
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(false)
    expect(createSubscriptionTokenStore('chatgpt-subscription').readTokens()).toMatchObject({ account_id: 'acct-1' })
    expect(readJson(settingsPath)).not.toHaveProperty(MCP_OAUTH_SETTINGS_KEY)
    // The daemon's autostart reads the same tracked folders as Studio did.
    expect(readJson(settingsPath).trackedDirectories).toEqual(['C:/agents'])
    expect(readJson(join(dir, 'studio-client-settings.json'))).toMatchObject({ theme: 'dark', recentFiles: [AGENT_1] })
    // Saved explicitly, and recorded for Settings → Backend.
    expect(readJson(backendConfigPath(dir))).toMatchObject({ mode: 'local' })
    expect(first.notice?.record.moved).toEqual(expect.arrayContaining(['Client settings', 'Owner phrase', 'Runtime identity', 'ChatGPT session', 'MCP sign-ins']))
    expect(first.notice?.record.notDone).toEqual([])
    expect(readJson(join(dir, DEFAULT_SWITCH_FILE))).toMatchObject({ v: 1, from: 'embedded', to: 'local', version: '0.8.0' })
    expect(first.backend.defaultSwitch).toEqual(first.notice?.record)

    h.responses.push(1)
    await showBootNotices({ report: first.report, mode: 'local', notice: first.notice, window: WINDOW, userDataDir: dir, log: quiet })
    expect(h.dialogs).toHaveLength(1)
    const [shown] = h.dialogs
    expect(shown.parent).toBe(WINDOW)
    expect(shown.message).toBe('Studio now runs agents in the ADF daemon.')
    expect(shown.detail).toMatch(/^Moved: Client settings, Owner phrase, Runtime identity, ChatGPT session, MCP sign-ins\./)
    expect(shown.detail).toMatch(/Settings → Backend has the details\.$/)
    expect(shown.buttons).toEqual(['OK', 'Open the Guide'])
    expect(h.opened).toEqual([UPGRADE_GUIDE_URL])

    // The next launch: an explicit file, nothing to move, no dialog; Settings → Backend still has the record.
    h.dialogs.length = 0
    const second = await boot()
    expect(second.backend).toMatchObject({ mode: 'local', source: 'file' })
    expect(second.report).toMatchObject({ changed: false, failed: false })
    expect(second.notice).toBeNull()
    expect(second.backend.defaultSwitch).toMatchObject({ moved: first.notice!.record.moved })
    await showBootNotices({ report: second.report, mode: 'local', notice: second.notice, window: WINDOW, userDataDir: dir, log: quiet })
    expect(h.dialogs).toEqual([])
  })

  it('without a keychain the daemon can read (K12): the identity stays in Studio and the notice says what that means', async () => {
    write07xUserData()
    const first = await boot({ keychain: false })
    expect(first.report.failed).toBe(false)
    expect(first.notice?.identityNotShared).toBe(true)
    await showBootNotices({ report: first.report, mode: 'local', notice: first.notice, window: WINDOW, userDataDir: dir, log: quiet })
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0].detail).toMatch(/Stays in Studio: Runtime identity \(no OS keychain is available/)
    expect(h.dialogs[0].detail).toMatch(/MCP sign-ins \(left in Studio/)
    expect(h.dialogs[0].detail).toMatch(/adf identity trust-daemon/)
  })

  it('two accounts: nothing is asked before the window; both sessions stay; the answer over the window applies at the next start', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-studio' })
    // A CLI daemon signed in on its own before the upgrade (adf auth login).
    createSubscriptionTokenStore('chatgpt-subscription').writeTokens(session('acct-daemon'))
    const first = await boot()
    const item = first.report.items.find((i) => i.id === 'chatgpt')
    expect(item).toMatchObject({ outcome: 'kept', pending: true })
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(true)
    expect(createSubscriptionTokenStore('chatgpt-subscription').readTokens()).toMatchObject({ account_id: 'acct-daemon' })
    expect(readJson(join(dir, SESSION_CHOICE_FILE))).toMatchObject({ conflicts: [{ provider: 'chatgpt', studio: 'acct-studio', daemon: 'acct-daemon', keep: null }] })
    // A deferred question is not a failure in the notice.
    expect(first.notice?.record.notDone).toEqual([])

    h.responses.push(0, 0) // the notice: OK; the question: Keep acct-studio (Studio)
    await showBootNotices({ report: first.report, mode: 'local', notice: first.notice, window: WINDOW, userDataDir: dir, log: quiet })
    expect(h.dialogs.map((d) => d.message)).toEqual([
      'Studio now runs agents in the ADF daemon.',
      'Studio and the ADF daemon are signed in to ChatGPT with different accounts.',
    ])
    expect(h.dialogs.every((d) => d.parent === WINDOW)).toBe(true)
    expect(h.dialogs[0].detail).toMatch(/Two accounts: ChatGPT session \(Studio: acct-studio, daemon: acct-daemon\)/)
    expect(h.dialogs[1].buttons).toEqual(['Keep acct-studio (Studio)', 'Keep acct-daemon (daemon)', 'Decide Later'])
    expect(readJson(join(dir, SESSION_CHOICE_FILE))).toMatchObject({ conflicts: [{ keep: 'studio' }] })

    // The next start applies it without a dialog before the window.
    h.dialogs.length = 0
    const second = await boot()
    expect(second.report.items.find((i) => i.id === 'chatgpt')).toMatchObject({ outcome: 'moved' })
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(false)
    expect(createSubscriptionTokenStore('chatgpt-subscription').readTokens()).toMatchObject({ account_id: 'acct-studio' })
    expect(readJson(join(dir, SESSION_CHOICE_FILE))).toMatchObject({ conflicts: [] })
    await showBootNotices({ report: second.report, mode: 'local', notice: second.notice, window: WINDOW, userDataDir: dir, log: quiet })
    // The summary of that move, over the window.
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0]).toMatchObject({ parent: WINDOW, message: 'Studio now runs Local daemon.' })
  })

  it('"Decide Later" keeps deferring at later starts, over the window, never in the windowless dialog', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-studio' })
    createSubscriptionTokenStore('chatgpt-subscription').writeTokens(session('acct-daemon'))
    const first = await boot()
    h.responses.push(0, 2)
    await showBootNotices({ report: first.report, mode: 'local', notice: first.notice, window: WINDOW, userDataDir: dir, log: quiet })
    h.dialogs.length = 0
    const second = await boot()
    expect(second.backend.source).toBe('file')
    expect(second.report.items.find((i) => i.id === 'chatgpt')).toMatchObject({ outcome: 'kept', pending: true })
    h.responses.push(2)
    await showBootNotices({ report: second.report, mode: 'local', notice: second.notice, window: WINDOW, userDataDir: dir, log: quiet })
    // Only the question; the summary does not report the deferred conflict as a failure.
    expect(h.dialogs.map((d) => d.message)).toEqual(['Studio and the ADF daemon are signed in to ChatGPT with different accounts.'])
  })

  it('agents that ran under 0.7.x: no switch record, so nothing is started twice; the daemon autostarts them from the same tracked folders', async () => {
    write07xUserData({ identity: false })
    await boot()
    const started: string[] = []
    await resumeSwitchedAgents('local', dir, async (filePath) => { started.push(filePath); return { success: true } })
    expect(started).toEqual([])
    expect(h.notifications).toEqual([])
    expect(readJson(settingsPath).trackedDirectories).toEqual(['C:/agents'])
  })

  it('an explicit mode: embedded is kept: no handover to local, no notice', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    writeFileSync(backendConfigPath(dir), JSON.stringify({ v: 1, mode: 'embedded' }))
    const backend = resolveBootBackend(backendConfigPath(dir), {}, { log: quiet, warn: quiet })
    expect(backend).toMatchObject({ mode: 'embedded', source: 'file' })
    expect(await settleDefaultBackend(backend, dir, null, { version: '0.8.0', log: quiet })).toBeNull()
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(true)
    expect(readJson(backendConfigPath(dir))).toEqual({ v: 1, mode: 'embedded' })
  })
})
