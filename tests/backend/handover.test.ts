/**
 * Mode-switch handover (design daemon-backend.md §11, tracker W4-A):
 * embedded → local → embedded keeps ChatGPT, Grok and app MCP OAuth
 * sessions alive against a provider whose refresh tokens rotate; every move
 * is write, verify, delete, and a crash at any point leaves a complete copy.
 *
 * Studio's safeStorage is a fake codec; the daemon side is the real code
 * (subscription-token-store under Node, credential-cipher, DaemonAppOAuthStore)
 * on an in-memory keychain. Never touches the real keychain.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handoverNeedsKeychain,
  planHandover,
  readCredentialHolder,
  runHandover,
  syncStudioRuntimeEntry,
  type HandoverDeps,
  type SessionConflict,
  type StudioSecretCodec,
} from '../../src/main/backend/handover'
import { decryptCredential, encryptCredential, resetCredentialKeyCache } from '../../src/main/utils/credential-cipher'
import { createSubscriptionTokenStore } from '../../src/main/providers/subscription-token-store'
import {
  chunkedSecretDelete,
  chunkedSecretRead,
  chunkedSecretWrite,
  DaemonAppOAuthStore,
  daemonAppOAuthAccount,
  MAX_SECRET_CHUNKS,
  MCP_OAUTH_SETTINGS_KEY,
  SECRET_CHUNK_CHARS,
  splitOnCodePoints,
} from '../../src/main/services/mcp-oauth-store'
import type { McpOAuthRecord } from '../../src/main/services/mcp-oauth.types'
import { settingsScope } from '../../src/main/services/provider-key-store'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../src/main/crypto/identity-crypto'
import { generateX25519KeyPair, extractRawX25519PublicKey } from '../../src/main/crypto/envelope-crypto'
import { deriveOwnerIdentity, generateMnemonic } from '../../src/main/crypto/mnemonic-identity'
import { createAttestation } from '../../src/main/services/attestation.service'
import { studioRuntimeAccount, studioRuntimeScope, verifyStudioRuntimeEntry } from '../../src/main/daemon/studio-runtime-entry'
import { OWNER_MNEMONIC_ACCOUNT } from '../../src/main/services/owner-secret-store'
import { fakeKeychain } from '../helpers/studio-runtime-entry'

// --- fakes --------------------------------------------------------------------

/** Studio's safeStorage stand-in: `safe:` values only this codec opens. */
const studioCodec: StudioSecretCodec = {
  available: () => true,
  encrypt: (plain) => 'safe:' + Buffer.from(`studio-safe:${plain}`).toString('base64'),
  decrypt: (stored) => {
    if (!stored.startsWith('safe:')) return null
    const text = Buffer.from(stored.slice(5), 'base64').toString('utf-8')
    return text.startsWith('studio-safe:') ? text.slice('studio-safe:'.length) : null
  },
}

/** An OAuth server whose refresh tokens rotate: each refresh token works once. */
class RotatingAuthServer {
  private live = new Map<string, string>() // subject → current refresh token
  issue(subject: string): { access_token: string; refresh_token: string; expires_at: number; account_id: string } {
    const refresh = `rt-${randomBytes(6).toString('hex')}`
    this.live.set(subject, refresh)
    return { access_token: `at-${randomBytes(6).toString('hex')}`, refresh_token: refresh, expires_at: Date.now() + 3_600_000 + this.live.size, account_id: subject }
  }
  refresh(subject: string, refreshToken: string) {
    if (this.live.get(subject) !== refreshToken) throw new Error(`invalid_grant: ${subject} refresh token was already used (session lost)`)
    return this.issue(subject)
  }
}

let dir: string
let settingsPath: string
let keychain: ReturnType<typeof fakeKeychain>
let auth: RotatingAuthServer
const previousUserData = process.env.ADF_USER_DATA_DIR

function deps(over: Partial<HandoverDeps> = {}): HandoverDeps {
  return {
    userDataDir: dir,
    settingsPath,
    studioSecrets: studioCodec,
    daemonCipher: { encrypt: encryptCredential, decrypt: (raw) => decryptCredential(raw, '[test]') },
    daemonSecrets: keychain.backend,
    log: () => {},
    ...over,
  }
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
}
function writeSettings(data: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(data, null, 2))
}

// --- the two sides of each store ---------------------------------------------------

const SUBS = [
  { name: 'ChatGPT', dir: 'chatgpt-subscription', subject: 'acct-chatgpt-1' },
  { name: 'Grok', dir: 'grok-subscription', subject: 'acct-grok-1' },
] as const

/** Studio (embedded): auth.json under safeStorage. */
function studioTokens(sub: (typeof SUBS)[number]) {
  const path = join(dir, sub.dir, 'auth.json')
  return {
    path,
    exists: () => existsSync(path),
    read: () => JSON.parse(studioCodec.decrypt(readFileSync(path, 'utf-8'))!) as ReturnType<RotatingAuthServer['issue']>,
    write: (t: object) => { mkdirSync(join(dir, sub.dir), { recursive: true }); writeFileSync(path, studioCodec.encrypt(JSON.stringify(t))) },
  }
}

/** The daemon: the real token store, which under Node uses auth.daemon.json and credential-cipher. */
function daemonTokens(sub: (typeof SUBS)[number]) {
  const store = createSubscriptionTokenStore<ReturnType<RotatingAuthServer['issue']>>(sub.dir)
  return { path: join(dir, sub.dir, 'auth.daemon.json'), read: store.readTokens, write: store.writeTokens }
}

const MCP_URL = 'https://mcp.example.com/mcp'

function studioMcp() {
  return {
    read: (): Record<string, McpOAuthRecord> => {
      const raw = readSettings()[MCP_OAUTH_SETTINGS_KEY]
      return typeof raw === 'string' ? JSON.parse(studioCodec.decrypt(raw)!) : {}
    },
    write: (blob: Record<string, McpOAuthRecord>) => writeSettings({ ...readSettings(), [MCP_OAUTH_SETTINGS_KEY]: studioCodec.encrypt(JSON.stringify(blob)) }),
  }
}
function daemonMcp(): DaemonAppOAuthStore {
  return new DaemonAppOAuthStore(keychain.backend, daemonAppOAuthAccount(settingsScope(settingsPath)))
}

function mcpRecord(tokens: ReturnType<RotatingAuthServer['issue']>): McpOAuthRecord {
  return {
    serverUrl: MCP_URL,
    tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, token_type: 'Bearer' },
    clientInformation: { client_id: 'client-1' },
    updatedAt: Date.now(),
  } as McpOAuthRecord
}

/** A Studio identity in the settings file, as SettingsService keeps it (secrets `safe:`). */
function writeStudioIdentity(extra: Record<string, unknown> = {}): { phrase: string; runtimeDid: string } {
  const phrase = generateMnemonic()
  const owner = deriveOwnerIdentity(phrase)
  const signing = generateEd25519KeyPair()
  const enc = generateX25519KeyPair()
  const runtimeDid = publicKeyToDid(extractRawPublicKey(signing.publicKey))
  writeSettings({
    ...readSettings(),
    ownerDid: owner.did,
    ownerMnemonic: studioCodec.encrypt(phrase),
    runtimeDid,
    runtimeDelegation: createAttestation({ issuer: owner.did, subject: runtimeDid, role: 'runtime', issued_at: new Date().toISOString() }, owner.privateKeyPkcs8),
    runtimePrivateKey: studioCodec.encrypt(signing.privateKey.toString('base64')),
    runtimeEncPrivateKey: studioCodec.encrypt(enc.privateKey.toString('base64')),
    runtimeEncPublicKey: extractRawX25519PublicKey(enc.publicKey).toString('base64'),
    ...extra,
  })
  return { phrase, runtimeDid }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-handover-'))
  settingsPath = join(dir, 'adf-settings.json')
  // The daemon's credential key file and token files live in this userData dir.
  process.env.ADF_USER_DATA_DIR = dir
  resetCredentialKeyCache()
  keychain = fakeKeychain()
  auth = new RotatingAuthServer()
  writeSettings({ theme: 'dark', recentFiles: ['C:/agents/agent-1.adf'], providers: [{ id: 'p1' }] })
})

afterEach(() => {
  process.env.ADF_USER_DATA_DIR = previousUserData
  resetCredentialKeyCache()
})

// --- the round trip ---------------------------------------------------------------

describe('handover round trip (embedded → local → embedded)', () => {
  it('keeps ChatGPT, Grok and MCP OAuth sessions alive with rotating refresh tokens, and moves the client keys both ways', async () => {
    const identity = writeStudioIdentity()
    // Embedded: Studio signs in and refreshes once.
    for (const sub of SUBS) {
      const studio = studioTokens(sub)
      studio.write(auth.issue(sub.subject))
      studio.write(auth.refresh(sub.subject, studio.read().refresh_token))
    }
    studioMcp().write({ [MCP_URL]: mcpRecord(auth.issue('mcp-user')) })

    // Switch to local.
    const toLocal = await runHandover('local', deps())
    expect(toLocal.failed).toBe(false)
    expect(toLocal.changed).toBe(true)
    expect(await readCredentialHolder(dir)).toBe('daemon')
    // Client keys moved, not copied.
    expect(JSON.parse(readFileSync(join(dir, 'studio-client-settings.json'), 'utf-8'))).toEqual({ theme: 'dark', recentFiles: ['C:/agents/agent-1.adf'] })
    expect(readSettings()).not.toHaveProperty('theme')
    expect(readSettings()).not.toHaveProperty('recentFiles')
    expect(readSettings().providers).toEqual([{ id: 'p1' }])
    // Exactly one copy of each session, on the daemon's side.
    for (const sub of SUBS) {
      expect(studioTokens(sub).exists()).toBe(false)
      expect(existsSync(daemonTokens(sub).path)).toBe(true)
    }
    expect(readSettings()).not.toHaveProperty(MCP_OAUTH_SETTINGS_KEY)
    // Runtime identity entry written, verifiable by the daemon.
    const account = studioRuntimeAccount(studioRuntimeScope(settingsPath))
    const entry = keychain.backend.get(account)!
    const s = readSettings()
    expect(verifyStudioRuntimeEntry(entry, { ownerDid: s.ownerDid, runtimeDid: identity.runtimeDid, runtimeEncPublicKey: s.runtimeEncPublicKey })).toMatchObject({ ok: true })
    // The owner phrase is mirrored, as embedded Studio does when a keychain exists.
    expect(keychain.backend.get(OWNER_MNEMONIC_ACCOUNT)).toBe(identity.phrase)

    // The daemon uses and refreshes them (rotating every refresh token).
    for (const sub of SUBS) {
      const daemon = daemonTokens(sub)
      daemon.write(auth.refresh(sub.subject, daemon.read()!.refresh_token))
      daemon.write(auth.refresh(sub.subject, daemon.read()!.refresh_token))
    }
    const mcp = daemonMcp()
    const before = (await mcp.get(MCP_URL))!
    await mcp.save(MCP_URL, mcpRecord(auth.refresh('mcp-user', before.tokens!.refresh_token!)))

    // A second boot in local mode moves nothing.
    expect((await runHandover('local', deps())).changed).toBe(false)

    // Switch back to embedded.
    const toEmbedded = await runHandover('embedded', deps())
    expect(toEmbedded.failed).toBe(false)
    expect(await readCredentialHolder(dir)).toBe('studio')
    expect(keychain.backend.get(account)).toBeNull()
    expect(existsSync(join(dir, 'studio-client-settings.json'))).toBe(false)
    expect(readSettings()).toMatchObject({ theme: 'dark', recentFiles: ['C:/agents/agent-1.adf'] })
    expect(mcp.listServerUrls()).toEqual([])

    // Studio refreshes every session: none was invalidated by a stale copy.
    for (const sub of SUBS) {
      const studio = studioTokens(sub)
      expect(existsSync(daemonTokens(sub).path)).toBe(false)
      expect(() => studio.write(auth.refresh(sub.subject, studio.read().refresh_token))).not.toThrow()
    }
    const back = studioMcp().read()[MCP_URL]
    expect(() => auth.refresh('mcp-user', back.tokens!.refresh_token!)).not.toThrow()
  })

  it('a copy left behind would have been signed out: the rotating fake rejects a reused refresh token', () => {
    const tokens = auth.issue('acct-1')
    auth.refresh('acct-1', tokens.refresh_token)
    expect(() => auth.refresh('acct-1', tokens.refresh_token)).toThrow(/invalid_grant/)
  })
})

// --- crash safety ---------------------------------------------------------------------

describe('crash mid-move', () => {
  it('a crash after the destination is written keeps both copies; the next start finishes the move (never zero copies)', async () => {
    const sub = SUBS[0]
    studioTokens(sub).write(auth.issue(sub.subject))
    const crashed = await runHandover('local', deps({ beforeSourceDelete: (id) => { if (id === 'chatgpt') throw new Error('simulated crash') } }))
    expect(crashed.items.find((i) => i.id === 'chatgpt')).toMatchObject({ outcome: 'failed' })
    expect(studioTokens(sub).exists()).toBe(true)
    expect(daemonTokens(sub).read()?.refresh_token).toBe(studioTokens(sub).read().refresh_token)

    const resumed = await runHandover('local', deps())
    expect(resumed.items.find((i) => i.id === 'chatgpt')).toMatchObject({ outcome: 'moved' })
    expect(studioTokens(sub).exists()).toBe(false)
    const daemon = daemonTokens(sub)
    expect(() => daemon.write(auth.refresh(sub.subject, daemon.read()!.refresh_token))).not.toThrow()
  })

  it('a crash before the client keys left adf-settings.json keeps them there, and the next start removes them', async () => {
    const crashed = await runHandover('local', deps({ beforeSourceDelete: (id) => { if (id === 'client-settings') throw new Error('simulated crash') } }))
    expect(crashed.items[0]).toMatchObject({ id: 'client-settings', outcome: 'failed' })
    expect(readSettings()).toHaveProperty('theme', 'dark')
    expect(JSON.parse(readFileSync(join(dir, 'studio-client-settings.json'), 'utf-8'))).toHaveProperty('theme', 'dark')
    await runHandover('local', deps())
    expect(readSettings()).not.toHaveProperty('theme')
  })

  it('a crash between the MCP write to the daemon and the removal from Studio keeps both; the resumed move keeps the newer record', async () => {
    const first = mcpRecord(auth.issue('mcp-user'))
    studioMcp().write({ [MCP_URL]: first })
    await runHandover('local', deps({ beforeSourceDelete: (id) => { if (id === 'mcp-oauth') throw new Error('simulated crash') } }))
    expect(studioMcp().read()[MCP_URL]).toBeDefined()
    // The daemon refreshed in between (its copy is now the only valid one).
    const refreshed = { ...mcpRecord(auth.refresh('mcp-user', first.tokens!.refresh_token!)), updatedAt: Date.now() + 1000 }
    await daemonMcp().save(MCP_URL, refreshed)
    await runHandover('local', deps())
    expect(readSettings()).not.toHaveProperty(MCP_OAUTH_SETTINGS_KEY)
    expect((await daemonMcp().get(MCP_URL))?.tokens?.refresh_token).toBe(refreshed.tokens!.refresh_token)
  })

  it('a corrupt adf-settings.json is never rewritten: the move fails and keeps it', async () => {
    writeFileSync(settingsPath, '{ not json')
    const report = await runHandover('local', deps())
    expect(report.failed).toBe(true)
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ not json')
  })
})

// --- conflicts, ownership, fallbacks -----------------------------------------------------

describe('accounts conflict and ownership', () => {
  it('both sides signed in with different accounts: the dialog names both, and the chosen one is kept', async () => {
    const sub = SUBS[0]
    studioTokens(sub).write(auth.issue('acct-studio'))
    const daemonOwn = auth.issue('acct-daemon')
    daemonTokens(sub).write(daemonOwn)
    const asked: SessionConflict[] = []
    const report = await runHandover('local', deps({ chooseSession: async (c) => { asked.push(c); return 'daemon' } }))
    expect(asked).toEqual([expect.objectContaining({ provider: 'chatgpt', studio: expect.objectContaining({ account: 'acct-studio' }), daemon: expect.objectContaining({ account: 'acct-daemon' }) })])
    expect(report.items.find((i) => i.id === 'chatgpt')?.detail).toMatch(/kept acct-daemon, signed out acct-studio/)
    expect(studioTokens(sub).exists()).toBe(false)
    expect(daemonTokens(sub).read()?.refresh_token).toBe(daemonOwn.refresh_token)
  })

  it('one account on both sides: the more recently refreshed session is kept, without asking', async () => {
    const sub = SUBS[1]
    const old = auth.issue(sub.subject)
    const newer = { ...auth.refresh(sub.subject, old.refresh_token), expires_at: old.expires_at + 10_000 }
    studioTokens(sub).write(newer)
    daemonTokens(sub).write(old)
    const report = await runHandover('local', deps({ chooseSession: async () => { throw new Error('must not ask') } }))
    expect(report.failed).toBe(false)
    expect(daemonTokens(sub).read()?.refresh_token).toBe(newer.refresh_token)
  })

  it('back in embedded, a daemon session Studio never handed over (adf auth login on a CLI daemon) stays with the daemon', async () => {
    const sub = SUBS[0]
    daemonTokens(sub).write(auth.issue('acct-cli'))
    const report = await runHandover('embedded', deps())
    expect(report.changed).toBe(false)
    expect(existsSync(daemonTokens(sub).path)).toBe(true)
    expect(studioTokens(sub).exists()).toBe(false)
  })

  it('a session signed in on the daemon while Studio ran in local mode moves to Studio on the way back', async () => {
    await runHandover('local', deps())
    const sub = SUBS[0]
    daemonTokens(sub).write(auth.issue('acct-signed-in-local'))
    await runHandover('embedded', deps())
    expect(studioTokens(sub).read().account_id).toBe('acct-signed-in-local')
    expect(existsSync(daemonTokens(sub).path)).toBe(false)
  })
})

describe('without a keychain the daemon can read (§5.3.1 fallback)', () => {
  it('MCP sign-ins and the runtime identity stay with Studio, and the plan says so', async () => {
    writeStudioIdentity()
    studioMcp().write({ [MCP_URL]: mcpRecord(auth.issue('mcp-user')) })
    const noKeychain = deps({ daemonSecrets: null, daemonSecretsUnavailable: 'no OS keychain is usable on this machine' })
    const plan = await planHandover('local', noKeychain)
    expect(plan.find((p) => p.id === 'runtime-identity')?.detail).toMatch(/not shared: no OS keychain.*recognized/)
    expect(plan.find((p) => p.id === 'mcp-oauth')?.detail).toMatch(/stay in Studio/)
    const report = await runHandover('local', noKeychain)
    expect(report.failed).toBe(false)
    expect(report.items.find((i) => i.id === 'mcp-oauth')).toMatchObject({ outcome: 'kept' })
    expect(report.items.find((i) => i.id === 'runtime-identity')).toMatchObject({ outcome: 'kept' })
    expect(studioMcp().read()[MCP_URL]).toBeDefined()
  })
})

describe('runtime identity entry', () => {
  it('is rewritten with a delegation re-signed by the new owner after an owner switch, and verifies', async () => {
    writeStudioIdentity()
    await runHandover('local', deps())
    // The owner switched (POST /identity/import): the settings name the new owner.
    const next = generateMnemonic()
    writeSettings({ ...readSettings(), ownerDid: deriveOwnerIdentity(next).did })
    const sync = await syncStudioRuntimeEntry(deps(), { ownerPhrase: next })
    expect(sync).toMatchObject({ outcome: 'written' })
    expect(sync.detail).toMatch(/re-signed/)
    const s = readSettings()
    const entry = keychain.backend.get(studioRuntimeAccount(studioRuntimeScope(settingsPath)))!
    expect(verifyStudioRuntimeEntry(entry, { ownerDid: s.ownerDid, runtimeDid: s.runtimeDid, runtimeEncPublicKey: s.runtimeEncPublicKey })).toMatchObject({ ok: true })
    // Unchanged values are not rewritten.
    expect(await syncStudioRuntimeEntry(deps(), { ownerPhrase: next })).toMatchObject({ outcome: 'unchanged' })
  })

  it('opens the keychain at boot only when something can go through it', async () => {
    expect(await handoverNeedsKeychain('local', dir)).toBe(false)
    expect(await handoverNeedsKeychain('embedded', dir)).toBe(false)
    writeStudioIdentity()
    expect(await handoverNeedsKeychain('local', dir)).toBe(true)
    await runHandover('local', deps())
    expect(await handoverNeedsKeychain('embedded', dir)).toBe(true)
    expect(await handoverNeedsKeychain('remote', dir)).toBe(false)
  })
})

describe('remote target', () => {
  it('moves only the client keys', async () => {
    studioTokens(SUBS[0]).write(auth.issue(SUBS[0].subject))
    const report = await runHandover('remote', deps())
    expect(report.items.map((i) => i.id)).toEqual(['client-settings'])
    expect(studioTokens(SUBS[0]).exists()).toBe(true)
  })
})

// --- chunked secret store (W1-C follow-ups) ---------------------------------------------

describe('chunked secret store', () => {
  it('deletes the chunks before the head, so a crash in between strands nothing', () => {
    const { store, backend } = fakeKeychain()
    chunkedSecretWrite(backend, 'acct', 'x'.repeat(SECRET_CHUNK_CHARS * 3))
    const order: string[] = []
    const crashing = { ...backend, isUnlocked: () => true, get: (a: string) => backend.get(a), set: (a: string, v: string) => backend.set(a, v),
      delete: (a: string) => { order.push(a); if (a === 'acct') throw new Error('crash at the head') ; backend.delete(a) } }
    expect(() => chunkedSecretDelete(crashing, 'acct')).toThrow('crash at the head')
    expect(order.at(-1)).toBe('acct')
    // Only the head is left; it reads as absent, and the next delete cleans it.
    expect([...store.keys()]).toEqual(['ADF/acct'])
    expect(chunkedSecretRead(backend, 'acct')).toBeNull()
    chunkedSecretDelete(backend, 'acct')
    expect(store.size).toBe(0)
  })

  it('refuses to write a value of more chunks than a head can name, before writing anything', () => {
    const { store, backend } = fakeKeychain()
    expect(() => chunkedSecretWrite(backend, 'acct', 'y'.repeat(SECRET_CHUNK_CHARS * MAX_SECRET_CHUNKS + 1))).toThrow(/too large/)
    expect(store.size).toBe(0)
    chunkedSecretWrite(backend, 'acct', 'y'.repeat(SECRET_CHUNK_CHARS * MAX_SECRET_CHUNKS))
    expect(chunkedSecretRead(backend, 'acct')?.length).toBe(SECRET_CHUNK_CHARS * MAX_SECRET_CHUNKS)
  })

  it('rejects a chunk size that cannot hold a surrogate pair instead of looping', () => {
    expect(() => splitOnCodePoints('\u{1F600}', 1)).toThrow(RangeError)
    expect(splitOnCodePoints('a\u{1F600}b', 2)).toEqual(['a', '\u{1F600}', 'b'])
  })
})
