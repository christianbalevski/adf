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

import { SettingsService } from '../../../src/main/services/settings.service'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { readAdfAttestations, verifyAttestation } from '../../../src/main/services/attestation.service'

let rootDir: string
let trackedDir: string

function makeSettings(): SettingsService {
  const settings = new SettingsService()
  settings.set('trackedDirectories', [trackedDir])
  settings.getOwnerIdentity().ensureIdentity()
  return settings
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-env-migration-'))
  h.userDataDir = join(rootDir, 'userData')
  trackedDir = join(rootDir, 'agents')
  mkdirSync(h.userDataDir, { recursive: true })
  mkdirSync(trackedDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('ensureWorkspaceIdentity (spec D1)', () => {
  it('fully provisions a fresh workspace: envelopes, sealed keys, stamps, attestations', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.create(join(trackedDir, 'fresh.adf'), { name: 'fresh' })
    try {
      const { keysGenerated } = svc.ensureWorkspaceIdentity(ws)
      expect(keysGenerated).toBe(true)
      expect(ws.getDid()).toMatch(/^did:key:z/)
      expect(ws.getIdentityRow('crypto:signing:private_key')!.encryption_algo).toBe('env:identity')
      expect(ws.getMeta('adf_owner_did')).toBe(svc.getOwnerDid())
      expect(ws.getMeta('adf_runtime_did')).toBe(svc.getRuntimeDid())

      const atts = readAdfAttestations(ws)
      expect(atts.length).toBeGreaterThan(0)
      expect(atts.some((a) => a.role === 'owner' && verifyAttestation(a, { expectedSubject: ws.getDid()! }))).toBe(true)
      // Signing works via the envelope DEK
      expect(ws.getSigningKeys(null)).not.toBeNull()
    } finally {
      ws.close()
    }
  })

  it('is idempotent — a second run changes nothing', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.create(join(trackedDir, 'idem.adf'), { name: 'idem' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      const did = ws.getDid()
      const result = svc.ensureWorkspaceIdentity(ws)
      expect(result).toEqual({ keysGenerated: false, sealed: 0 })
      expect(ws.getDid()).toBe(did)
      expect(ws.getDidHistory()).toEqual([])
    } finally {
      ws.close()
    }
  })

  it('migrates a legacy file: keeps the DID, seals existing plain rows', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'legacy.adf')
    // Legacy file: plain keys + a plain credential, no envelopes
    const legacy = AdfWorkspace.create(filePath, { name: 'legacy' })
    let legacyDid: string
    try {
      legacyDid = legacy.generateIdentityKeys(null).did
      legacy.setIdentity('openai_key', 'sk-legacy')
    } finally {
      legacy.close()
    }

    const ws = AdfWorkspace.open(filePath)
    try {
      const { keysGenerated, sealed } = svc.ensureWorkspaceIdentity(ws)
      expect(keysGenerated).toBe(false) // existing keys are kept — no rotation
      expect(sealed).toBe(2) // private key + credential
      expect(ws.getDid()).toBe(legacyDid)
      expect(ws.getIdentityRow('crypto:signing:private_key')!.encryption_algo).toBe('env:identity')
      expect(ws.getIdentityRow('openai_key')!.encryption_algo).toBe('env:credentials')
      expect(ws.getIdentity('openai_key')).toBe('sk-legacy')
      expect(ws.getSigningKeys(null)).not.toBeNull()
    } finally {
      ws.close()
    }
  })

  it('skips password-protected files', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'locked.adf')
    const locked = AdfWorkspace.create(filePath, { name: 'locked' })
    try {
      locked.generateIdentityKeys(null)
      locked.setPassword('hunter2')
    } finally {
      locked.close()
    }

    const ws = AdfWorkspace.open(filePath)
    try {
      const result = svc.ensureWorkspaceIdentity(ws)
      expect(result).toEqual({ keysGenerated: false, sealed: 0 })
      expect(ws.hasEnvelopes()).toBe(false)
    } finally {
      ws.close()
    }
  })
})

describe('sweepEnvelopeMigration (spec §8)', () => {
  it('provisions key-less files and seals legacy plain rows across a tracked dir', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()

    // File A: no identity at all. File B: plain keys + credential.
    // Both reviewed — the sweep only touches reviewed files.
    const a = AdfWorkspace.create(join(trackedDir, 'a.adf'), { name: 'a' })
    const aId = a.getAgentConfig().id
    a.close()
    const b = AdfWorkspace.create(join(trackedDir, 'b.adf'), { name: 'b' })
    const bId = b.getAgentConfig().id
    b.generateIdentityKeys(null)
    b.setIdentity('mcp:server:token', 'tok')
    b.close()
    settings.set('reviewedAgents', { [aId]: 'accepted', [bId]: 'accepted' })

    const sweep = svc.sweepEnvelopeMigration()
    expect(sweep.failures).toEqual([])
    expect(sweep.provisioned).toBe(1) // A got keys (sealed at generation, not counted here)
    expect(sweep.sealed).toBe(2) // B's private key + B's token

    // Second sweep is a no-op (fast path)
    const again = svc.sweepEnvelopeMigration()
    expect(again).toEqual({ provisioned: 0, sealed: 0, failures: [] })

    // Both files unlock with this install's runtime key
    for (const name of ['a', 'b']) {
      const ws = AdfWorkspace.open(join(trackedDir, `${name}.adf`))
      try {
        svc.unlockWorkspaceEnvelopes(ws)
        expect(ws.getSigningKeys(null), `${name} signing keys`).not.toBeNull()
      } finally {
        ws.close()
      }
    }
  })

  it('leaves unreviewed files untouched — no ownership stamp before review', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()

    AdfWorkspace.create(join(trackedDir, 'dropped.adf'), { name: 'dropped' }).close()

    const sweep = svc.sweepEnvelopeMigration()
    expect(sweep).toEqual({ provisioned: 0, sealed: 0, failures: [] })

    const ws = AdfWorkspace.open(join(trackedDir, 'dropped.adf'))
    try {
      expect(ws.getDid()).toBeNull()
      expect(ws.hasEnvelopes()).toBe(false)
      expect(ws.getMeta('adf_owner_did')).toBeNull()
    } finally {
      ws.close()
    }
  })
})

describe('review gating (mintKeys) + claimWorkspace (spec D11)', () => {
  it('mintKeys: false is unlock-only — an unreviewed file is not mutated', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.create(join(trackedDir, 'unreviewed.adf'), { name: 'unreviewed' })
    try {
      const result = svc.ensureWorkspaceIdentity(ws, { mintKeys: false })
      expect(result).toEqual({ keysGenerated: false, sealed: 0 })
      expect(ws.getDid()).toBeNull()
      expect(ws.hasEnvelopes()).toBe(false)
      expect(ws.getMeta('adf_owner_did')).toBeNull()
    } finally {
      ws.close()
    }
  })

  it('mintKeys: false still unlocks existing envelopes on an owned file', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'owned.adf')
    const setup = AdfWorkspace.create(filePath, { name: 'owned' })
    try {
      svc.ensureWorkspaceIdentity(setup)
      setup.setIdentity('openai_key', 'sk-own')
    } finally {
      setup.close()
    }

    const ws = AdfWorkspace.open(filePath)
    try {
      svc.ensureWorkspaceIdentity(ws, { mintKeys: false })
      expect(ws.getIdentity('openai_key')).toBe('sk-own')
      expect(ws.getSigningKeys(null)).not.toBeNull()
    } finally {
      ws.close()
    }
  })

  it('claims a foreign file: new DID, history, clone attestation, kept credentials envelope', () => {
    const filePath = join(trackedDir, 'gift.adf')

    // "Sender": a different install provisions + sets a credential.
    const recipientUserData = h.userDataDir
    h.userDataDir = join(rootDir, 'userDataSender')
    mkdirSync(h.userDataDir, { recursive: true })
    const sender = new SettingsService()
    sender.getOwnerIdentity().ensureIdentity()
    const senderWs = AdfWorkspace.create(filePath, { name: 'gift' })
    let foreignDid: string
    try {
      sender.getOwnerIdentity().ensureWorkspaceIdentity(senderWs)
      senderWs.setIdentity('openai_key', 'sk-gift')
      foreignDid = senderWs.getDid()!
    } finally {
      senderWs.close()
    }

    // "Recipient" claims it on their own install.
    h.userDataDir = recipientUserData
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.open(filePath)
    try {
      const { did } = svc.claimWorkspace(ws)
      expect(did).toMatch(/^did:key:z/)
      expect(did).not.toBe(foreignDid)
      expect(ws.getDidHistory()).toContain(foreignDid)
      expect(ws.getMeta('adf_owner_did')).toBe(svc.getOwnerDid())
      expect(ws.getSigningKeys(null)).not.toBeNull()

      const atts = readAdfAttestations(ws)
      const clone = atts.find((a) => a.role === 'clone')
      expect(clone).toBeDefined()
      expect(clone!.scope).toBe(foreignDid)
      expect(clone!.issuer).toBe(svc.getOwnerDid())
      expect(verifyAttestation(clone!, { expectedSubject: did! })).toBe(true)

      // Credentials envelope kept but foreign — sender's key is not readable here
      expect(ws.getEnvelopeState('credentials')).toBe('foreign')
      expect(ws.getIdentity('openai_key')).toBeNull()
    } finally {
      ws.close()
    }
  })

  it('claims an identity-less file: fresh DID, no clone attestation', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'stripped.adf')
    AdfWorkspace.create(filePath, { name: 'stripped' }).close()

    const ws = AdfWorkspace.open(filePath)
    try {
      const { did } = svc.claimWorkspace(ws)
      expect(did).toMatch(/^did:key:z/)
      expect(ws.getMeta('adf_owner_did')).toBe(svc.getOwnerDid())
      expect(readAdfAttestations(ws).some((a) => a.role === 'clone')).toBe(false)
      expect(readAdfAttestations(ws).some((a) => a.role === 'owner')).toBe(true)
    } finally {
      ws.close()
    }
  })
})

describe('cross-machine recovery (spec D10 owner slot)', () => {
  it('a second install with the same mnemonic unlocks via the owner slot and re-wraps', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'roaming.adf')
    const ws = AdfWorkspace.create(filePath, { name: 'roaming' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      ws.setIdentity('openai_key', 'sk-roam')
    } finally {
      ws.close()
    }

    // "Machine B": separate settings store — fresh install mints its own
    // identity, then the user imports machine A's mnemonic (the real flow).
    const mnemonic = settings.getSecret('ownerMnemonic')!
    h.userDataDir = join(rootDir, 'userDataB')
    mkdirSync(h.userDataDir, { recursive: true })
    const settingsB = new SettingsService()
    const svcB = settingsB.getOwnerIdentity()
    svcB.ensureIdentity() // fresh mint: own runtime keys, throwaway owner
    svcB.importMnemonic(mnemonic) // adopt machine A's owner; runtime keys kept

    const wsB = AdfWorkspace.open(filePath)
    try {
      svcB.unlockWorkspaceEnvelopes(wsB)
      expect(wsB.getIdentity('openai_key')).toBe('sk-roam')
      expect(wsB.getSigningKeys(null)).not.toBeNull()
    } finally {
      wsB.close()
    }

    // Re-wrap happened: a fresh open unlocks with the runtime slot alone
    const wsB2 = AdfWorkspace.open(filePath)
    try {
      wsB2.unlockEnvelopes({ runtimeEncPrivateKey: svcB.getRuntimeEncPrivateKey() })
      expect(wsB2.getEnvelopeState('identity')).toBe('unlocked')
    } finally {
      wsB2.close()
    }
  })
})
