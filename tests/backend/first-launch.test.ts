/**
 * The first launch of the release that made Local daemon the default (W5-I,
 * owner decision 2026-10-16): a 0.7.x-shaped user data folder (no
 * studio-backend.json) upgrades to Local daemon, the handover moves what
 * Studio held, and one notice says so over the window once the daemon
 * connected. A fresh install sees no dialog. An unusable studio-backend.json
 * is asked about before anything moves; an older daemon on the port makes
 * the first launch Embedded for one session, with nothing moved.
 *
 * The handover is the real one (handover.ts) on an in-memory keychain that
 * was never used; Studio's safeStorage is a fake codec. Never touches the
 * real keychain.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  responses: [] as number[],
  dialogs: [] as Array<{ parent: unknown; message: string; detail: string; buttons: string[]; type?: string }>,
  opened: [] as string[],
  notifications: [] as string[],
  beforeQuit: [] as Array<() => void>,
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.8.0', isPackaged: false, relaunch: () => {}, quit: () => {},
    once: (event: string, fn: () => void) => { if (event === 'before-quit') h.beforeQuit.push(fn) },
  },
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
  DEFAULT_SWITCH_FILE,
  guardBoot,
  oldDaemonProblem,
  PENDING_NOTICE_FILE,
  settleDefaultBackend,
  showBootNotices,
  UPGRADE_GUIDE_URL,
} = await import('../../src/main/backend/first-launch')
const { CLIENT_API_VERSION } = await import('../../src/main/daemon/routes/meta-routes')
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
import type { HandoverDeps, HandoverReport, StudioSecretCodec } from '../../src/main/backend/handover'
import type { BootGuardDeps } from '../../src/main/backend/first-launch'
import type { BrowserWindow, MessageBoxOptions } from 'electron'

const studioCodec: StudioSecretCodec = {
  available: () => true,
  encrypt: (plain) => 'safe:' + Buffer.from(`studio-safe:${plain}`).toString('base64'),
  decrypt: (stored) => {
    if (!stored.startsWith('safe:')) return null
    const text = Buffer.from(stored.slice(5), 'base64').toString('utf-8')
    return text.startsWith('studio-safe:') ? text.slice('studio-safe:'.length) : null
  },
}

const WINDOW = { id: 'main-window', isDestroyed: () => false } as unknown as BrowserWindow
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

type Detection = Awaited<ReturnType<NonNullable<BootGuardDeps['detectDaemon']>>>
const absent = async (): Promise<Detection> => ({ state: 'absent' })

/** One Studio boot as main/index.ts runs it: resolve, guard, handover, settle. */
async function boot(opts: { keychain?: boolean; detect?: () => Promise<Detection>; answer?: number } = {}) {
  const backend = resolveBootBackend(backendConfigPath(dir), {}, { log: quiet, warn: quiet })
  const asked: MessageBoxOptions[] = []
  const guard = await guardBoot(backend, dir, {
    detectDaemon: opts.detect ?? absent,
    ask: async (_waitingOn, options) => { asked.push(options); return { response: opts.answer ?? 0 } },
    log: quiet,
  })
  const sessionOnly = backend.source === 'env' || backend.source === 'session'
  const deps: HandoverDeps = {
    userDataDir: dir,
    settingsPath,
    studioSecrets: studioCodec,
    daemonCipher: { encrypt: encryptCredential, decrypt: (raw) => decryptCredential(raw, '[test]') },
    daemonSecrets: opts.keychain === false ? null : keychain.backend,
    daemonSecretsUnavailable: opts.keychain === false ? 'no OS keychain is available (Linux without a Secret Service)' : undefined,
    log: quiet,
  }
  const report: HandoverReport | null = guard.skipHandover ? null : await runHandover(backend.mode as 'local' | 'embedded', deps, { sessionOnly })
  const notice = await settleDefaultBackend(backend, dir, report, { version: '0.8.0', log: quiet })
  return { backend, guard, asked, report, notice }
}

const show = (b: Awaited<ReturnType<typeof boot>>, ready?: Promise<boolean>) =>
  showBootNotices({ report: b.report, mode: b.backend.mode, notice: b.notice, guard: b.guard.notice, window: WINDOW, ready: ready ?? Promise.resolve(true), userDataDir: dir, log: quiet })

describe('fresh install', () => {
  it('boots Local daemon, saves it, and shows no dialog', async () => {
    const first = await boot()
    expect(first.backend).toMatchObject({ mode: 'local', source: 'default' })
    expect(first.report).toMatchObject({ changed: false, failed: false })
    expect(first.notice).toBeNull()
    expect(readJson(backendConfigPath(dir))).toMatchObject({ v: 1, mode: 'local' })
    expect(existsSync(join(dir, PENDING_NOTICE_FILE))).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
    await show(first)
    expect(h.dialogs).toEqual([])
    expect(first.backend.defaultSwitch).toBeNull()
    const second = await boot()
    expect(second.backend.source).toBe('file')
    expect(second.notice).toBeNull()
  })
})

describe('upgrade from 0.7.x', () => {
  it('moves what Studio held into the daemon on a keychain never used, and says so once the daemon connected', async () => {
    const { phrase } = write07xUserData({ chatgpt: 'acct-1' })
    const first = await boot()
    expect(first.backend).toMatchObject({ mode: 'local', source: 'default' })
    expect(first.report?.failed).toBe(false)
    // K12 adoption on an empty keychain: the runtime entry and the owner phrase are written.
    expect(keychain.backend.get(studioRuntimeAccount(studioRuntimeScope(settingsPath)))).not.toBeNull()
    expect(keychain.backend.get(OWNER_MNEMONIC_ACCOUNT)).toBe(phrase)
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(false)
    expect(createSubscriptionTokenStore('chatgpt-subscription').readTokens()).toMatchObject({ account_id: 'acct-1' })
    expect(readJson(settingsPath)).not.toHaveProperty(MCP_OAUTH_SETTINGS_KEY)
    expect(readJson(settingsPath).trackedDirectories).toEqual(['C:/agents'])
    expect(readJson(join(dir, 'studio-client-settings.json'))).toMatchObject({ theme: 'dark', recentFiles: [AGENT_1] })
    expect(readJson(backendConfigPath(dir))).toMatchObject({ mode: 'local' })
    expect(first.notice?.record.moved).toEqual(['Client settings', 'Owner phrase', 'Runtime identity', 'ChatGPT session', 'MCP sign-ins'])
    // Pending until shown: the shown-record is not written yet.
    expect(existsSync(join(dir, PENDING_NOTICE_FILE))).toBe(true)
    expect(existsSync(join(dir, DEFAULT_SWITCH_FILE))).toBe(false)
    expect(first.backend.defaultSwitch).toEqual(first.notice?.record)

    // Not before the daemon connected.
    let connect!: (ok: boolean) => void
    const ready = new Promise<boolean>((r) => { connect = r })
    h.responses.push(1)
    const shown = show(first, ready)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.dialogs).toEqual([])
    connect(true)
    await shown
    expect(h.dialogs).toHaveLength(1)
    const [dialog1] = h.dialogs
    expect(dialog1.parent).toBe(WINDOW)
    expect(dialog1.message).toBe('Agents now run in a background service on this computer (the ADF daemon).')
    expect(dialog1.detail).toMatch(/^Moved: Client settings, Owner phrase, Runtime identity, ChatGPT session, MCP sign-ins\./)
    expect(dialog1.detail).toMatch(/Agents set to start automatically now start in the daemon/)
    expect(dialog1.detail).toMatch(/Settings → Backend has the details\.$/)
    expect(dialog1.buttons).toEqual(['OK', 'Open the Guide'])
    expect(h.opened).toEqual([UPGRADE_GUIDE_URL])
    expect(readJson(join(dir, DEFAULT_SWITCH_FILE))).toMatchObject({ from: 'embedded', to: 'local', version: '0.8.0', moved: first.notice!.record.moved, shownAt: expect.any(String) })
    expect(existsSync(join(dir, PENDING_NOTICE_FILE))).toBe(false)

    // The next launch: an explicit file, nothing to move, no dialog; Settings → Backend still has the record.
    h.dialogs.length = 0
    const second = await boot()
    expect(second.backend).toMatchObject({ mode: 'local', source: 'file' })
    expect(second.report).toMatchObject({ changed: false, failed: false })
    expect(second.notice).toBeNull()
    expect(second.backend.defaultSwitch).toMatchObject({ moved: first.notice!.record.moved })
    await show(second)
    expect(h.dialogs).toEqual([])
  })

  it('Studio quit before the notice was shown: the next launch shows it, with what the first launch moved', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    const first = await boot()
    expect(first.notice?.record.moved).toContain('ChatGPT session')
    // No showBootNotices: Studio quit. The next launch reads the saved file, moves nothing, and still owes the notice.
    const second = await boot()
    expect(second.backend.source).toBe('file')
    expect(second.report?.changed).toBe(false)
    expect(second.notice?.record.moved).toEqual(first.notice?.record.moved)
    await show(second)
    expect(h.dialogs.map((d) => d.message)).toEqual(['Agents now run in a background service on this computer (the ADF daemon).'])
    expect(existsSync(join(dir, DEFAULT_SWITCH_FILE))).toBe(true)
    h.dialogs.length = 0
    expect((await boot()).notice).toBeNull()
  })

  it('Studio quitting or restarting (e.g. "Run Inside Studio for This Session"): no notice, and it stays pending', async () => {
    write07xUserData({ identity: false })
    const first = await boot()
    await showBootNotices({ report: first.report, mode: 'local', notice: first.notice, guard: null, window: WINDOW, ready: Promise.resolve(false), userDataDir: dir, log: quiet, quitting: () => true })
    expect(h.dialogs).toEqual([])
    expect(existsSync(join(dir, DEFAULT_SWITCH_FILE))).toBe(false)
    expect(existsSync(join(dir, PENDING_NOTICE_FILE))).toBe(true)
    expect((await boot()).notice?.record.moved).toEqual(first.notice?.record.moved)
  })

  it('a pending notice merges this launch\'s handover: moved adds up, and "not done" is the current state', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    // The first launch cannot move the sign-ins: its handover record is unreadable.
    writeFileSync(join(dir, 'studio-handover.json'), '{')
    const first = await boot()
    expect(first.notice?.record.moved).toEqual(['Client settings'])
    expect(first.notice?.record.notDone).toEqual([expect.stringMatching(/^Sign-ins: not moved/)])
    // Studio quit before the notice. The record is fixed; the next launch moves the session.
    unlinkSync(join(dir, 'studio-handover.json'))
    const second = await boot()
    expect(second.report?.items.find((i) => i.id === 'chatgpt')).toMatchObject({ outcome: 'moved' })
    expect(second.notice?.record).toMatchObject({ moved: ['Client settings', 'ChatGPT session', 'MCP sign-ins'], notDone: [] })
    expect(readJson(join(dir, PENDING_NOTICE_FILE))).toMatchObject({ record: { moved: ['Client settings', 'ChatGPT session', 'MCP sign-ins'], notDone: [] } })
    // One dialog for both: the notice stands in for this launch's summary.
    await show(second)
    expect(h.dialogs.map((d) => d.message)).toEqual(['Agents now run in a background service on this computer (the ADF daemon).'])
    expect(h.dialogs[0].detail).toMatch(/^Moved: Client settings, ChatGPT session, MCP sign-ins\./)
    expect(h.dialogs[0].detail).not.toMatch(/Not done yet/)
  })

  it('the daemon could not be reached: the notice says so instead of promising running agents', async () => {
    write07xUserData({ identity: false })
    const first = await boot()
    await show(first, Promise.resolve(false))
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0].message).toBe('Agents now run in a background service on this computer (the ADF daemon), but Studio could not connect to it.')
    expect(h.dialogs[0].detail).toMatch(/Studio could not connect to the ADF daemon, so no agent runs yet/)
    expect(h.dialogs[0].detail).not.toMatch(/now start in the daemon/)
    expect(h.dialogs[0].type).toBe('warning')
  })

  it('without a keychain the daemon can read (K12): the identity stays in Studio and the notice says what that means', async () => {
    write07xUserData()
    const first = await boot({ keychain: false })
    expect(first.report?.failed).toBe(false)
    expect(first.notice?.identityNotShared).toBe(true)
    await show(first)
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0].detail).toMatch(/Stays in Studio: Runtime identity \(no OS keychain is available/)
    expect(h.dialogs[0].detail).toMatch(/MCP sign-ins \(left in Studio/)
    expect(h.dialogs[0].detail).toMatch(/adf identity trust-daemon/)
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
    const b = await boot()
    expect(b.backend).toMatchObject({ mode: 'embedded', source: 'file' })
    expect(b.asked).toEqual([])
    expect(b.notice).toBeNull()
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(true)
    expect(readJson(backendConfigPath(dir))).toEqual({ v: 1, mode: 'embedded' })
  })
})

describe('an unusable studio-backend.json', () => {
  it('a corrupt file: asked before anything moves; the answer is saved, then the handover runs for it', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    writeFileSync(backendConfigPath(dir), '{ not json')
    const b = await boot({ answer: 1 })
    expect(b.asked).toHaveLength(1)
    expect(b.asked[0].detail).toContain(backendConfigPath(dir))
    expect(b.asked[0].detail).toMatch(/could not be parsed and was moved to .*corrupt/)
    expect(b.asked[0].buttons).toEqual(['Run on This Computer (Recommended)', 'Run Inside Studio (Legacy)'])
    expect(b.backend).toMatchObject({ mode: 'embedded', source: 'file', fileProblem: null })
    expect(readJson(backendConfigPath(dir))).toMatchObject({ mode: 'embedded' })
    // Embedded: Studio's sign-in stays with Studio.
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(true)
    expect(b.notice).toBeNull()
  })

  it('an unknown mode, answered Local daemon: saved, and the handover moves the sign-ins', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    writeFileSync(backendConfigPath(dir), JSON.stringify({ v: 1, mode: 'hybrid' }))
    const b = await boot({ answer: 0 })
    expect(b.asked[0].detail).toMatch(/names the unknown mode "hybrid"/)
    expect(b.backend).toMatchObject({ mode: 'local', source: 'file' })
    expect(readJson(backendConfigPath(dir))).toMatchObject({ mode: 'local' })
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(false)
  })

  it('a file Studio cannot read or replace (EACCES-like): the path, the error and the fix; this launch only, and no sign-in moves', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    mkdirSync(backendConfigPath(dir)) // readFileSync fails (EISDIR), as for EACCES: writeBlocked
    const b = await boot({ answer: 0 })
    expect(b.asked).toHaveLength(1)
    expect(b.asked[0].detail).toContain(backendConfigPath(dir))
    expect(b.asked[0].detail).toMatch(/could not be read \(EISDIR\)/)
    expect(b.asked[0].detail).toMatch(/Fix its permissions or delete it, then restart Studio/)
    expect(b.asked[0].buttons).toEqual(['Run on This Computer for This Launch', 'Run Inside Studio for This Launch'])
    expect(b.backend).toMatchObject({ mode: 'local', source: 'session', sessionReason: expect.stringContaining(backendConfigPath(dir)) })
    // Session-only: client keys follow, credentials stay.
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(true)
    expect(b.notice).toBeNull()
  })
})

describe('an older ADF daemon on the port at the first launch', () => {
  it('unidentified (no /version): no handover, nothing saved, Embedded for this session without the boot autostart, and the dialog over the window', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    const b = await boot({ detect: async () => ({ state: 'unidentified', status: 404, message: 'A daemon is running on port 7385 but has no GET /version; it is an older ADF build.' }) })
    expect(b.guard.skipHandover).toBe(true)
    expect(b.guard.skipAutostart).toMatch(/older ADF daemon/)
    expect(b.backend).toMatchObject({ mode: 'embedded', source: 'session' })
    expect(b.report).toBeNull()
    expect(existsSync(backendConfigPath(dir))).toBe(false)
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(true)
    expect(existsSync(join(dir, 'studio-handover.json'))).toBe(false)
    expect(b.notice).toBeNull()
    await show(b)
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0]).toMatchObject({ parent: WINDOW, message: expect.stringMatching(/^An ADF daemon that Studio cannot identify is running on port 7385/) })
    expect(h.dialogs[0].detail).toMatch(/^Stop it with `adf daemon stop`, update the CLI \(`npm i -g @agentdocumentformat\/cli@latest`\), then restart Studio\./)
    expect(h.dialogs[0].detail).toMatch(/Studio did not autostart your agents: that daemon may be running them\./)
    expect(h.dialogs[0].detail).toMatch(/stop it there \(`adf stop <name>`\), then press Start in Studio\./)
  })

  it('an older client API on the same settings: named with its version and starter', () => {
    const info = { version: '0.7.8', clientApiVersion: 1, settingsPath, dataDir: dir, runtimeId: null, pid: 4242, startedBy: 'cli' as const }
    expect(oldDaemonProblem({ state: 'running', info }, settingsPath, 7385)).toBe('An older ADF daemon (adf 0.7.8, started by the npm CLI) is running and uses the same settings.')
    // This Studio's client API, or nothing on the port: no problem; the connector attaches or starts one.
    expect(oldDaemonProblem({ state: 'running', info: { ...info, clientApiVersion: CLIENT_API_VERSION } }, settingsPath, 7385)).toBeNull()
    expect(oldDaemonProblem({ state: 'absent' }, settingsPath, 7385)).toBeNull()
  })

  it('a current daemon on the port: the first launch hands over as usual', async () => {
    write07xUserData({ identity: false, chatgpt: 'acct-1' })
    const info = { version: '0.8.0', clientApiVersion: CLIENT_API_VERSION, settingsPath, dataDir: dir, runtimeId: null, pid: 4242, startedBy: 'cli' as const }
    const b = await boot({ detect: async () => ({ state: 'running', info }) })
    expect(b.guard.skipHandover).toBe(false)
    expect(b.backend).toMatchObject({ mode: 'local', source: 'default' })
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(false)
  })
})

// Last: the quit seen here stays seen for this module (as in a quitting Studio).
describe('app before-quit', () => {
  it('a quit that started before the notice keeps it pending', async () => {
    write07xUserData({ identity: false })
    const first = await boot()
    expect(h.beforeQuit).toHaveLength(1)
    for (const fn of h.beforeQuit) fn()
    await show(first)
    expect(h.dialogs).toEqual([])
    expect(existsSync(join(dir, PENDING_NOTICE_FILE))).toBe(true)
    expect(existsSync(join(dir, DEFAULT_SWITCH_FILE))).toBe(false)
  })
})

describe('reading its own JSON files', () => {
  it('strips a leading byte order mark (a file saved by a Windows editor)', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'adf-first-launch-bom-'))
    const record = { v: 1, from: 'embedded', to: 'local', at: '2026-10-16T00:00:00.000Z', version: '0.8.0', moved: ['Client settings'], notDone: [], shownAt: '2026-10-16T00:00:01.000Z' }
    writeFileSync(join(userData, DEFAULT_SWITCH_FILE), String.fromCharCode(0xfeff) + JSON.stringify(record))
    const backend = { mode: 'local', source: 'file' } as Parameters<typeof settleDefaultBackend>[0]
    expect(await settleDefaultBackend(backend, userData, null, { version: '0.8.0', log: quiet })).toBeNull()
    expect(backend.defaultSwitch).toEqual({ at: record.at, version: '0.8.0', moved: ['Client settings'], notDone: [] })
  })
})
