import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace, type EnvelopeRecipients } from '../../../src/main/adf/adf-workspace'
import { applyCloneFixup, clearUnselectedTables, cloneAdfFile, snapshotCloneSource } from '../../../src/main/adf/clone-fixup'
import {
  appendAdfAttestation,
  createAttestation,
  issueOwnerAttestation,
  readAdfAttestations,
  verifyAttestation
} from '../../../src/main/services/attestation.service'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import { generateX25519KeyPair, extractRawX25519PublicKey } from '../../../src/main/crypto/envelope-crypto'

function makeIdentity() {
  const kp = generateEd25519KeyPair()
  return { ...kp, did: publicKeyToDid(extractRawPublicKey(kp.publicKey)) }
}

/** Envelope recipients for the real D6 sealing path (provisionEnvelopes + generateIdentityKeys). */
function makeRecipients(ownerDid: string, runtimeDid: string): EnvelopeRecipients {
  return {
    ownerDid,
    ownerEncPublicKey: extractRawX25519PublicKey(generateX25519KeyPair().publicKey),
    runtimeDid,
    runtimeEncPublicKey: extractRawX25519PublicKey(generateX25519KeyPair().publicKey)
  }
}

/** The local owner/runtime pair that clones under this app */
const owner = makeIdentity()
const runtime = makeIdentity()
const keys = {
  ownerDid: owner.did,
  ownerPrivateKey: owner.privateKey,
  runtimeDid: runtime.did,
  runtimePrivateKey: runtime.privateKey
}

/** Test stand-in for OwnerIdentityService.ensureWorkspaceIdentity (plain keys, no envelopes). */
function provisionFreshIdentity(ws: AdfWorkspace): void {
  ws.generateIdentityKeys(null)
  issueOwnerAttestation(ws, keys)
}

/** Every table a clone dialog would list, minus the ones the caller deselects. */
function allTablesExcept(ws: AdfWorkspace, deselected: string[]): string[] {
  const rows = ws.querySQL(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ) as Array<{ name: string }>
  return rows.map((r) => r.name).filter((n) => !deselected.includes(n))
}

describe('clone fixup (FILE_CLONE post-copy)', () => {
  const dirs: string[] = []
  const open: AdfWorkspace[] = []

  afterEach(() => {
    for (const ws of open.splice(0)) {
      try { ws.close() } catch { /* already closed */ }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Source agent with a DID that has rotated once (so history is non-empty),
   * owner/operator certs from a DIFFERENT owner, a peer cert about itself,
   * and its own parent reference — everything a clone could wrongly inherit.
   */
  function makeSource(opts: { sealed?: boolean } = {}): { path: string; did: string; oldDid: string; sourceOwner: ReturnType<typeof makeIdentity> } {
    const dir = mkdtempSync(join(tmpdir(), 'adf-clone-fixup-'))
    dirs.push(dir)
    const path = join(dir, 'source.adf')
    const ws = AdfWorkspace.create(path, { name: 'source' })
    // sealed: production D6 layout — private key under the identity envelope, public key plain
    if (opts.sealed) ws.provisionEnvelopes(makeRecipients(owner.did, runtime.did))
    const oldDid = ws.generateIdentityKeys(null).did
    // Rotate: previous DID lands in adf_did_history
    ws.getDatabase().deleteIdentity('crypto:signing:private_key')
    ws.getDatabase().deleteIdentity('crypto:signing:public_key')
    const did = ws.generateIdentityKeys(null).did
    expect(ws.getDidHistory()).toEqual([oldDid])

    const sourceOwner = makeIdentity()
    issueOwnerAttestation(ws, { ownerDid: sourceOwner.did, ownerPrivateKey: sourceOwner.privateKey })
    const peer = makeIdentity()
    appendAdfAttestation(ws, createAttestation(
      { issuer: peer.did, subject: did, role: 'colleague', issued_at: new Date().toISOString() },
      peer.privateKey
    ))
    ws.setMeta('adf_parent_did', 'did:key:zGrandparent', 'readonly')
    ws.close()
    return { path, did, oldDid, sourceOwner }
  }

  function cloneOf(sourcePath: string, deselected: string[]) {
    const clonePath = sourcePath.replace(/source\.adf$/, 'source_clone.adf')
    copyFileSync(sourcePath, clonePath)
    const ws = AdfWorkspace.open(clonePath)
    open.push(ws)
    const source = snapshotCloneSource(ws)
    const selectedTables = allTablesExcept(ws, deselected)
    clearUnselectedTables(ws, selectedTables)
    const result = applyCloneFixup(ws, { selectedTables, source, keys, provisionFreshIdentity })
    return { ws, source, result }
  }

  /** The real FILE_CLONE body (temp copy → … → rename into place). */
  function cloneVia(sourcePath: string, deselected: string[], overrides: Partial<Parameters<typeof cloneAdfFile>[2]> = {}) {
    const probe = AdfWorkspace.open(sourcePath)
    const selectedTables = allTablesExcept(probe, deselected)
    probe.close()
    const created: string[] = []
    const result = cloneAdfFile(sourcePath, selectedTables, {
      keys,
      provisionFreshIdentity,
      onCreated: (p) => created.push(p),
      ...overrides
    })
    // Directory contents as the handler leaves them (before this test reopens the clone)
    const listing = readdirSync(join(sourcePath, '..')).sort()
    const ws = AdfWorkspace.open(result.filePath)
    open.push(ws)
    return { ws, result, created, listing }
  }

  it('snapshots the source DID off the untouched copy (falls back to config id)', () => {
    const src = makeSource()
    const copy = AdfWorkspace.open(src.path)
    open.push(copy)
    expect(snapshotCloneSource(copy)).toEqual({ did: src.did, id: src.did, didVerified: true })

    const dir = mkdtempSync(join(tmpdir(), 'adf-clone-fixup-nodid-'))
    dirs.push(dir)
    const noDid = AdfWorkspace.create(join(dir, 'source.adf'), { name: 'legacy' })
    open.push(noDid)
    expect(snapshotCloneSource(noDid)).toEqual({ did: null, id: noDid.getAgentConfig().id, didVerified: false })
  })

  it('verifies the source DID against its public key (sealed keys included)', () => {
    const sealed = makeSource({ sealed: true })
    const copy = AdfWorkspace.open(sealed.path)
    open.push(copy)
    // Envelope locked in this process: getSigningKeys is null, the public row is still plain
    expect(copy.getSigningKeys(null)).toBeNull()
    expect(snapshotCloneSource(copy)).toEqual({ did: sealed.did, id: sealed.did, didVerified: true })

    // Crafted adf_meta: a victim's well-formed DID over someone else's keys
    const victim = makeIdentity()
    const tampered = makeSource()
    const t = AdfWorkspace.open(tampered.path)
    t.getDatabase().setMeta('adf_did', victim.did, 'readonly')
    t.close()
    const tc = AdfWorkspace.open(tampered.path)
    open.push(tc)
    expect(snapshotCloneSource(tc)).toEqual({ did: victim.did, id: victim.did, didVerified: false })

    // Malformed DID is ignored entirely
    const junk = makeSource()
    const j = AdfWorkspace.open(junk.path)
    j.getDatabase().setMeta('adf_did', 'did:key:not-a-key', 'readonly')
    const junkId = j.getAgentConfig().id
    j.close()
    const jc = AdfWorkspace.open(junk.path)
    open.push(jc)
    expect(snapshotCloneSource(jc)).toEqual({ did: null, id: junkId, didVerified: false })
  })

  describe('fresh identity (adf_identity deselected)', () => {
    it('is a child of the source, with a clean history and a signed clone cert', () => {
      const src = makeSource()
      const { ws, result } = cloneOf(src.path, ['adf_identity'])

      expect(result.identity).toBe('fresh')
      const newDid = ws.getDid()!
      expect(newDid).toBeTruthy()
      expect(newDid).not.toBe(src.did)

      // 1. parent = source DID (the inherited grandparent reference is gone)
      expect(ws.getMeta('adf_parent_did')).toBe(src.did)
      expect(ws.getMetaProtection('adf_parent_did')).toBe('readonly')

      // 2. history holds neither the source's live DID nor its rotated-away one
      expect(ws.getDidHistory()).not.toContain(src.did)
      expect(ws.getDidHistory()).not.toContain(src.oldDid)
      expect(ws.getDidHistory()).toEqual([])

      // 3. clone provenance, scoped to the source DID, signed by the local owner
      const certs = readAdfAttestations(ws)
      const clone = certs.filter((a) => a.role === 'clone')
      expect(clone).toHaveLength(1)
      expect(clone[0]).toMatchObject({ issuer: owner.did, subject: newDid, scope: src.did })
      expect(verifyAttestation(clone[0], { expectedSubject: newDid })).toBe(true)
      expect(result.cloneAttested).toBe(true)

      // 5. inherited foreign-subject certs (source owner's + peer's) are purged
      expect(certs.every((a) => a.subject === newDid)).toBe(true)
      expect(certs.some((a) => a.issuer === src.sourceOwner.did)).toBe(false)
      expect(certs.some((a) => a.role === 'colleague')).toBe(false)
      // The source owner's cert was already replaced by issueOwnerAttestation
      // (replaceable role); the purge catches the append-only peer cert.
      expect(result.purgedAttestations).toBe(1)

      // and the fresh owner/operator certs are for the new DID, with meta to match
      expect(certs.filter((a) => a.role === 'owner').map((a) => a.issuer)).toEqual([owner.did])
      expect(certs.filter((a) => a.role === 'operator').map((a) => a.issuer)).toEqual([runtime.did])
      expect(ws.getMeta('adf_owner_did')).toBe(owner.did)
      expect(ws.getMeta('adf_runtime_did')).toBe(runtime.did)
      expect(result.warnings).toEqual([])
    })

    it('never signs a clone cert scoped to an unverified source DID', () => {
      const victim = makeIdentity()
      const src = makeSource()
      const t = AdfWorkspace.open(src.path)
      t.getDatabase().setMeta('adf_did', victim.did, 'readonly')
      t.close()

      const { ws, result } = cloneOf(src.path, ['adf_identity'])
      expect(result.cloneAttested).toBe(false)
      expect(readAdfAttestations(ws).some((a) => a.role === 'clone')).toBe(false)
      expect(result.warnings).toEqual([expect.stringContaining('does not match its signing key')])
      // The unsigned index still points at the claimed parent
      expect(ws.getMeta('adf_parent_did')).toBe(victim.did)
    })

    it('warns instead of silently skipping the clone cert when the owner key is missing', () => {
      const src = makeSource()
      const clonePath = src.path.replace(/source\.adf$/, 'source_clone.adf')
      copyFileSync(src.path, clonePath)
      const ws = AdfWorkspace.open(clonePath)
      open.push(ws)
      const source = snapshotCloneSource(ws)
      const selectedTables = allTablesExcept(ws, ['adf_identity'])
      clearUnselectedTables(ws, selectedTables)
      const result = applyCloneFixup(ws, {
        selectedTables,
        source,
        keys: { ...keys, ownerPrivateKey: null },
        provisionFreshIdentity: (w) => { w.generateIdentityKeys(null) }
      })
      expect(result.cloneAttested).toBe(false)
      expect(result.warnings).toEqual([expect.stringContaining('Owner key unavailable')])
    })

    it('throws when provisioning mints no new DID', () => {
      const src = makeSource()
      const clonePath = src.path.replace(/source\.adf$/, 'source_clone.adf')
      copyFileSync(src.path, clonePath)
      const ws = AdfWorkspace.open(clonePath)
      open.push(ws)
      const source = snapshotCloneSource(ws)
      const selectedTables = allTablesExcept(ws, ['adf_identity'])
      clearUnselectedTables(ws, selectedTables)
      expect(() => applyCloneFixup(ws, { selectedTables, source, keys, provisionFreshIdentity: () => {} }))
        .toThrow(/did not mint a new DID/)
    })

    it('keeps the parent reference when adf_meta was also deselected', () => {
      const src = makeSource()
      const { ws } = cloneOf(src.path, ['adf_identity', 'adf_meta'])
      expect(ws.getMeta('adf_parent_did')).toBe(src.did)
      expect(ws.getMetaProtection('adf_parent_did')).toBe('readonly')
      expect(ws.getDidHistory()).toEqual([])
      expect(readAdfAttestations(ws).filter((a) => a.role === 'clone')[0]?.scope).toBe(src.did)
    })

    it('records no clone cert when the source had no DID, but still parents by config id', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-clone-fixup-legacy-'))
      dirs.push(dir)
      const path = join(dir, 'source.adf')
      const legacy = AdfWorkspace.create(path, { name: 'legacy' })
      const legacyId = legacy.getAgentConfig().id
      legacy.close()

      const { ws, result } = cloneOf(path, ['adf_identity'])
      expect(result.cloneAttested).toBe(false)
      expect(readAdfAttestations(ws).some((a) => a.role === 'clone')).toBe(false)
      expect(ws.getMeta('adf_parent_did')).toBe(legacyId)
      expect(ws.getDid()).toBeTruthy()
    })
  })

  describe('kept identity (adf_identity selected)', () => {
    it('reissues owner/operator certs when adf_attestations was deselected', () => {
      const src = makeSource()
      const { ws, result } = cloneOf(src.path, ['adf_attestations'])

      expect(result.identity).toBe('kept')
      expect(ws.getDid()).toBe(src.did)
      const certs = readAdfAttestations(ws)
      expect(certs.map((a) => a.role).sort()).toEqual(['operator', 'owner'])
      expect(certs.every((a) => a.subject === src.did && verifyAttestation(a, { expectedSubject: src.did }))).toBe(true)
      expect(certs.find((a) => a.role === 'owner')!.issuer).toBe(owner.did)
      expect(ws.getMeta('adf_parent_did')).toBe(src.did)
    })

    it('leaves kept attestations alone and still re-parents to the source', () => {
      const src = makeSource()
      const { ws, result } = cloneOf(src.path, [])
      expect(result.identity).toBe('kept')
      expect(result.cloneAttested).toBe(false)
      const certs = readAdfAttestations(ws)
      // Untouched: source owner's cert and the peer cert are still about this (same) DID
      expect(certs.find((a) => a.role === 'owner')!.issuer).toBe(src.sourceOwner.did)
      expect(certs.some((a) => a.role === 'colleague')).toBe(true)
      expect(ws.getDidHistory()).toEqual([src.oldDid])
      // The inherited grandparent reference is replaced — the copy is a child of the source
      expect(ws.getMeta('adf_parent_did')).toBe(src.did)
    })

    it('recomputes adf_did from the kept keys when adf_meta was deselected', () => {
      const src = makeSource()
      const { ws, result } = cloneOf(src.path, ['adf_meta', 'adf_attestations'])
      expect(ws.getDid()).toBe(src.did)
      expect(ws.getMeta('adf_owner_did')).toBe(owner.did)
      expect(ws.getMeta('adf_runtime_did')).toBe(runtime.did)
      expect(readAdfAttestations(ws).map((a) => a.role).sort()).toEqual(['operator', 'owner'])
      expect(ws.getMeta('adf_parent_did')).toBe(src.did)
      expect(result.warnings).toEqual([])
    })

    it('recomputes adf_did from envelope-sealed keys (D6: public key row is plain)', () => {
      const src = makeSource({ sealed: true })
      const { ws, result } = cloneOf(src.path, ['adf_meta', 'adf_attestations'])
      // The identity envelope is locked in this process — only the plain public row is readable
      expect(ws.getSigningKeys(null)).toBeNull()
      expect(ws.getDid()).toBe(src.did)
      expect(result.did).toBe(src.did)
      expect(result.warnings).toEqual([])
      const certs = readAdfAttestations(ws)
      expect(certs.map((a) => a.role).sort()).toEqual(['operator', 'owner'])
      expect(certs.every((a) => verifyAttestation(a, { expectedSubject: src.did }))).toBe(true)
    })

    it('overwrites the inherited owner stamps when it reissues certs', () => {
      const src = makeSource()
      const stamped = AdfWorkspace.open(src.path)
      stamped.getDatabase().setMeta('adf_owner_did', src.sourceOwner.did, 'readonly')
      stamped.getDatabase().setMeta('adf_runtime_did', 'did:key:zSourceRuntime', 'readonly')
      stamped.close()

      const { ws } = cloneOf(src.path, ['adf_attestations'])
      expect(ws.getMeta('adf_owner_did')).toBe(owner.did)
      expect(ws.getMeta('adf_runtime_did')).toBe(runtime.did)
      expect(readAdfAttestations(ws).find((a) => a.role === 'owner')!.issuer).toBe(owner.did)
    })

    it('warns when certs cannot be reissued for lack of an owner key', () => {
      const src = makeSource()
      const clonePath = src.path.replace(/source\.adf$/, 'source_clone.adf')
      copyFileSync(src.path, clonePath)
      const ws = AdfWorkspace.open(clonePath)
      open.push(ws)
      const source = snapshotCloneSource(ws)
      const selectedTables = allTablesExcept(ws, ['adf_attestations'])
      clearUnselectedTables(ws, selectedTables)
      const result = applyCloneFixup(ws, { selectedTables, source, keys: { ...keys, ownerPrivateKey: null }, provisionFreshIdentity })
      expect(readAdfAttestations(ws)).toEqual([])
      expect(result.warnings).toEqual([expect.stringContaining('Owner key unavailable')])
    })
  })

  describe('cloneAdfFile (the FILE_CLONE handler body)', () => {
    function dirListing(sourcePath: string): string[] {
      return readdirSync(join(sourcePath, '..')).sort()
    }

    it('snapshots the source before clearing: adf_meta deselected still parents to the source DID', () => {
      const src = makeSource()
      const { ws, result, created, listing } = cloneVia(src.path, ['adf_meta', 'adf_attestations'])
      expect(result.filePath).toBe(join(src.path, '..', 'source_clone.adf'))
      expect(result.name).toBe('source_clone')
      expect(created).toEqual([result.filePath])
      expect(ws.getMeta('adf_parent_did')).toBe(src.did)
      expect(ws.getDid()).toBe(src.did)
      expect(ws.getAgentConfig().name).toBe('source_clone')
      // Nothing but the two agents remains — no .partial, no -wal/-shm
      expect(listing).toEqual(['source.adf', 'source_clone.adf'])
    })

    it('fresh identity gets a new config.id; kept identity keeps it', () => {
      const src = makeSource()
      const probe = AdfWorkspace.open(src.path)
      const srcId = probe.getAgentConfig().id
      probe.close()
      const fresh = cloneVia(src.path, ['adf_identity'])
      expect(fresh.result.fixup.identity).toBe('fresh')
      expect(fresh.ws.getAgentConfig().id).not.toBe(srcId)
      expect(fresh.ws.getAgentConfig().id).toHaveLength(srcId.length)
      expect(fresh.ws.getMeta('adf_parent_did')).toBe(src.did)
      expect(readAdfAttestations(fresh.ws).find((a) => a.role === 'clone')?.scope).toBe(src.did)

      const kept = cloneVia(src.path, [])
      expect(kept.result.filePath).toMatch(/source_clone_2\.adf$/)
      expect(kept.result.fixup.identity).toBe('kept')
      expect(kept.ws.getAgentConfig().id).toBe(srcId)
      expect(kept.ws.getDid()).toBe(src.did)
    })

    it('leaves nothing behind when a step throws', () => {
      const src = makeSource()
      expect(() => cloneVia(src.path, ['adf_identity'], {
        provisionFreshIdentity: () => { throw new Error('boom') }
      })).toThrow('boom')
      expect(dirListing(src.path)).toEqual(['source.adf'])
      expect(existsSync(join(src.path, '..', 'source_clone.adf'))).toBe(false)

      // A provisioner that mints nothing is a failure too (self-scoped clone)
      expect(() => cloneVia(src.path, ['adf_identity'], { provisionFreshIdentity: () => {} }))
        .toThrow(/did not mint a new DID/)
      expect(dirListing(src.path)).toEqual(['source.adf'])
    })

    it('recomputes the DID of a sealed-key kept-identity clone through the real path', () => {
      const src = makeSource({ sealed: true })
      const { ws, result } = cloneVia(src.path, ['adf_meta', 'adf_attestations'])
      expect(ws.getDid()).toBe(src.did)
      expect(result.fixup.warnings).toEqual([])
      expect(readAdfAttestations(ws).map((a) => a.role).sort()).toEqual(['operator', 'owner'])
    })
  })
})
