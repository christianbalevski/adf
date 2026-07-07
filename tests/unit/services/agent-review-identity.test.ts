import { describe, expect, it } from 'vitest'
import { deriveReviewIdentity, type ReviewIdentityInput } from '../../../src/main/services/agent-review'

const OWNER = 'did:key:zOwnerLocal'
const RUNTIME = 'did:key:zRuntimeLocal'
const AGENT = 'did:key:zAgent'

function input(overrides: Partial<ReviewIdentityInput> = {}): ReviewIdentityInput {
  return {
    agentDid: AGENT,
    fileOwnerDid: OWNER,
    fileRuntimeDid: RUNTIME,
    localOwnerDid: OWNER,
    localRuntimeDid: RUNTIME,
    identityEnvelope: 'unlocked',
    credentialsEnvelope: 'unlocked',
    sharePasswordSet: false,
    ownerKeyAvailable: true,
    ...overrides,
  }
}

describe('deriveReviewIdentity', () => {
  it('classifies an own, locally provisioned file as mine', () => {
    const r = deriveReviewIdentity(input())
    expect(r.scenario).toBe('mine')
    expect(r.needsClaim).toBe(false)
    expect(r.ownerIsYou).toBe(true)
  })

  it('classifies a key-less file as unclaimed and claim-gated', () => {
    const r = deriveReviewIdentity(input({ agentDid: null, identityEnvelope: 'absent', credentialsEnvelope: 'absent' }))
    expect(r.scenario).toBe('unclaimed')
    expect(r.needsClaim).toBe(true)
  })

  it('a stripped file with a forged owner meta is still unclaimed — meta alone never proves ownership', () => {
    const r = deriveReviewIdentity(input({ agentDid: null, fileOwnerDid: OWNER }))
    expect(r.scenario).toBe('unclaimed')
    expect(r.needsClaim).toBe(true)
  })

  it('classifies a different owner as foreign and claim-gated', () => {
    const r = deriveReviewIdentity(input({
      fileOwnerDid: 'did:key:zSomeoneElse',
      fileRuntimeDid: 'did:key:zTheirRuntime',
      identityEnvelope: 'foreign',
      credentialsEnvelope: 'foreign',
    }))
    expect(r.scenario).toBe('foreign')
    expect(r.needsClaim).toBe(true)
    expect(r.ownerIsYou).toBe(false)
    expect(r.credentialsLocked).toBe(true)
  })

  it('a file with keys but no owner assertion at all is foreign', () => {
    const r = deriveReviewIdentity(input({ fileOwnerDid: null, identityEnvelope: 'foreign' }))
    expect(r.scenario).toBe('foreign')
    expect(r.needsClaim).toBe(true)
  })

  it('same owner from another install is recognized, no claim needed', () => {
    const r = deriveReviewIdentity(input({ fileRuntimeDid: 'did:key:zOtherInstall' }))
    expect(r.scenario).toBe('recognized')
    expect(r.needsClaim).toBe(false)
    expect(r.ownerIsYou).toBe(true)
  })

  it('same owner but locked envelopes without a seed flags seedUnavailable', () => {
    const r = deriveReviewIdentity(input({ identityEnvelope: 'foreign', ownerKeyAvailable: false }))
    expect(r.scenario).toBe('recognized')
    expect(r.seedUnavailable).toBe(true)
    expect(r.needsClaim).toBe(false)
  })

  it('surfaces the share password on a foreign file with locked credentials', () => {
    const r = deriveReviewIdentity(input({
      fileOwnerDid: 'did:key:zSomeoneElse',
      identityEnvelope: 'foreign',
      credentialsEnvelope: 'foreign',
      sharePasswordSet: true,
    }))
    expect(r.scenario).toBe('foreign')
    expect(r.sharePasswordSet).toBe(true)
    expect(r.credentialsLocked).toBe(true)
  })
})
