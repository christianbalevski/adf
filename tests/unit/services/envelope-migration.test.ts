import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'

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
import { describeEnvelopeSweep } from '../../../src/main/services/owner-identity.service'
import { AgentLeaseRegistry, openHereOrLeasedElsewhere } from '../../../src/main/runtime/agent-lease'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { readAdfAttestations, verifyAttestation } from '../../../src/main/services/attestation.service'
import { writeV2Adf, writeV31Adf } from '../../helpers/old-schema-adf'

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
  it('provisions key-less files and seals legacy plain rows across a tracked dir', async () => {
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

    const sweep = await svc.sweepEnvelopeMigration()
    expect(sweep.failures).toEqual([])
    expect(sweep.provisioned).toBe(1) // A got keys (sealed at generation, not counted here)
    expect(sweep.sealed).toBe(2) // B's private key + B's token

    // Second sweep is a no-op (fast path)
    const again = await svc.sweepEnvelopeMigration()
    expect(again).toEqual({ provisioned: 0, sealed: 0, failures: [], skipped: [], needUpgradeOrReview: [] })

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

  it('leaves unreviewed files untouched — no ownership stamp before review', async () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()

    AdfWorkspace.create(join(trackedDir, 'dropped.adf'), { name: 'dropped' }).close()

    const sweep = await svc.sweepEnvelopeMigration()
    expect(sweep).toEqual({ provisioned: 0, sealed: 0, failures: [], skipped: [], needUpgradeOrReview: [join(trackedDir, 'dropped.adf')] })

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

describe('sweepEnvelopeMigration: files another runtime runs (W5-G)', () => {
  it('never opens a file `skip` names; the others are provisioned', async () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ids: string[] = []
    for (const name of ['agent-1', 'agent-2']) {
      const ws = AdfWorkspace.create(join(trackedDir, `${name}.adf`), { name })
      ids.push(ws.getAgentConfig().id)
      ws.close()
    }
    settings.set('reviewedAgents', Object.fromEntries(ids.map((id) => [id, 'accepted'])))
    const leased = join(trackedDir, 'agent-2.adf')
    const asked: string[] = []

    const sweep = await svc.sweepEnvelopeMigration({ skip: async (filePath) => { asked.push(filePath); return filePath === leased } })
    expect(asked.sort()).toEqual([join(trackedDir, 'agent-1.adf'), leased].sort())
    expect(sweep).toEqual({ provisioned: 1, sealed: 0, failures: [], skipped: [leased], needUpgradeOrReview: [] })
    for (const [name, provisioned] of [['agent-1', true], ['agent-2', false]] as const) {
      const ws = AdfWorkspace.open(join(trackedDir, `${name}.adf`))
      try {
        expect(ws.getDid() !== null, name).toBe(provisioned)
        expect(readAdfAttestations(ws).length, name).toBe(provisioned ? 2 : 0)
      } finally {
        ws.close()
      }
    }
  })

  it('does nothing without an owner identity (no envelope recipients)', async () => {
    const settings = new SettingsService()
    settings.set('trackedDirectories', [trackedDir])
    const ws = AdfWorkspace.create(join(trackedDir, 'agent-1.adf'), { name: 'agent-1' })
    settings.set('reviewedAgents', { [ws.getAgentConfig().id]: 'accepted' })
    ws.close()
    const svc = settings.getOwnerIdentity()
    vi.spyOn(svc, 'getEnvelopeRecipients').mockReturnValue(null)
    const sweep = await svc.sweepEnvelopeMigration()
    expect(sweep).toEqual({ provisioned: 0, sealed: 0, failures: [], skipped: [], needUpgradeOrReview: [], ownerNotReady: true })
    // Said, not silent.
    expect(describeEnvelopeSweep(sweep, 1)).toMatch(/Envelope sweep skipped: the owner identity is not ready/)
  })

  it('the log line names each failed file', () => {
    const line = describeEnvelopeSweep({ provisioned: 1, sealed: 0, failures: ['/agents/agent-2.adf: database disk image is malformed'], skipped: ['/agents/agent-3.adf'], needUpgradeOrReview: [] }, 12)
    expect(line).toContain('1 provisioned')
    expect(line).toContain('1 open here or run by another runtime')
    expect(line).toContain('/agents/agent-2.adf: database disk image is malformed')
  })
})

describe('sweepEnvelopeMigration never migrates (W5-H)', () => {
  it('leaves a v2 and a v31 file byte-identical, reviewed or not, and says so in one summary', async () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const v2 = join(trackedDir, 'agent-1.adf')
    const v31 = join(trackedDir, 'agent-2.adf')
    const unreviewed = join(trackedDir, 'agent-3.adf')
    const current = join(trackedDir, 'agent-4.adf')
    writeV2Adf(v2, { id: '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01', name: 'agent-1' })
    writeV31Adf(v31, { id: '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e02', name: 'agent-2' })
    AdfWorkspace.create(unreviewed, { name: 'agent-3' }).close()
    const ws = AdfWorkspace.create(current, { name: 'agent-4' })
    const currentId = ws.getAgentConfig().id
    ws.close()
    // Both old files are reviewed: the version alone keeps them closed.
    settings.set('reviewedAgents', {
      '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01': 'accepted',
      '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e02': 'accepted',
      [currentId]: 'accepted',
    })
    const before = new Map([v2, v31, unreviewed].map((p) => [p, readFileSync(p)]))
    const listing = readdirSync(trackedDir).sort()
    const log = vi.spyOn(console, 'log')
    const provisioned: string[] = []

    // Embedded's recipe (ensureWorkspaceIdentity) and the daemon's (`provision`) alike.
    for (const provision of [undefined, (w: AdfWorkspace, busy: { busyTimeoutMs: number }) => {
      provisioned.push(w.getFilePath())
      return svc.ensureWorkspaceIdentity(w, busy)
    }]) {
      const sweep = await svc.sweepEnvelopeMigration(provision ? { provision } : {})
      expect(sweep.failures).toEqual([])
      expect(sweep.needUpgradeOrReview.sort()).toEqual([v2, v31, unreviewed].sort())
      expect(describeEnvelopeSweep(sweep, 1)).toContain(', 3 skipped: need upgrade or review in ')
      for (const [p, bytes] of before) expect(readFileSync(p).equals(bytes), p).toBe(true)
      expect(readdirSync(trackedDir).sort()).toEqual(listing)
    }
    expect(provisioned).toEqual([])
    expect(log.mock.calls.some(([line]) => String(line).includes('Backup created before migration'))).toBe(false)
    // The current, reviewed file was provisioned by the first sweep.
    const opened = AdfWorkspace.open(current)
    try {
      expect(opened.getDid()).not.toBeNull()
    } finally {
      opened.close()
    }
  })
})

describe('sweepEnvelopeMigration read-only peek (W5-H review)', () => {
  it('waits at most the sweep busy timeout for a locked file and names it busy', async () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'agent-1.adf')
    const ws = AdfWorkspace.create(filePath, { name: 'agent-1' })
    settings.set('reviewedAgents', { [ws.getAgentConfig().id]: 'accepted' })
    ws.close()
    // A holder of the exclusive lock: readers too wait on it.
    const holder = new Database(filePath)
    holder.pragma('locking_mode = EXCLUSIVE')
    holder.exec('BEGIN IMMEDIATE; COMMIT')
    try {
      const t0 = performance.now()
      const sweep = await svc.sweepEnvelopeMigration()
      expect(performance.now() - t0).toBeLessThan(1_000)
      expect(sweep.failures).toEqual([`${filePath}: busy (another connection is writing it)`])
    } finally {
      holder.close()
    }
  })
})

describe('the sweep skip rule (openHereOrLeasedElsewhere, both modes)', () => {
  it('skips a file open here, one this process holds the lease of, and one another live runtime leases; not the others', async () => {
    const leases = new AgentLeaseRegistry({ dir: join(rootDir, 'leases'), kind: 'daemon', settingsPath: join(rootDir, 's.json'), sweepDeadEntries: false })
    const other = new AgentLeaseRegistry({ dir: join(rootDir, 'leases'), kind: 'studio-embedded', settingsPath: join(rootDir, 'o.json'), sweepDeadEntries: false })
    try {
      const file = (name: string) => { const p = join(trackedDir, `${name}.adf`); AdfWorkspace.create(p, { name }).close(); return p }
      const [openFile, heldHere, heldThere, free] = [file('agent-1'), file('agent-2'), file('agent-3'), file('agent-4')]
      expect((await leases.acquire(heldHere)).ok).toBe(true)
      expect((await other.acquire(heldThere)).ok).toBe(true)
      expect(await openHereOrLeasedElsewhere(leases, openFile, [openFile])).toBe(true)
      expect(await openHereOrLeasedElsewhere(leases, heldHere, [openFile])).toBe(true)
      expect(await openHereOrLeasedElsewhere(leases, heldThere, [openFile])).toBe(true)
      expect(await openHereOrLeasedElsewhere(leases, free, [openFile])).toBe(false)
    } finally {
      await leases.close()
      await other.close()
    }
  })
})

describe('ensureWorkspaceIdentity: atomic per file (W5-G)', () => {
  it('a second connection provisioning the same file meanwhile cannot interleave; afterwards it is a no-op', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'agent-1.adf')
    AdfWorkspace.create(filePath, { name: 'agent-1' }).close()
    const a = AdfWorkspace.open(filePath)
    const b = AdfWorkspace.open(filePath)
    try {
      // B gives up at once instead of after 5 s when the file is write-locked.
      ;(b.getDatabase() as unknown as { db: { pragma(s: string): unknown } }).db.pragma('busy_timeout = 0')
      // Between A's check (no signing key) and its key generation, B runs its whole provisioning.
      const generate = a.generateIdentityKeys.bind(a)
      let bResult: unknown = null
      vi.spyOn(a, 'generateIdentityKeys').mockImplementation((...args: Parameters<typeof a.generateIdentityKeys>) => {
        try { bResult = svc.ensureWorkspaceIdentity(b) } catch (err) { bResult = err }
        return generate(...args)
      })
      expect(svc.ensureWorkspaceIdentity(a).keysGenerated).toBe(true)
      // A held the write lock from its first check: B could not write in between.
      expect(String(bResult)).toContain('agent-1.adf is busy (another program is writing it); try again.')
      // Now B finds A's envelopes and keys: nothing to do, and it opens them.
      expect(svc.ensureWorkspaceIdentity(b)).toEqual({ keysGenerated: false, sealed: 0 })
      expect(b.getSigningKeys(null)).not.toBeNull()
      expect(b.getDid()).toBe(a.getDid())
      const atts = readAdfAttestations(b)
      expect(atts.map((x) => x.role).sort()).toEqual(['operator', 'owner'])
      expect(atts.every((x) => x.subject === a.getDid())).toBe(true)
    } finally {
      a.close()
      b.close()
    }
  })
})

describe('ensureWorkspaceIdentity: no write lock on the open of a provisioned file (W5-G re-review)', () => {
  /** Another connection holding the file's write lock (RESERVED) until released. */
  function holdWriteLock(filePath: string): { release(): void } {
    const other = AdfWorkspace.open(filePath)
    const raw = (other.getDatabase() as unknown as { db: { exec(sql: string): unknown } }).db
    raw.exec('BEGIN IMMEDIATE')
    return { release() { try { raw.exec('ROLLBACK') } finally { other.close() } } }
  }

  it('an already provisioned file opens while another connection writes it: no lock taken, no wait', () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'agent-1.adf')
    const first = AdfWorkspace.create(filePath, { name: 'agent-1' })
    expect(svc.ensureWorkspaceIdentity(first).keysGenerated).toBe(true)
    first.close()
    // Opened first (the open's own maintenance writes are not under test), then another connection starts writing.
    const ws = AdfWorkspace.open(filePath)
    const lock = holdWriteLock(filePath)
    try {
      ;(ws.getDatabase() as unknown as { db: { pragma(s: string): unknown } }).db.pragma('busy_timeout = 0')
      const t0 = performance.now()
      expect(svc.ensureWorkspaceIdentity(ws)).toEqual({ keysGenerated: false, sealed: 0 })
      expect(performance.now() - t0).toBeLessThan(1_000)
      expect(ws.getSigningKeys(null)).not.toBeNull()
    } finally {
      ws.close()
      lock.release()
    }
  })

  it('the sweep against a file another connection is writing fails fast, named in its log line', async () => {
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const filePath = join(trackedDir, 'agent-1.adf')
    const ws = AdfWorkspace.create(filePath, { name: 'agent-1' })
    settings.set('reviewedAgents', { [ws.getAgentConfig().id]: 'accepted' })
    ws.close()
    const lock = holdWriteLock(filePath)
    try {
      const t0 = performance.now()
      const sweep = await svc.sweepEnvelopeMigration()
      expect(performance.now() - t0).toBeLessThan(2_000)
      expect(sweep.provisioned).toBe(0)
      expect(sweep.failures).toHaveLength(1)
      expect(sweep.failures[0]).toMatch(/agent-1[.]adf: busy/)
      expect(describeEnvelopeSweep(sweep, performance.now() - t0)).toContain(filePath)
    } finally {
      lock.release()
    }
    // Retried at the next sweep (or open): provisioned then.
    expect((await svc.sweepEnvelopeMigration()).provisioned).toBe(1)
  })
})

describe('immediateTransaction restores busy_timeout (W5-G)', () => {
  it('after the minting window: on commit, when the work throws, and when BEGIN itself fails busy', () => {
    const filePath = join(trackedDir, 'agent-1.adf')
    const ws = AdfWorkspace.create(filePath, { name: 'agent-1' })
    const other = AdfWorkspace.open(filePath)
    const raw = (w: AdfWorkspace) => (w.getDatabase() as unknown as { db: { pragma(s: string, o?: { simple: boolean }): unknown; exec(sql: string): unknown } }).db
    const timeout = () => raw(ws).pragma('busy_timeout', { simple: true })
    try {
      expect(timeout()).toBe(5000)
      expect(ws.immediateTransaction(() => 'done', 20)).toBe('done')
      expect(timeout()).toBe(5000)
      expect(() => ws.immediateTransaction(() => { throw new Error('work failed') }, 20)).toThrow('work failed')
      expect(timeout()).toBe(5000)
      raw(other).exec('BEGIN IMMEDIATE')
      try {
        expect(() => ws.immediateTransaction(() => 'never', 20)).toThrow(/busy|locked/i)
      } finally {
        raw(other).exec('ROLLBACK')
      }
      expect(timeout()).toBe(5000)
    } finally {
      other.close()
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

      // No password slot → the foreign credentials envelope is dead: purged
      // (with its unreadable rows) and re-provisioned, so new secrets seal.
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
      expect(ws.getIdentityRow('openai_key')).toBeNull()
      ws.setIdentity('anthropic_key', 'sk-new')
      expect(ws.getIdentityRow('anthropic_key')!.encryption_algo).toBe('env:credentials')
      expect(ws.getIdentity('anthropic_key')).toBe('sk-new')
    } finally {
      ws.close()
    }
  })

  it('keeps a recoverable credentials envelope through claim and unlocks it later by password', () => {
    const filePath = join(trackedDir, 'gift-pw.adf')

    const recipientUserData = h.userDataDir
    h.userDataDir = join(rootDir, 'userDataSenderPw')
    mkdirSync(h.userDataDir, { recursive: true })
    const sender = new SettingsService()
    sender.getOwnerIdentity().ensureIdentity()
    const senderWs = AdfWorkspace.create(filePath, { name: 'gift-pw' })
    try {
      sender.getOwnerIdentity().ensureWorkspaceIdentity(senderWs)
      senderWs.setIdentity('openai_key', 'sk-gift')
      senderWs.addEnvelopePasswordSlot('credentials', 'correct horse')
    } finally {
      senderWs.close()
    }

    h.userDataDir = recipientUserData
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.open(filePath)
    try {
      svc.claimWorkspace(ws)
      // Password slot + sealed row → recoverable, kept through the claim
      expect(ws.getEnvelopeState('credentials')).toBe('locked')

      // A credential written before unlock lands plain (no DEK yet)
      ws.setIdentity('interim_key', 'sk-interim')
      expect(ws.getIdentityRow('interim_key')!.encryption_algo).toBe('plain')

      // Later unlock (skip-for-now flow): adopt + seal interim plain rows
      expect(ws.unlockEnvelopeWithPassword('credentials', 'correct horse')).toBe(true)
      const encPub = { ownerDid: svc.getOwnerDid(), ownerEncPublicKey: svc.getOwnerEncPublicKey()!, runtimeDid: svc.getRuntimeDid(), runtimeEncPublicKey: svc.getRuntimeEncPublicKey()! }
      ws.adoptEnvelope('credentials', encPub)
      ws.sealPlainRowsIntoEnvelopes()

      expect(ws.getIdentity('openai_key')).toBe('sk-gift')
      expect(ws.getIdentityRow('interim_key')!.encryption_algo).toBe('env:credentials')
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
    } finally {
      ws.close()
    }
  })

  it('purges an empty foreign credentials envelope on claim even without a password slot', () => {
    const filePath = join(trackedDir, 'gift-empty.adf')

    const recipientUserData = h.userDataDir
    h.userDataDir = join(rootDir, 'userDataSenderEmpty')
    mkdirSync(h.userDataDir, { recursive: true })
    const sender = new SettingsService()
    sender.getOwnerIdentity().ensureIdentity()
    const senderWs = AdfWorkspace.create(filePath, { name: 'gift-empty' })
    try {
      sender.getOwnerIdentity().ensureWorkspaceIdentity(senderWs)
      // No credentials ever stored — the provisioned envelope guards nothing
    } finally {
      senderWs.close()
    }

    h.userDataDir = recipientUserData
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.open(filePath)
    try {
      svc.claimWorkspace(ws)
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
      ws.setIdentity('openai_key', 'sk-fresh')
      expect(ws.getIdentityRow('openai_key')!.encryption_algo).toBe('env:credentials')
    } finally {
      ws.close()
    }
  })

  it('heals a file claimed before the purge existed: dead foreign credentials envelope is replaced', () => {
    const filePath = join(trackedDir, 'preclaimed.adf')

    const recipientUserData = h.userDataDir
    h.userDataDir = join(rootDir, 'userDataSenderPre')
    mkdirSync(h.userDataDir, { recursive: true })
    const sender = new SettingsService()
    sender.getOwnerIdentity().ensureIdentity()
    const senderWs = AdfWorkspace.create(filePath, { name: 'preclaimed' })
    try {
      sender.getOwnerIdentity().ensureWorkspaceIdentity(senderWs)
      senderWs.setIdentity('openai_key', 'sk-old')
    } finally {
      senderWs.close()
    }

    // Replay the pre-purge claim: wipe signing keys + identity envelope,
    // stamp new owner, leave the dead foreign credentials envelope behind.
    h.userDataDir = recipientUserData
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.open(filePath)
    try {
      const db = ws.getDatabase()
      db.deleteIdentity('crypto:signing:private_key')
      db.deleteIdentity('crypto:signing:public_key')
      db.deleteIdentity('crypto:envelope:identity')
      db.setMeta('adf_owner_did', svc.getOwnerDid(), 'readonly')
      db.setMeta('adf_runtime_did', svc.getRuntimeDid(), 'readonly')

      svc.ensureWorkspaceIdentity(ws)
      expect(ws.getEnvelopeState('identity')).toBe('unlocked')
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
      ws.setIdentity('anthropic_key', 'sk-healed')
      expect(ws.getIdentityRow('anthropic_key')!.encryption_algo).toBe('env:credentials')
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
