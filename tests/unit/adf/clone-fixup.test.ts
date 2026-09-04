import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { applyCloneFixup, clearUnselectedTables, snapshotCloneSource } from '../../../src/main/adf/clone-fixup'
import {
  appendAdfAttestation,
  createAttestation,
  issueOwnerAttestation,
  readAdfAttestations,
  verifyAttestation
} from '../../../src/main/services/attestation.service'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'

function makeIdentity() {
  const kp = generateEd25519KeyPair()
  return { ...kp, did: publicKeyToDid(extractRawPublicKey(kp.publicKey)) }
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
  function makeSource(): { path: string; did: string; oldDid: string; sourceOwner: ReturnType<typeof makeIdentity> } {
    const dir = mkdtempSync(join(tmpdir(), 'adf-clone-fixup-'))
    dirs.push(dir)
    const path = join(dir, 'source.adf')
    const ws = AdfWorkspace.create(path, { name: 'source' })
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

  it('snapshots the source DID off the untouched copy (falls back to config id)', () => {
    const src = makeSource()
    const copy = AdfWorkspace.open(src.path)
    open.push(copy)
    expect(snapshotCloneSource(copy)).toEqual({ did: src.did, id: src.did })

    const dir = mkdtempSync(join(tmpdir(), 'adf-clone-fixup-nodid-'))
    dirs.push(dir)
    const noDid = AdfWorkspace.create(join(dir, 'source.adf'), { name: 'legacy' })
    open.push(noDid)
    expect(snapshotCloneSource(noDid)).toEqual({ did: null, id: noDid.getAgentConfig().id })
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

      // and the fresh owner/operator certs are for the new DID
      expect(certs.filter((a) => a.role === 'owner').map((a) => a.issuer)).toEqual([owner.did])
      expect(certs.filter((a) => a.role === 'operator').map((a) => a.issuer)).toEqual([runtime.did])
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
      const { ws } = cloneOf(src.path, ['adf_meta', 'adf_attestations'])
      expect(ws.getDid()).toBe(src.did)
      expect(ws.getMeta('adf_owner_did')).toBe(owner.did)
      expect(ws.getMeta('adf_runtime_did')).toBe(runtime.did)
      expect(readAdfAttestations(ws).map((a) => a.role).sort()).toEqual(['operator', 'owner'])
      expect(ws.getMeta('adf_parent_did')).toBe(src.did)
    })
  })
})
