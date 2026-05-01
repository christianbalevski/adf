import { describe, expect, it } from 'vitest'
import { canonicalizeCardForSignature } from '../../../src/main/services/mesh-server'
import type { AlfAgentCard } from '../../../src/shared/types/adf-v02.types'

function baseCard(): AlfAgentCard {
  return {
    handle: 'monitor',
    description: 'Monitors things',
    icon: '📊',
    did: 'did:key:z6MkExample',
    public_key: 'z6MkExample',
    signed_at: '2026-04-01T00:00:00.000Z',
    resolution: { method: 'self', endpoint: 'http://127.0.0.1:7295/monitor/mesh/card' },
    endpoints: {
      inbox: 'http://127.0.0.1:7295/monitor/mesh/inbox',
      card: 'http://127.0.0.1:7295/monitor/mesh/card',
      health: 'http://127.0.0.1:7295/monitor/mesh/health'
    },
    public: false,
    shared: ['document.md'],
    attestations: [],
    policies: []
  }
}

describe('canonicalizeCardForSignature', () => {
  it('strips signature, endpoints, and resolution.endpoint before hashing', () => {
    const withSig = { ...baseCard(), signature: 'ed25519:aaaa' }
    const canon = canonicalizeCardForSignature(withSig)
    expect(canon).not.toContain('signature')
    expect(canon).not.toContain('endpoints')
    // The URL string lives in resolution.endpoint and endpoints.card — neither should appear
    expect(canon).not.toContain('http://127.0.0.1:7295/monitor/mesh/card')
    expect(canon).not.toContain('http://127.0.0.1:7295/monitor/mesh/inbox')
  })

  it('preserves the resolution method (just drops the endpoint URL within it)', () => {
    const canon = canonicalizeCardForSignature(baseCard())
    const parsed = JSON.parse(canon)
    expect(parsed.resolution).toEqual({ method: 'self' })
  })

  it('is observer-independent: same identity, different endpoints → same canonical bytes', () => {
    const local = baseCard()
    const lan: AlfAgentCard = {
      ...baseCard(),
      resolution: { method: 'self', endpoint: 'http://192.168.1.10:7295/monitor/mesh/card' },
      endpoints: {
        inbox: 'http://192.168.1.10:7295/monitor/mesh/inbox',
        card: 'http://192.168.1.10:7295/monitor/mesh/card',
        health: 'http://192.168.1.10:7295/monitor/mesh/health'
      }
    }
    expect(canonicalizeCardForSignature(local)).toBe(canonicalizeCardForSignature(lan))
  })

  it('is sensitive to identity field changes', () => {
    const original = canonicalizeCardForSignature(baseCard())
    const tampered = canonicalizeCardForSignature({ ...baseCard(), did: 'did:key:zOther' })
    expect(original).not.toBe(tampered)
  })

  it('is sensitive to handle and description changes', () => {
    const original = canonicalizeCardForSignature(baseCard())
    expect(canonicalizeCardForSignature({ ...baseCard(), handle: 'renamed' })).not.toBe(original)
    expect(canonicalizeCardForSignature({ ...baseCard(), description: 'New role' })).not.toBe(original)
  })

  it('is sensitive to policy changes', () => {
    const original = canonicalizeCardForSignature(baseCard())
    const withPolicy = canonicalizeCardForSignature({
      ...baseCard(),
      policies: [{ type: 'signing', standard: 'ed25519', send: 'required', receive: 'required' }]
    })
    expect(withPolicy).not.toBe(original)
  })

  it('handles cards without resolution (no crash, no resolution in canonical)', () => {
    const { resolution, ...noResolution } = baseCard()
    void resolution
    const canon = canonicalizeCardForSignature(noResolution as AlfAgentCard)
    const parsed = JSON.parse(canon)
    expect(parsed.resolution).toBeUndefined()
  })
})
