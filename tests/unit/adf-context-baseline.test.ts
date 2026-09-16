import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import Database from 'better-sqlite3'
import { AdfWorkspace, CONTEXT_BASELINE_META_KEY } from '../../src/main/adf/adf-workspace'

/**
 * The persisted context baseline (`context_baseline_tokens` in adf_meta).
 *
 * FIXED BUG: every "how full is the window" reader (fleet gauge, status bar
 * on reload, the executor's turn-start seed) read the newest assistant loop
 * row's usage. After a voluntary loop_compact that row is preserved and
 * honestly reports the PRE-compaction input, so the gauge showed the old size
 * and the next turn re-compacted a tiny loop. The baseline is written by the
 * executor and is the only number those readers trust; the loop row stays a
 * billing record.
 */

const testFile = join(tmpdir(), `adf-context-baseline-${Date.now()}.adf`)
let ws: AdfWorkspace | undefined
let skipAll = false

try {
  ws = AdfWorkspace.create(testFile, { name: 'context-baseline-test' })
} catch {
  skipAll = true
}

function cleanup(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
}

describe.skipIf(skipAll)('context baseline', () => {
  afterAll(() => {
    ws?.close()
    cleanup()
  })

  it('is absent on a fresh file', () => {
    expect(ws!.getContextBaseline()).toBeUndefined()
  })

  it('round-trips tokens + provenance and is readonly meta', () => {
    ws!.setContextBaseline(12_345.6, false)
    const b = ws!.getContextBaseline()
    expect(b?.tokens).toBe(12_346)
    expect(b?.estimated).toBe(false)
    expect(b?.updated_at).toBeGreaterThan(0)
    expect(ws!.getMetaProtection(CONTEXT_BASELINE_META_KEY)).toBe('readonly')

    ws!.setContextBaseline(700, true)
    expect(ws!.getContextBaseline()).toMatchObject({ tokens: 700, estimated: true })
  })

  it('is independent of the newest assistant row\'s usage', () => {
    // The preserved-after-compaction shape: a row whose usage is the whole
    // pre-compaction context, while the baseline says the loop is small.
    ws!.appendToLoop('assistant', [{ type: 'text', text: 'preserved batch' }], 'm', { input: 95_000, output: 400 })
    ws!.setContextBaseline(3_000, true)
    expect(ws!.getLastAssistantTokens()).toEqual({ input: 95_000, output: 400 })
    expect(ws!.getContextBaseline()?.tokens).toBe(3_000)
  })

  it('is keyed per loop', () => {
    const side = ws!.forLoop('reflector')
    expect(side.getContextBaseline()).toBeUndefined()
    side.setContextBaseline(42, false)
    expect(side.getContextBaseline()?.tokens).toBe(42)
    expect(ws!.getContextBaseline()?.tokens).toBe(3_000)
    expect(ws!.getMeta(`${CONTEXT_BASELINE_META_KEY}:reflector`)).not.toBeNull()
  })

  it('does not survive a loop wipe', async () => {
    await ws!.clearLoop()
    expect(ws!.getContextBaseline()).toBeUndefined()
    expect(ws!.getLastAssistantTokens()).toBeUndefined()
    // Sibling streams keep theirs.
    expect(ws!.forLoop('reflector').getContextBaseline()?.tokens).toBe(42)
  })

  it('clearContextBaseline forgets it explicitly', () => {
    const side = ws!.forLoop('reflector')
    side.clearContextBaseline()
    expect(side.getContextBaseline()).toBeUndefined()
  })

  it('ignores garbage in the meta cell', () => {
    ws!.setMeta(CONTEXT_BASELINE_META_KEY, 'not json')
    expect(ws!.getContextBaseline()).toBeUndefined()
    ws!.setMeta(CONTEXT_BASELINE_META_KEY, '"12"')
    expect(ws!.getContextBaseline()).toBeUndefined()
    ws!.setMeta(CONTEXT_BASELINE_META_KEY, JSON.stringify({ tokens: 'x' }))
    expect(ws!.getContextBaseline()).toBeUndefined()
  })

  it('legacy integer tokens rows are not a usage record (JSON.parse of an integer is a number, not an object)', () => {
    ws!.appendToLoop('assistant', [{ type: 'text', text: 'old row' }], 'm', { input: 1, output: 1 })
    // Legacy files stored a bare integer in adf_loop.tokens.
    const raw = new Database(testFile)
    try {
      raw.prepare("UPDATE adf_loop SET tokens = '123' WHERE loop = 'main' AND role = 'assistant'").run()
    } finally {
      raw.close()
    }
    expect(ws!.getLastAssistantTokens()).toBeUndefined()
    const rows = ws!.getLoop()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.tokens).toBeUndefined()
  })
})
