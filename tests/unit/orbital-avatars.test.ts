import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { orbitalSeedFor } from '../../src/renderer/components/orbital/orbital-seed'
import { orbitalMotion, orbitalMotionStateFor, isOrbitalMoving } from '../../src/renderer/components/orbital/orbital-motion'
import { orbitalCachePath, readOrbitalCache, writeOrbitalCache, isOrbitalCacheRequest } from '../../src/main/services/orbital-cache'
import { ORBITAL_CACHE_DIR } from '../../src/shared/utils/orbital-cache-key'

const DID = 'did:key:z6MkfixtureAgentOne'
const PATH = '/agents/agent-1.adf'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('orbitalSeedFor', () => {
  it('prefers DID, then public key, then handle, then file path', () => {
    expect(orbitalSeedFor({ did: DID, publicKey: 'pk', handle: 'agent-1', filePath: PATH })).toBe(DID)
    expect(orbitalSeedFor({ publicKey: 'pk', handle: 'agent-1', filePath: PATH })).toBe('pk')
    expect(orbitalSeedFor({ handle: 'agent-1', filePath: PATH })).toBe('agent-1')
    expect(orbitalSeedFor({ filePath: PATH })).toBe(PATH)
  })

  it('skips blank values and returns null when nothing is left', () => {
    expect(orbitalSeedFor({ did: '  ', publicKey: null, handle: '', filePath: PATH })).toBe(PATH)
    expect(orbitalSeedFor({})).toBeNull()
  })
})

describe('orbitalMotion', () => {
  it('keeps resting states still and dims off, suspended and hibernate', () => {
    for (const s of ['off', 'suspended', 'hibernate', 'idle', 'error'] as const) {
      expect(isOrbitalMoving(orbitalMotion(s))).toBe(false)
    }
    expect(orbitalMotion('off').alpha).toBe(0.5)
    expect(orbitalMotion('suspended').alpha).toBe(0.5)
    expect(orbitalMotion('hibernate').alpha).toBeLessThan(1)
    expect(orbitalMotion('idle').alpha).toBe(1)
  })

  it('spins while thinking and cycles phase faster during a tool call', () => {
    const thinking = orbitalMotion('thinking')
    const tool = orbitalMotion('tool')
    expect(thinking.spin).toBeGreaterThan(0)
    expect(tool.phase).toBeGreaterThan(thinking.phase)
  })

  it('maps agent display states', () => {
    expect(orbitalMotionStateFor('active')).toBe('thinking')
    expect(orbitalMotionStateFor('active', true)).toBe('tool')
    expect(orbitalMotionStateFor('not_participating')).toBe('off')
    expect(orbitalMotionStateFor(undefined)).toBe('off')
    expect(orbitalMotionStateFor('hibernate')).toBe('hibernate')
  })
})

describe('orbital disk cache', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adf-orbital-cache-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keys by sha256 of the seed, theme and kind; never the raw seed', () => {
    const p = orbitalCachePath(root, { seed: PATH, theme: 'dark', kind: 'strip' })
    expect(dirname(p)).toBe(join(root, ORBITAL_CACHE_DIR))
    expect(basename(p)).toMatch(/^[0-9a-f]{64}-dark-strip\.png$/)
    expect(p).not.toContain('agent-1')
    expect(orbitalCachePath(root, { seed: PATH, theme: 'light', kind: 'strip' })).not.toBe(p)
    expect(orbitalCachePath(root, { seed: DID, theme: 'dark', kind: 'strip' })).not.toBe(p)
  })

  it('round-trips a PNG and refuses anything else', async () => {
    const req = { seed: DID, theme: 'light' as const, kind: 'static' as const }
    expect(await readOrbitalCache(root, req)).toBeNull()
    expect(await writeOrbitalCache(root, req, Uint8Array.from([1, 2, 3]))).toBe(false)
    expect(await writeOrbitalCache(root, req, PNG)).toBe(true)
    expect(Array.from((await readOrbitalCache(root, req))!)).toEqual(Array.from(PNG))
    expect(readdirSync(join(root, ORBITAL_CACHE_DIR))).toHaveLength(1)
  })

  it('validates requests', () => {
    expect(isOrbitalCacheRequest({ seed: DID, theme: 'dark', kind: 'static' })).toBe(true)
    expect(isOrbitalCacheRequest({ seed: '', theme: 'dark', kind: 'static' })).toBe(false)
    expect(isOrbitalCacheRequest({ seed: DID, theme: 'sepia', kind: 'static' })).toBe(false)
    expect(isOrbitalCacheRequest({ seed: DID, theme: 'dark', kind: 'gif' })).toBe(false)
    expect(isOrbitalCacheRequest(null)).toBe(false)
  })
})
