/**
 * Canonical durable-tap recipe: crash-during-flush test.
 *
 * Exercises the queue-and-ack pattern documented in docs/guides/umbilical.md
 * without actually running the full umbilical dispatch — the recipe's
 * durability properties live in the SQL semantics, not the tap machinery.
 *
 * Scenario:
 *   1. Agent A enqueues 100 replication entries into local_replication_queue.
 *   2. Flush partially completes: entries 1..30 are "sent" then deleted.
 *   3. SIMULATED CRASH — no ack for entries 31..50 that were "sent" but
 *      whose delete didn't commit.
 *   4. On restart, the flush loop re-reads the queue. Entries 31..100 are
 *      still there; 31..50 are re-sent.
 *   5. Receiver side deduplicates by seq primary key — no duplicates land
 *      in the replicated table.
 *
 * Proves: the pattern ships at-least-once delivery + idempotent receive =
 * exactly-once outcome, under crash between send and ack.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, existsSync } from 'node:fs'

interface QueueRow { seq: number; payload_json: string; enqueued_at: number; attempt_count: number }

let senderDb: Database.Database
let receiverDb: Database.Database
let senderPath: string
let receiverPath: string

beforeEach(() => {
  senderPath = join(tmpdir(), `umbilical-sender-${process.pid}-${Date.now()}.db`)
  receiverPath = join(tmpdir(), `umbilical-receiver-${process.pid}-${Date.now()}.db`)
  senderDb = new Database(senderPath)
  receiverDb = new Database(receiverPath)

  senderDb.exec(`
    CREATE TABLE local_replication_queue (
      seq INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      attempt_count INTEGER DEFAULT 0
    );
  `)

  receiverDb.exec(`
    CREATE TABLE local_orders_replica (
      seq INTEGER PRIMARY KEY,  -- dedupe key: INSERT OR IGNORE makes duplicate application a no-op
      payload_json TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
})

afterEach(() => {
  senderDb.close()
  receiverDb.close()
  if (existsSync(senderPath)) unlinkSync(senderPath)
  if (existsSync(receiverPath)) unlinkSync(receiverPath)
})

/** Enqueue side: single INSERT. Simulates the sync tap path. */
function enqueue(seq: number, payload: Record<string, unknown>): void {
  senderDb.prepare(
    `INSERT INTO local_replication_queue (seq, payload_json, enqueued_at) VALUES (?, ?, ?)`
  ).run(seq, JSON.stringify(payload), Date.now())
}

/**
 * Flush step: read pending, "send" (apply to receiver), delete local.
 * Sending and deleting are separate statements so a crash between them
 * leaves the row for retry.
 *
 * `crashAfter` simulates a crash: after N successfully-delivered rows, we
 * return without deleting any more rows (partial progress, some delivered
 * but not acked).
 */
function flushOnce(batchSize: number, crashAfter?: number): { delivered: number; crashed: boolean } {
  const pending = senderDb.prepare<[number]>(
    `SELECT seq, payload_json, enqueued_at, attempt_count
     FROM local_replication_queue
     ORDER BY seq ASC
     LIMIT ?`
  ).all(batchSize) as QueueRow[]

  let delivered = 0
  for (const row of pending) {
    // "Send" — apply to receiver with idempotent INSERT OR IGNORE.
    receiverDb.prepare(
      `INSERT OR IGNORE INTO local_orders_replica (seq, payload_json, applied_at) VALUES (?, ?, ?)`
    ).run(row.seq, row.payload_json, Date.now())
    delivered += 1

    // Simulated crash: delivered but no ack.
    if (crashAfter !== undefined && delivered > crashAfter) {
      return { delivered, crashed: true }
    }

    // Ack by delete.
    senderDb.prepare(`DELETE FROM local_replication_queue WHERE seq = ?`).run(row.seq)
  }
  return { delivered, crashed: false }
}

describe('umbilical durable-tap recipe — crash during flush', () => {
  it('replicates exactly once end-to-end despite crash mid-flush', () => {
    // 1. Enqueue 100 entries
    for (let i = 1; i <= 100; i++) {
      enqueue(i, { order_id: `order-${i}`, amount: i * 10 })
    }
    expect(senderDb.prepare(`SELECT COUNT(*) AS n FROM local_replication_queue`).get()).toEqual({ n: 100 })

    // 2. Flush first 50 but crash after delivering 50 without acking anything beyond 30.
    //    The first 30 are cleanly delivered and acked. 31..50 are delivered but
    //    left in the queue (no delete landed).
    const first = flushOnce(50, 30)
    expect(first.crashed).toBe(true)
    expect(first.delivered).toBe(31)   // delivered 31, crashAfter=30 fires on the 31st

    // Sender queue state: 100 - 30 = 70 rows remain (rows 31..100)
    expect(senderDb.prepare(`SELECT COUNT(*) AS n FROM local_replication_queue`).get()).toEqual({ n: 70 })

    // Receiver state: 31 rows applied (1..31, all distinct seqs).
    expect(receiverDb.prepare(`SELECT COUNT(*) AS n FROM local_orders_replica`).get()).toEqual({ n: 31 })

    // 3. Restart: flush the rest in one batch.
    const second = flushOnce(1000)
    expect(second.crashed).toBe(false)
    expect(second.delivered).toBe(70)  // the remaining 31..100

    // 4. Final state
    //    Sender queue drained:
    expect(senderDb.prepare(`SELECT COUNT(*) AS n FROM local_replication_queue`).get()).toEqual({ n: 0 })
    //    Receiver has exactly 100 rows, one per original enqueue, no duplicates:
    const replicated = receiverDb.prepare(`SELECT seq FROM local_orders_replica ORDER BY seq`).all() as Array<{ seq: number }>
    expect(replicated.length).toBe(100)
    expect(replicated.map(r => r.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
  })

  it('repeated flush attempts are idempotent on the receiver (INSERT OR IGNORE)', () => {
    enqueue(1, { x: 'one' })
    enqueue(2, { x: 'two' })

    // Deliver twice — second call is a no-op on the receiver.
    flushOnce(1000)
    flushOnce(1000)   // queue is empty; no-op

    // Now replay the already-delivered rows by re-inserting into the queue.
    enqueue(1, { x: 'one' })
    enqueue(2, { x: 'two' })
    flushOnce(1000)

    const replicated = receiverDb.prepare(`SELECT seq FROM local_orders_replica ORDER BY seq`).all()
    expect(replicated).toEqual([{ seq: 1 }, { seq: 2 }])
  })

  it('a tap handler that throws keeps the row in the queue for retry', () => {
    enqueue(1, { a: 1 })
    enqueue(2, { b: 2 })

    // Simulate a failed send: apply to receiver, then ack step throws.
    try {
      const rows = senderDb.prepare(`SELECT * FROM local_replication_queue ORDER BY seq LIMIT 10`).all() as QueueRow[]
      for (const row of rows) {
        receiverDb.prepare(
          `INSERT OR IGNORE INTO local_orders_replica (seq, payload_json, applied_at) VALUES (?, ?, ?)`
        ).run(row.seq, row.payload_json, Date.now())
        if (row.seq === 1) {
          // Ack 1 succeeds
          senderDb.prepare(`DELETE FROM local_replication_queue WHERE seq = ?`).run(row.seq)
        } else {
          throw new Error('simulated handler failure mid-flush')
        }
      }
    } catch {
      // Expected
    }

    // Row 2 still in queue; row 1 acked.
    expect(senderDb.prepare(`SELECT COUNT(*) AS n FROM local_replication_queue`).get()).toEqual({ n: 1 })
    expect(senderDb.prepare(`SELECT seq FROM local_replication_queue`).get()).toEqual({ seq: 2 })
    // But receiver already saw 2 — the INSERT OR IGNORE on retry is a no-op.
    expect(receiverDb.prepare(`SELECT COUNT(*) AS n FROM local_orders_replica`).get()).toEqual({ n: 2 })

    // Retry: flush completes without double-application.
    flushOnce(1000)
    expect(senderDb.prepare(`SELECT COUNT(*) AS n FROM local_replication_queue`).get()).toEqual({ n: 0 })
    expect(receiverDb.prepare(`SELECT COUNT(*) AS n FROM local_orders_replica`).get()).toEqual({ n: 2 })
  })
})
