import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(() => {
  // Creature makes a scratch canvas in its constructor; gridFor never draws.
  if (typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'undefined') {
    ;(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class { width = 1; height = 1; getContext() { return null } }
  }
})

describe('SpinCachedCreature', () => {
  it('projects each spin step once and snaps nearby spins to it', async () => {
    const { orbitalFromSeed } = await import('../../../src/renderer/lib/brand/orbital.js')
    const { SpinCachedCreature, SPIN_STEPS } = await import('../../../src/renderer/components/orbital/orbital-spin-cache')
    const c = new SpinCachedCreature(orbitalFromSeed('did:key:z6MkfixtureAgentOne'))
    const step = (2 * Math.PI) / SPIN_STEPS
    const a = c.gridFor(step * 3, 40, 18)
    expect(c.gridFor(step * 3 + step * 0.3, 40, 18)).toBe(a)
    expect(c.gridFor(step * 3 + 2 * Math.PI, 40, 18)).toBe(a)
    expect(c.gridFor(step * 3 - 4 * Math.PI, 40, 18)).toBe(a)
    const b = c.gridFor(step * 4, 40, 18)
    expect(b).not.toBe(a)
    expect(c.gridFor(step * 3, 40, 18)).toBe(a)
    expect(c.gridFor(step * 3, 96, 28)).not.toBe(a)
  })
})
