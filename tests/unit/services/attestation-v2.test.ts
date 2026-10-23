import { describe, expect, it } from 'vitest'
import type { AlfAttestation } from '../../../src/shared/types/adf-v02.types'
import {
  ATTESTATION_CLAIMS_MAX_BYTES,
  PEER_ATTESTATIONS_MAX_COUNT,
  addPeerAttestation,
  createAttestation,
  issuePeerAttestation,
  readAdfAttestations,
  upgradeOwnAttestations,
  verifyAttestation,
} from '../../../src/main/services/attestation.service'
import { canonicalJsonStringify } from '../../../src/main/services/alf-pipeline'
import { extractRawPublicKey, generateEd25519KeyPair, publicKeyToDid, signEd25519 } from '../../../src/main/crypto/identity-crypto'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

function makeIdentity() {
  const kp = generateEd25519KeyPair()
  return { ...kp, did: publicKeyToDid(extractRawPublicKey(kp.publicKey)) }
}

/** A v1 cert as earlier versions signed it: the six fields only, no `v`. */
function v1(fields: Omit<AlfAttestation, 'signature' | 'v' | 'claims'>, key: Buffer): AlfAttestation {
  const { issuer, subject, role, issued_at, expires_at, scope } = fields
  const signable: Record<string, unknown> = { issuer, subject, role, issued_at }
  if (expires_at !== undefined) signable.expires_at = expires_at
  if (scope !== undefined) signable.scope = scope
  return { ...fields, signature: `ed25519:${signEd25519(Buffer.from(canonicalJsonStringify(signable)), key)}` }
}

function fakeWorkspace(did: string | null, rows: AlfAttestation[] = []): AdfWorkspace & { rows: AlfAttestation[]; replaced: number; beforeWrite?: () => void } {
  const ws: { rows: AlfAttestation[]; replaced: number; beforeWrite?: () => void; [k: string]: unknown } = {
    rows,
    replaced: 0,
    getDid: () => did,
    immediateTransaction: <T>(fn: () => T) => { ws.beforeWrite?.(); return fn() },
    getDatabase: () => ({
      listAttestations: () => ws.rows.map((r) => JSON.parse(JSON.stringify(r))),
      insertAttestation: (a: AlfAttestation) => { ws.rows.push(JSON.parse(JSON.stringify(a))) },
      resignAttestations: (updates: Array<{ from: string; to: AlfAttestation }>) => {
        ws.replaced++
        let n = 0
        for (const { from, to } of updates) {
          const i = ws.rows.findIndex((r) => r.signature === from)
          if (i >= 0) { ws.rows[i] = JSON.parse(JSON.stringify(to)); n++ }
        }
        return n
      },
    }),
  }
  return ws as unknown as AdfWorkspace & { rows: AlfAttestation[]; replaced: number; beforeWrite?: () => void }
}

const owner = makeIdentity()
const agent = makeIdentity()
const base = { issuer: owner.did, subject: agent.did, role: 'owner', issued_at: '2026-10-23T00:00:00.000Z' }

describe('v2 attestations', () => {
  it('are issued as v2, carry claims, and verify', () => {
    const att = createAttestation({ ...base, claims: { 'acme.grant': { can: ['read'], until: null } } }, owner.privateKey)
    expect(att.v).toBe(2)
    expect(verifyAttestation(att, { expectedSubject: agent.did })).toBe(true)
  })

  it('sign every field: changing claims, adding a field or dropping v breaks the signature', () => {
    const att = createAttestation({ ...base, claims: { name: 'Alice' } }, owner.privateKey)
    expect(verifyAttestation({ ...att, claims: { name: 'Mallory' } })).toBe(false)
    expect(verifyAttestation({ ...att, extra: 'x' } as AlfAttestation)).toBe(false)
    const { claims: _c, ...noClaims } = att
    expect(verifyAttestation(noClaims as AlfAttestation)).toBe(false)
    const { v: _v, ...downgraded } = att
    expect(verifyAttestation(downgraded as AlfAttestation)).toBe(false)
  })

  it('a __proto__ key (left out of canonical JSON) cannot ride along unsigned, in claims or at the top', () => {
    const att = createAttestation({ ...base, claims: { a: 1 } }, owner.privateKey)
    expect(verifyAttestation({ ...att, claims: JSON.parse('{"a":1,"__proto__":{"admin":true}}') })).toBe(false)
    expect(verifyAttestation({ ...att, claims: JSON.parse('{"a":1,"n":{"__proto__":5}}') })).toBe(false)
    expect(verifyAttestation(Object.assign(JSON.parse('{"__proto__":{"x":1}}'), att))).toBe(false)
    expect(() => createAttestation({ ...base, claims: JSON.parse('{"__proto__":1}') }, owner.privateKey)).toThrow(/__proto__/)
  })

  it('returns false, never throws, on mistyped fields; signed fields are type-checked', () => {
    const att = createAttestation(base, owner.privateKey)
    for (const bad of [{ issuer: 5 }, { subject: {} }, { role: [] }, { issued_at: 1 }, { expires_at: ['2999-01-01'] }, { expires_at: 0 }, { scope: 3 }]) {
      expect(() => verifyAttestation({ ...att, ...bad } as never)).not.toThrow()
      expect(verifyAttestation({ ...att, ...bad } as never)).toBe(false)
    }
    expect(() => createAttestation({ ...base, expires_at: 0 as never }, owner.privateKey)).toThrow()
  })

  it('an unknown version is refused, not guessed at', () => {
    const att = createAttestation(base, owner.privateKey)
    expect(verifyAttestation({ ...att, v: 3 } as unknown as AlfAttestation)).toBe(false)
  })

  it('v1 certs still verify, and their unsigned extras are still ignored', () => {
    const old = v1(base, owner.privateKey)
    expect(verifyAttestation(old, { expectedSubject: agent.did })).toBe(true)
    expect(verifyAttestation({ ...old, claims: { injected: true } })).toBe(true)
  })

  it('claims are capped: size, depth and plain JSON only', () => {
    const big = { blob: 'x'.repeat(ATTESTATION_CLAIMS_MAX_BYTES) }
    expect(() => createAttestation({ ...base, claims: big }, owner.privateKey)).toThrow(/bytes/)
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let i = 0; i < 12; i++) { const next = {}; deep.n = next; deep = next }
    expect(() => createAttestation({ ...base, claims: root }, owner.privateKey)).toThrow(/deeper/)
    expect(() => createAttestation({ ...base, claims: { n: Number.NaN } }, owner.privateKey)).toThrow(/finite/)
    expect(() => createAttestation({ ...base, claims: ['a'] as never }, owner.privateKey)).toThrow(/object/)
    expect(() => createAttestation({ ...base, claims: { d: new Date() } }, owner.privateKey)).toThrow(/plain/)
  })
})

describe('peer v2 attestations', () => {
  it('attestation_issue signs claims; attestation_add keeps the cert whole', () => {
    const issued = issuePeerAttestation(fakeWorkspace(owner.did), { subject: agent.did, role: 'member', claims: { 'org.example/membership': { tier: 'gold' } } }, owner.privateKey)
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    const subjectWs = fakeWorkspace(agent.did)
    expect(addPeerAttestation(subjectWs, issued.attestation, agent.did)).toEqual({ ok: true })
    const [stored] = readAdfAttestations(subjectWs)
    expect(stored).toEqual(issued.attestation)
    expect(verifyAttestation(stored, { expectedSubject: agent.did })).toBe(true)
  })

  it('attestation_add stops at the peer cert count and size limits', () => {
    const subjectWs = fakeWorkspace(agent.did)
    for (let i = 0; i < PEER_ATTESTATIONS_MAX_COUNT; i++) {
      const r = issuePeerAttestation(fakeWorkspace(owner.did), { subject: agent.did, role: 'member', scope: `g${i}` }, owner.privateKey)
      if (r.ok) expect(addPeerAttestation(subjectWs, r.attestation, agent.did)).toEqual({ ok: true })
    }
    const extra = issuePeerAttestation(fakeWorkspace(owner.did), { subject: agent.did, role: 'member', scope: 'one-more' }, owner.privateKey)
    expect(extra.ok && addPeerAttestation(subjectWs, extra.attestation, agent.did).ok).toBe(false)

    const bigWs = fakeWorkspace(agent.did)
    const results = Array.from({ length: 20 }, (_, i) => {
      const r = issuePeerAttestation(fakeWorkspace(owner.did), { subject: agent.did, role: 'member', scope: `b${i}`, claims: { blob: 'x'.repeat(3900) } }, owner.privateKey)
      return r.ok ? addPeerAttestation(bigWs, r.attestation, agent.did).ok : null
    })
    expect(results.filter((ok) => ok === false).length).toBeGreaterThan(0)
  })

  it('attestation_issue refuses claims that are not a JSON object', () => {
    const r = issuePeerAttestation(fakeWorkspace(owner.did), { subject: agent.did, role: 'member', claims: 'nope' }, owner.privateKey)
    expect(r).toEqual({ ok: false, error: 'claims must be a JSON object' })
  })
})

describe('upgradeOwnAttestations', () => {
  const runtime = makeIdentity()
  const peer = makeIdentity()

  it('re-signs own v1 certs as v2 with the same fields, keeps the order, and leaves peers v1', () => {
    const expired = '2020-01-01T00:00:00.000Z'
    const ws = fakeWorkspace(agent.did, [
      v1(base, owner.privateKey),
      v1({ issuer: runtime.did, subject: agent.did, role: 'operator', issued_at: base.issued_at }, runtime.privateKey),
      v1({ issuer: peer.did, subject: agent.did, role: 'member', issued_at: base.issued_at, scope: 'group:x' }, peer.privateKey),
      v1({ issuer: owner.did, subject: agent.did, role: 'clone', issued_at: base.issued_at, scope: 'did:key:old', expires_at: expired }, owner.privateKey),
    ])
    const signers = [{ did: owner.did, privateKey: owner.privateKey }, { did: runtime.did, privateKey: runtime.privateKey }]
    expect(upgradeOwnAttestations(ws, signers)).toBe(3)
    const after = readAdfAttestations(ws)
    expect(after.map((a) => [a.role, a.v])).toEqual([['owner', 2], ['operator', 2], ['member', undefined], ['clone', 2]])
    expect(after[3]).toMatchObject({ scope: 'did:key:old', expires_at: expired, issued_at: base.issued_at })
    for (const a of after.slice(0, 3)) expect(verifyAttestation(a, { expectedSubject: agent.did })).toBe(true)
    // Nothing left to do: no second write.
    expect(upgradeOwnAttestations(ws, signers)).toBe(0)
    expect(ws.replaced).toBe(1)
  })

  it('a row another runtime adds while the upgrade signs is kept', () => {
    const ws = fakeWorkspace(agent.did, [v1(base, owner.privateKey)])
    const late = v1({ issuer: peer.did, subject: agent.did, role: 'member', issued_at: base.issued_at }, peer.privateKey)
    ws.beforeWrite = () => { ws.rows.push(late) }
    expect(upgradeOwnAttestations(ws, [{ did: owner.did, privateKey: owner.privateKey }])).toBe(1)
    expect(readAdfAttestations(ws).map((a) => [a.role, a.v])).toEqual([['owner', 2], ['member', undefined]])
  })

  it('never re-signs a broken cert into a valid one', () => {
    const forged = { ...v1(base, owner.privateKey), role: 'operator' }
    const ws = fakeWorkspace(agent.did, [forged])
    expect(upgradeOwnAttestations(ws, [{ did: owner.did, privateKey: owner.privateKey }])).toBe(0)
    expect(verifyAttestation(readAdfAttestations(ws)[0])).toBe(false)
  })

  it('does nothing without a key', () => {
    const ws = fakeWorkspace(agent.did, [v1(base, owner.privateKey)])
    expect(upgradeOwnAttestations(ws, [{ did: owner.did, privateKey: null }])).toBe(0)
    expect(ws.replaced).toBe(0)
  })
})
