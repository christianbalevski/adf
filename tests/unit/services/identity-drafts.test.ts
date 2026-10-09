import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { IdentityDraftStore } from '../../../src/main/services/identity-drafts'
import { SettingsService } from '../../../src/main/services/settings.service'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { readAdfAttestations, verifyAttestation } from '../../../src/main/services/attestation.service'
import { extractRawPublicKey, generateEd25519KeyPair, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'

function clockedStore(opts: { ttlMs?: number; cap?: number } = {}) {
  let t = 1_000
  const store = new IdentityDraftStore({ ...opts, now: () => t, scheduleSweep: false })
  return { store, advance: (ms: number) => { t += ms } }
}

describe('IdentityDraftStore', () => {
  it('returns a did:key whose keys come back once on take', () => {
    const { store } = clockedStore()
    const { draftId, did } = store.mint()
    expect(did).toMatch(/^did:key:z6Mk/)
    const keys = store.take(draftId)!
    expect(keys.did).toBe(did)
    expect(publicKeyToDid(extractRawPublicKey(keys.publicKey))).toBe(did)
    expect(store.take(draftId)).toBeNull()
    expect(store.size).toBe(0)
  })

  it('expires drafts after the TTL', () => {
    const { store, advance } = clockedStore({ ttlMs: 1000 })
    const { draftId } = store.mint()
    advance(999)
    expect(store.size).toBe(1)
    advance(1)
    expect(store.take(draftId)).toBeNull()
    expect(store.size).toBe(0)
  })

  it('evicts the oldest draft at the cap and zeroes its key', () => {
    const { store } = clockedStore({ cap: 2 })
    const a = store.mint()
    const b = store.mint()
    const aKey = (store as unknown as { drafts: Map<string, { privateKey: Buffer }> }).drafts.get(a.draftId)!.privateKey
    const c = store.mint()
    expect(aKey.every((x) => x === 0)).toBe(true)
    expect(store.size).toBe(2)
    expect(store.take(a.draftId)).toBeNull()
    expect(store.take(b.draftId)).not.toBeNull()
    expect(store.take(c.draftId)).not.toBeNull()
  })

  it('discard drops the draft and zeroes the private key', () => {
    const { store } = clockedStore()
    const { draftId } = store.mint()
    // Reach the held buffer to check it is wiped in place.
    const held = (store as unknown as { drafts: Map<string, { privateKey: Buffer }> }).drafts.get(draftId)!.privateKey
    expect(held.some((b) => b !== 0)).toBe(true)
    expect(store.discard(draftId)).toBe(true)
    expect(held.every((b) => b === 0)).toBe(true)
    expect(store.discard(draftId)).toBe(false)
    expect(store.take(draftId)).toBeNull()
  })

  it('ids are unique and unrelated to the DID', () => {
    const { store } = clockedStore()
    const a = store.mint()
    const b = store.mint()
    expect(a.draftId).not.toBe(b.draftId)
    expect(a.did).not.toBe(b.did)
    expect(a.draftId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-identity-draft-'))
  h.userDataDir = join(rootDir, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  mkdirSync(join(rootDir, 'agents'), { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('creating an agent with an identity draft', () => {
  it('the agent gets the draft DID, sealed keys, stamps and attestations', () => {
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    svc.ensureIdentity()
    const { store } = clockedStore()
    const { draftId, did } = store.mint()

    const ws = AdfWorkspace.create(join(rootDir, 'agents', 'agent-1.adf'), { name: 'agent-1' })
    try {
      const keys = store.take(draftId)!
      const expectedPublic = Buffer.from(keys.publicKey)
      const { keysGenerated } = svc.ensureWorkspaceIdentity(ws, { adoptKeys: keys })
      expect(keysGenerated).toBe(true)
      expect(ws.getDid()).toBe(did)
      expect(ws.getDidHistory()).toEqual([])

      const priv = ws.getIdentityRow('crypto:signing:private_key')!
      expect(priv.encryption_algo).toBe('env:identity')
      expect(ws.getIdentityRow('crypto:signing:public_key')!.encryption_algo).toBe('plain')
      const signing = ws.getSigningKeys(null)!
      expect(signing.publicKey.equals(expectedPublic)).toBe(true)
      expect(publicKeyToDid(extractRawPublicKey(signing.publicKey))).toBe(did)

      expect(ws.getMeta('adf_owner_did')).toBe(svc.getOwnerDid())
      expect(ws.getMeta('adf_runtime_did')).toBe(svc.getRuntimeDid())
      const atts = readAdfAttestations(ws)
      expect(atts.some((a) => a.role === 'owner' && verifyAttestation(a, { expectedSubject: did }))).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('adopted keys never replace an existing identity', () => {
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    svc.ensureIdentity()
    const { store } = clockedStore()
    const ws = AdfWorkspace.create(join(rootDir, 'agents', 'agent-1.adf'), { name: 'agent-1' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      const before = ws.getDid()
      const keys = store.take(store.mint().draftId)!
      svc.ensureWorkspaceIdentity(ws, { adoptKeys: keys })
      expect(ws.getDid()).toBe(before)
    } finally {
      ws.close()
    }
  })

  it('without envelopes the adopted keys are stored plain under the same DID', () => {
    const { store } = clockedStore()
    const { draftId, did } = store.mint()
    const ws = AdfWorkspace.create(join(rootDir, 'agents', 'agent-1.adf'), { name: 'agent-1' })
    try {
      expect(ws.generateIdentityKeys(null, store.take(draftId)!).did).toBe(did)
      expect(ws.getDid()).toBe(did)
      expect(ws.getIdentityRow('crypto:signing:private_key')!.encryption_algo).toBe('plain')
    } finally {
      ws.close()
    }
  })

  it('refuses a public key that is not the private key\'s pair', () => {
    const a = generateEd25519KeyPair()
    const b = generateEd25519KeyPair()
    const ws = AdfWorkspace.create(join(rootDir, 'agents', 'agent-1.adf'), { name: 'agent-1' })
    try {
      expect(() => ws.generateIdentityKeys(null, { privateKey: a.privateKey, publicKey: b.publicKey })).toThrow(/does not match/)
      expect(ws.getDid()).toBeNull()
      expect(ws.getIdentityRow('crypto:signing:private_key')).toBeNull()
    } finally {
      ws.close()
    }
  })
})
