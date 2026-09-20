import { describe, it, expect, afterAll } from 'vitest'
import { performance } from 'perf_hooks'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync, writeFileSync } from 'fs'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'

/**
 * Storage-layer micro-benchmarks for the perf review (opt-in: RUN_BENCH=1).
 *
 * Each op measures a user-level operation through the public AdfWorkspace API.
 * Where a cheaper API may or may not exist yet, the op feature-detects it and
 * falls back to the legacy path, so the same file produces comparable
 * before/after numbers. Results are written to BENCH_OUT as JSON when set.
 */

const RUN = process.env.RUN_BENCH === '1'
const testFile = join(tmpdir(), `adf-review-bench-${Date.now()}.adf`)
const results: Record<string, number> = {}

const INBOX_ROWS = 1500
const OUTBOX_ROWS = 5000
const BIG_FILE_BYTES = 5 * 1024 * 1024

/**
 * Regression ceilings (ms/op), enforced only under RUN_BENCH=1.
 *
 * These guard against an order-of-magnitude regression — a return to the
 * O(rows) / read-the-whole-blob behaviour these ops replaced — not against
 * drift. Reference on a fast dev box: counts 0.044 ms (27 ms before the fix),
 * lookup_by_id 0.004 ms, file_exists_5mb 0.002 ms (3.6 ms before),
 * find_by_meta_recent 0.003 ms. Every ceiling therefore leaves 20x-300x of
 * headroom so a slow, shared CI runner cannot flake it.
 *
 * Deliberately unguarded: `inbox_lookup_legacy_scan` (the control, which is
 * *meant* to be slow) and the write/list ops (disk-bound and noisy on CI).
 */
const CEILINGS_MS: Record<string, number> = {
  inbox_summary_counts: 2,
  inbox_lookup_by_id: 1,
  file_exists_5mb: 1,
  outbox_find_by_meta_recent: 1
}

function time(name: string, iterations: number, fn: () => unknown): void {
  fn() // warm up
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const perOp = (performance.now() - start) / iterations
  results[name] = Number(perOp.toFixed(4))
  const ceiling = CEILINGS_MS[name]
  const suffix = ceiling === undefined ? '' : ` [ceiling ${ceiling} ms]`
  console.log(`[bench] ${name}: ${perOp.toFixed(3)} ms/op (${iterations} iters)${suffix}`)
  if (ceiling !== undefined) {
    expect(
      perOp,
      `${name} regressed: ${perOp.toFixed(3)} ms/op is over the ${ceiling} ms ceiling`
    ).toBeLessThan(ceiling)
  }
}

describe.skipIf(!RUN)('perf review storage bench', () => {
  let ws: AdfWorkspace
  const inboxIds: string[] = []

  afterAll(() => {
    try { ws?.close() } catch { /* ignore */ }
    for (const suffix of ['', '-shm', '-wal']) {
      const p = testFile + suffix
      if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
    }
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(results, null, 2))
  })

  it('seeds', () => {
    ws = AdfWorkspace.create(testFile, { name: 'review-bench' })
    const attachment = 'A'.repeat(100 * 1024)
    const statuses = ['unread', 'read', 'archived'] as const
    for (let i = 0; i < INBOX_ROWS; i++) {
      inboxIds.push(ws.addToInbox({
        from: `telegram:U${i % 25}`,
        content: `message body ${i} `.repeat(20),
        message_id: `chat:${i}`,
        source: 'telegram',
        received_at: Date.now() - i * 1000,
        status: statuses[i % 3],
        meta: { seq: i },
        // every 10th message carries a 100 KB inline attachment
        attachments: i % 10 === 0
          ? [{ filename: `f${i}.bin`, content_type: 'application/octet-stream', transfer: 'inline', data: attachment }] as never
          : undefined
      }))
    }
    for (let i = 0; i < OUTBOX_ROWS; i++) {
      ws.addToOutbox({
        from: 'agent-1',
        to: `telegram:U${i % 25}`,
        content: `reply ${i} `.repeat(20),
        created_at: Date.now() - (OUTBOX_ROWS - i) * 1000,
        status: 'sent',
        meta: { platform_message_id: `pm-${i}` }
      })
    }
    ws.writeFileBuffer('data/big.bin', Buffer.alloc(BIG_FILE_BYTES, 0x61))
    expect(inboxIds.length).toBe(INBOX_ROWS)
  }, 120_000)

  it('inbox summary counts (unread/read/archived)', () => {
    const anyWs = ws as unknown as { getInboxCounts?: () => unknown }
    time('inbox_summary_counts', 10, () =>
      typeof anyWs.getInboxCounts === 'function'
        ? anyWs.getInboxCounts()
        : [ws.getInbox('unread').length, ws.getInbox('read').length, ws.getInbox('archived').length]
    )
  }, 120_000)

  it('inbox lookup by id — legacy getInbox().find vs getInboxMessageById', () => {
    const id = inboxIds[INBOX_ROWS - 1]
    time('inbox_lookup_legacy_scan', 10, () => ws.getInbox().find(m => m.id === id))
    time('inbox_lookup_by_id', 1000, () => ws.getInboxMessageById(id))
  }, 120_000)

  it('outbox receipt correlation + listing', () => {
    time('outbox_find_by_meta', 50, () => ws.findOutboxByMetaValue('platform_message_id', 'pm-17'))
    // Receipts correlate against a just-sent message, so the newest row is the
    // realistic case; pm-17 (oldest) is the worst case for a created_at walk.
    time('outbox_find_by_meta_recent', 50, () =>
      ws.findOutboxByMetaValue('platform_message_id', `pm-${OUTBOX_ROWS - 3}`))
    time('outbox_list_all', 5, () => ws.getOutbox().length)
  }, 120_000)

  it('fileExists on a 5 MB file', () => {
    time('file_exists_5mb', 200, () => ws.fileExists('data/big.bin'))
  }, 120_000)

  it('overwrite a 5 MB file', () => {
    const buf = Buffer.alloc(BIG_FILE_BYTES, 0x62)
    time('write_file_5mb_overwrite', 10, () => ws.writeFileBuffer('data/big.bin', buf))
  }, 120_000)

  // A renamed or deleted op would otherwise drop its gate silently: the ceiling
  // would simply never be looked up and the suite would still pass green.
  it('every declared ceiling was actually measured', () => {
    expect(Object.keys(CEILINGS_MS).filter(name => !(name in results))).toEqual([])
  })
})
