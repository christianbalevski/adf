/**
 * Token-usage ledger persistence — two processes (Studio + daemon) share one
 * token-usage.json. Pins: local-day bucketing, delta merging on flush (no
 * last-writer-wins), clearAll surviving the other side's next flush, and
 * load-time shape validation of malformed files.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { TokenUsageService, sanitizeUsageData } from '../../../src/main/services/token-usage.service'
import { localDateKey } from '../../../src/shared/utils/date-key'

const originalDir = process.env.ADF_USER_DATA_DIR

function makeDir(seed?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-token-usage-merge-'))
  if (seed !== undefined) writeFileSync(join(dir, 'token-usage.json'), typeof seed === 'string' ? seed : JSON.stringify(seed))
  process.env.ADF_USER_DATA_DIR = dir
  return dir
}

function onDisk(dir: string): Record<string, Record<string, Record<string, { input: number; output: number }>>> {
  return JSON.parse(readFileSync(join(dir, 'token-usage.json'), 'utf-8'))
}

afterEach(() => {
  if (originalDir === undefined) delete process.env.ADF_USER_DATA_DIR
  else process.env.ADF_USER_DATA_DIR = originalDir
})

const today = localDateKey()

describe('localDateKey', () => {
  it('is the local calendar date, not the UTC one', () => {
    // 23:30 local on Jan 31 — in any zone east of UTC-0:30 the UTC date differs.
    const d = new Date(2026, 0, 31, 23, 30)
    expect(localDateKey(d)).toBe('2026-01-31')
    expect(localDateKey(new Date(2026, 2, 5, 0, 0, 1))).toBe('2026-03-05')
  })
})

describe('TokenUsageService — delta merge across processes', () => {
  it('records under the local day and getSummary counts it as today', () => {
    makeDir()
    const service = new TokenUsageService()
    service.recordUsage('p', 'm', 10, 5)
    expect(service.getUsageData()[today].p.m).toEqual({ input: 10, output: 5 })
    expect(service.getSummary().today).toEqual({ input: 10, output: 5 })
  })

  it('two instances flushing in turn keep each other\'s rows (no last-writer-wins)', () => {
    const dir = makeDir()
    const studio = new TokenUsageService()
    const daemon = new TokenUsageService()

    studio.recordUsage('anthropic', 'a', 100, 10)
    daemon.recordUsage('openai', 'b', 7, 3)
    daemon.recordUsage('anthropic', 'a', 1, 1) // same cell as studio's

    studio.flush()
    daemon.flush()

    const disk = onDisk(dir)
    expect(disk[today].anthropic.a).toEqual({ input: 101, output: 11 })
    expect(disk[today].openai.b).toEqual({ input: 7, output: 3 })
    // The daemon adopted the merged file as its own view.
    expect(daemon.getUsageData()[today].anthropic.a).toEqual({ input: 101, output: 11 })
  })

  it('a flush with nothing pending never clobbers what the other side wrote', () => {
    const dir = makeDir()
    const studio = new TokenUsageService()
    const daemon = new TokenUsageService()
    daemon.recordUsage('p', 'm', 5, 5)
    daemon.flush()
    studio.flush() // nothing pending
    expect(onDisk(dir)[today].p.m).toEqual({ input: 5, output: 5 })
  })

  it('clearAll writes an empty file immediately and survives the other side\'s next flush', () => {
    const dir = makeDir({ '2026-01-01': { p: { m: { input: 1, output: 1 } } } })
    const studio = new TokenUsageService()
    const daemon = new TokenUsageService()
    daemon.recordUsage('p', 'm', 50, 50)
    daemon.flush()

    studio.recordUsage('p', 'x', 9, 9) // unflushed delta must be dropped too
    studio.clearAll()
    expect(onDisk(dir)).toEqual({})
    expect(studio.getUsageData()).toEqual({})

    // Daemon records something new after the clear and flushes: only the
    // post-clear delta lands, the old rows stay gone.
    daemon.recordUsage('p', 'm', 2, 2)
    daemon.flush()
    expect(onDisk(dir)).toEqual({ [today]: { p: { m: { input: 2, output: 2 } } } })
  })

  it('a corrupt file is quarantined and treated as empty on flush', () => {
    const dir = makeDir('{not json')
    const service = new TokenUsageService()
    expect(service.getUsageData()).toEqual({})
    expect(readdirSync(dir).some((n) => n.startsWith('token-usage.json.corrupt-'))).toBe(true)

    // Corrupt it again after load; the flush re-reads, quarantines, merges onto empty.
    writeFileSync(join(dir, 'token-usage.json'), '<<<')
    service.recordUsage('p', 'm', 3, 4)
    service.flush()
    expect(onDisk(dir)).toEqual({ [today]: { p: { m: { input: 3, output: 4 } } } })
    expect(existsSync(join(dir, 'token-usage.json'))).toBe(true)
  })

  it('the debounced async save keeps delta-merge semantics', async () => {
    const dir = makeDir()
    const studio = new TokenUsageService()
    const daemon = new TokenUsageService()
    const asyncSave = (s: TokenUsageService) =>
      (s as unknown as { saveNowAsync(): Promise<boolean> }).saveNowAsync()

    studio.recordUsage('anthropic', 'a', 100, 10)
    daemon.recordUsage('anthropic', 'a', 1, 1)

    expect(await asyncSave(studio)).toBe(true)
    expect(await asyncSave(daemon)).toBe(true)

    expect(onDisk(dir)[today].anthropic.a).toEqual({ input: 101, output: 11 })
    expect(daemon.getUsageData()[today].anthropic.a).toEqual({ input: 101, output: 11 })
  })

  it('usage recorded while an async save is in flight is neither lost nor double-counted', async () => {
    const dir = makeDir()
    const service = new TokenUsageService()
    service.recordUsage('p', 'm', 10, 0)

    const inFlight = (service as unknown as { saveNowAsync(): Promise<boolean> }).saveNowAsync()
    service.recordUsage('p', 'm', 5, 0) // lands after the delta was taken
    expect(await inFlight).toBe(true)

    expect(onDisk(dir)[today].p.m).toEqual({ input: 10, output: 0 })
    // The live view keeps the in-flight record...
    expect(service.getUsageData()[today].p.m).toEqual({ input: 15, output: 0 })
    // ...and the next flush adds it exactly once.
    service.flush()
    expect(onDisk(dir)[today].p.m).toEqual({ input: 15, output: 0 })
  })

  it('overlapping async saves coalesce onto the one in flight', async () => {
    const dir = makeDir()
    const service = new TokenUsageService()
    const save = () => (service as unknown as { saveNowAsync(): Promise<boolean> }).saveNowAsync()
    service.recordUsage('p', 'm', 3, 3)
    const first = save()
    expect(save()).toBe(first)
    await first
    expect(onDisk(dir)[today].p.m).toEqual({ input: 3, output: 3 })
  })

  it('sanitizes malformed shapes on load so getSummary cannot throw', () => {
    makeDir({
      '2026-01-01': null,
      '2026-01-02': { p: null, q: { m: { input: null, output: 'x', cost_usd: null } }, r: { m: 5 } },
      '2026-01-03': 'nope',
    })
    const service = new TokenUsageService()
    expect(service.getUsageData()).toEqual({
      '2026-01-02': { q: { m: { input: 0, output: 0, cost_usd: 0 } }, r: {} },
    })
    expect(() => service.getSummary()).not.toThrow()
    expect(service.getSummary().allTime).toEqual({ input: 0, output: 0 })
  })
})

describe('sanitizeUsageData', () => {
  it('drops non-objects at every level and zeroes non-finite numbers', () => {
    expect(sanitizeUsageData(null)).toEqual({})
    expect(sanitizeUsageData([1, 2])).toEqual({})
    expect(sanitizeUsageData({ d: { p: { m: { input: Infinity, output: 2, reasoning: NaN } } } }))
      .toEqual({ d: { p: { m: { input: 0, output: 2, reasoning: 0 } } } })
  })

  it('leaves well-formed old-shape entries untouched (no extras materialized)', () => {
    const good = { d: { p: { m: { input: 1, output: 2 } } } }
    expect(sanitizeUsageData(good)).toEqual(good)
  })
})
