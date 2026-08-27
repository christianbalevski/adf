/**
 * Token-usage aggregate store — pins the additive entry extension
 * (cache/reasoning tokens + USD cost) and backward-compat loading of
 * files written before those fields existed.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { TokenUsageService } from '../../../src/main/services/token-usage.service'

const originalDir = process.env.ADF_USER_DATA_DIR

function makeService(seed?: unknown): { service: TokenUsageService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-token-usage-'))
  if (seed !== undefined) {
    writeFileSync(join(dir, 'token-usage.json'), JSON.stringify(seed))
  }
  process.env.ADF_USER_DATA_DIR = dir
  return { service: new TokenUsageService(), dir }
}

afterEach(() => {
  if (originalDir === undefined) delete process.env.ADF_USER_DATA_DIR
  else process.env.ADF_USER_DATA_DIR = originalDir
})

const today = new Date().toISOString().split('T')[0]

describe('TokenUsageService extras', () => {
  it('loads old-shape files (input/output only) without error', () => {
    const { service } = makeService({
      '2026-01-01': { openai: { 'gpt-5.4': { input: 100, output: 50 } } },
    })
    const entry = service.getUsageData()['2026-01-01'].openai['gpt-5.4']
    expect(entry).toEqual({ input: 100, output: 50 })
    expect(entry.cost_usd).toBeUndefined()
  })

  it('accumulates extras additively onto old-shape entries', () => {
    const { service } = makeService({
      [today]: { anthropic: { m1: { input: 100, output: 50 } } },
    })
    service.recordUsage('anthropic', 'm1', 10, 5, {
      cache_read: 7, cache_write: 3, reasoning: 2, cost_usd: 0.01,
    })
    service.recordUsage('anthropic', 'm1', 10, 5, { cost_usd: 0.02 })
    const entry = service.getUsageData()[today].anthropic.m1
    expect(entry.input).toBe(120)
    expect(entry.output).toBe(60)
    expect(entry.cache_read).toBe(7)
    expect(entry.cache_write).toBe(3)
    expect(entry.reasoning).toBe(2)
    expect(entry.cost_usd).toBeCloseTo(0.03, 8)
  })

  it('omits extras fields entirely when never reported', () => {
    const { service } = makeService()
    service.recordUsage('openai', 'm2', 10, 5)
    service.recordUsage('openai', 'm2', 10, 5, {}) // empty extras object
    // undefined extras values must not materialize keys
    service.recordUsage('openai', 'm2', 10, 5, { cost_usd: undefined })
    expect(service.getUsageData()[today].openai.m2).toEqual({ input: 30, output: 15 })
  })

  it('persists extras through flush and reloads them', () => {
    const { service, dir } = makeService()
    service.recordUsage('openrouter', 'm3', 1, 2, { cost_usd: 0.5, reasoning: 9 })
    service.flush()

    const onDisk = JSON.parse(readFileSync(join(dir, 'token-usage.json'), 'utf-8'))
    expect(onDisk[today].openrouter.m3).toEqual({ input: 1, output: 2, cost_usd: 0.5, reasoning: 9 })

    // Fresh instance against the same dir reads the extended shape back
    const reloaded = new TokenUsageService()
    expect(reloaded.getUsageData()[today].openrouter.m3.cost_usd).toBe(0.5)
  })
})
