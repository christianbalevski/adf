import { describe, it, expect, afterEach } from 'vitest'
import { markChildTrusted, setChildTrustRegistrar } from '../../../src/main/runtime/child-trust'
import { isConfigReviewed, markConfigReviewed } from '../../../src/main/services/agent-review'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

const child = { id: 'child-1', name: 'agent-1' } as AgentConfig

describe('child-trust', () => {
  afterEach(() => setChildTrustRegistrar(null))

  it('is a safe no-op before registration', () => {
    expect(() => markChildTrusted(child)).not.toThrow()
  })

  it('marks a spawned child reviewed through the registrar, host-independently', () => {
    let reviewed: unknown = []
    setChildTrustRegistrar((cfg) => { reviewed = markConfigReviewed(reviewed, cfg) })
    expect(isConfigReviewed(reviewed, child)).toBe(false)
    markChildTrusted(child)
    expect(isConfigReviewed(reviewed, child)).toBe(true)
  })

  it('swallows registrar errors so child creation never fails on review bookkeeping', () => {
    setChildTrustRegistrar(() => { throw new Error('store down') })
    expect(() => markChildTrusted(child)).not.toThrow()
  })
})
