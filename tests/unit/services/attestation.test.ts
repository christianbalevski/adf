import { describe, expect, it } from 'vitest'
import type { AlfAttestation } from '../../../src/shared/types/adf-v02.types'
import {
  createAttestation,
  verifyAttestation,
  readAdfAttestations,
  writeAdfAttestations,
  appendAdfAttestation,
  issueOwnerAttestation
} from '../../../src/main/services/attestation.service'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

function makeIdentity() {
  const kp = generateEd25519KeyPair()
  return { ...kp, did: publicKeyToDid(extractRawPublicKey(kp.publicKey)) }
}

/** In-memory stand-in for the workspace surface the service touches (adf_attestations table). */
function fakeWorkspace(did: string | null): AdfWorkspace & { rows: AlfAttestation[] } {
  const rows: AlfAttestation[] = []
  const db = {
    listAttestations: () => rows.map((r) => ({ ...r })),
    insertAttestation: (a: AlfAttestation) => { rows.push({ ...a }) },
    deleteAttestationsByRoles: (roles: string[]) => {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) {
        if (roles.includes(rows[i].role)) rows.splice(i, 1)
      }
      return before - rows.length
    },
    deleteAllAttestations: () => { rows.length = 0 }
  }
  return {
    rows,
    getDid: () => did,
    getDatabase: () => db
  } as unknown as AdfWorkspace & { rows: AlfAttestation[] }
}

describe('createAttestation / verifyAttestation', () => {
  const owner = makeIdentity()
  const agent = makeIdentity()

  const fields = {
    issuer: owner.did,
    subject: agent.did,
    role: 'owner',
    issued_at: '2026-07-06T00:00:00.000Z'
  }

  it('round-trips: created attestation verifies', () => {
    const att = createAttestation(fields, owner.privateKey)
    expect(att.signature.startsWith('ed25519:')).toBe(true)
    expect(verifyAttestation(att)).toBe(true)
    expect(verifyAttestation(att, { expectedSubject: agent.did })).toBe(true)
  })

  it('rejects tampered fields', () => {
    const att = createAttestation(fields, owner.privateKey)
    expect(verifyAttestation({ ...att, role: 'operator' })).toBe(false)
    expect(verifyAttestation({ ...att, subject: owner.did })).toBe(false)
    expect(verifyAttestation({ ...att, issued_at: '2026-01-01T00:00:00.000Z' })).toBe(false)
  })

  it('rejects subject mismatch — a cert cannot be replayed onto another identity', () => {
    const att = createAttestation(fields, owner.privateKey)
    const other = makeIdentity()
    expect(verifyAttestation(att, { expectedSubject: other.did })).toBe(false)
  })

  it('rejects a forged issuer (signature from a different key)', () => {
    const impostor = makeIdentity()
    const att = createAttestation(fields, impostor.privateKey) // signed by wrong key
    expect(verifyAttestation(att)).toBe(false)
  })

  it('enforces expiry', () => {
    const expired = createAttestation({ ...fields, expires_at: '2026-07-05T00:00:00.000Z' }, owner.privateKey)
    expect(verifyAttestation(expired, { now: new Date('2026-07-06T00:00:00.000Z') })).toBe(false)
    const valid = createAttestation({ ...fields, expires_at: '2026-07-07T00:00:00.000Z' }, owner.privateKey)
    expect(verifyAttestation(valid, { now: new Date('2026-07-06T00:00:00.000Z') })).toBe(true)
  })

  it('rejects garbage inputs', () => {
    expect(verifyAttestation({ ...fields, signature: 'nonsense' } as AlfAttestation)).toBe(false)
    expect(verifyAttestation({ ...fields, issuer: 'did:key:zInvalid!!!', signature: 'ed25519:AAAA' } as AlfAttestation)).toBe(false)
  })
})

describe('adf_attestations storage', () => {
  it('read/write round-trip', () => {
    const owner = makeIdentity()
    const ws = fakeWorkspace('did:key:zTest')
    const att = createAttestation(
      { issuer: owner.did, subject: 'did:key:zTest', role: 'owner', issued_at: new Date().toISOString() },
      owner.privateKey
    )
    writeAdfAttestations(ws, [att])
    expect(readAdfAttestations(ws)).toEqual([att])
  })

  it('reads empty when no attestations exist', () => {
    expect(readAdfAttestations(fakeWorkspace(null))).toEqual([])
  })
})

describe('issueOwnerAttestation', () => {
  const owner = makeIdentity()
  const runtime = makeIdentity()

  it('issues owner + operator attestations, replacing only those roles', () => {
    const agent = makeIdentity()
    const ws = fakeWorkspace(agent.did)
    // Pre-existing stale attestation for a different (old) subject
    writeAdfAttestations(ws, [
      createAttestation({ issuer: owner.did, subject: 'did:key:zOldSubject', role: 'owner', issued_at: new Date().toISOString() }, owner.privateKey)
    ])

    const issued = issueOwnerAttestation(ws, {
      ownerDid: owner.did,
      ownerPrivateKey: owner.privateKey,
      runtimeDid: runtime.did,
      runtimePrivateKey: runtime.privateKey
    })

    expect(issued).toHaveLength(2)
    const stored = readAdfAttestations(ws)
    expect(stored).toHaveLength(2)
    expect(stored.every((a) => a.subject === agent.did)).toBe(true)
    expect(stored.map((a) => a.role).sort()).toEqual(['operator', 'owner'])
    expect(stored.every((a) => verifyAttestation(a, { expectedSubject: agent.did }))).toBe(true)
  })

  it('preserves append-only roles (clone) across re-attestation (D15)', () => {
    const agent = makeIdentity()
    const ws = fakeWorkspace(agent.did)
    const clone = createAttestation(
      { issuer: owner.did, subject: agent.did, role: 'clone', issued_at: new Date().toISOString(), scope: 'did:key:zPreviousIdentity' },
      owner.privateKey
    )
    appendAdfAttestation(ws, clone)

    issueOwnerAttestation(ws, { ownerDid: owner.did, ownerPrivateKey: owner.privateKey, runtimeDid: runtime.did, runtimePrivateKey: runtime.privateKey })
    issueOwnerAttestation(ws, { ownerDid: owner.did, ownerPrivateKey: owner.privateKey, runtimeDid: runtime.did, runtimePrivateKey: runtime.privateKey })

    const stored = readAdfAttestations(ws)
    expect(stored.filter((a) => a.role === 'clone')).toEqual([clone])
    expect(stored.filter((a) => a.role === 'owner')).toHaveLength(1)
    expect(stored.filter((a) => a.role === 'operator')).toHaveLength(1)
  })

  it('no-ops without an agent DID or owner key', () => {
    expect(issueOwnerAttestation(fakeWorkspace(null), { ownerDid: owner.did, ownerPrivateKey: owner.privateKey })).toEqual([])
    expect(issueOwnerAttestation(fakeWorkspace('did:key:zX'), { ownerDid: owner.did, ownerPrivateKey: null })).toEqual([])
  })

  it('omits the operator attestation when no runtime key is supplied', () => {
    const agent = makeIdentity()
    const ws = fakeWorkspace(agent.did)
    const issued = issueOwnerAttestation(ws, { ownerDid: owner.did, ownerPrivateKey: owner.privateKey })
    expect(issued).toHaveLength(1)
    expect(issued[0].role).toBe('owner')
  })
})
