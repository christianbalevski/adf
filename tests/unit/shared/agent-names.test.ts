import { describe, expect, it } from 'vitest'
import { AGENT_NAME_ADJECTIVES, AGENT_NAME_PLANTS, generateAgentName } from '../../../src/shared/utils/agent-names'

const REGISTRY_STEMS = ['ash', 'aspen', 'cedar', 'ivy', 'oak', 'sage']

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('generateAgentName', () => {
  it('is adjective-plant, lower case, from the two lists', () => {
    const name = generateAgentName({ random: seeded(7) })
    const [adj, plant, extra] = name.split('-')
    expect(extra).toBeUndefined()
    expect(AGENT_NAME_ADJECTIVES as readonly string[]).toContain(adj)
    expect(AGENT_NAME_PLANTS as readonly string[]).toContain(plant)
    expect(name).toBe(name.toLowerCase())
  })

  it('never uses a registry agent name as the plant', () => {
    for (const stem of REGISTRY_STEMS) {
      expect(AGENT_NAME_PLANTS as readonly string[]).not.toContain(stem)
    }
  })

  it('has no duplicates in either list', () => {
    expect(new Set(AGENT_NAME_ADJECTIVES).size).toBe(AGENT_NAME_ADJECTIVES.length)
    expect(new Set(AGENT_NAME_PLANTS).size).toBe(AGENT_NAME_PLANTS.length)
  })

  it('skips names the caller says are taken', () => {
    const random = seeded(3)
    const first = generateAgentName({ random: seeded(3) })
    const second = generateAgentName({ random, taken: (n) => n === first })
    expect(second).not.toBe(first)
  })

  it('gives back a candidate even when everything is taken', () => {
    const name = generateAgentName({ random: seeded(11), taken: () => true, attempts: 5 })
    expect(name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it('is deterministic for a given random source', () => {
    expect(generateAgentName({ random: seeded(99) })).toBe(generateAgentName({ random: seeded(99) }))
  })
})
