import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../src/main/runtime/code-sandbox'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { DbQueryTool } from '../../src/main/tools/built-in/db-query.tool'

/**
 * Runs skills/agent-memory/scripts/memory-search.js the way sys_lambda does,
 * inside the real sandbox worker, against the real db_query tool over a real
 * ADF database. Audit blobs come from AdfWorkspace.compactLoop, the path
 * runtime compaction takes. db_query is the only tool offered.
 */

const repoRoot = resolve(import.meta.dirname, '../..')
const lambdaSource = readFileSync(resolve(repoRoot, 'skills/agent-memory/scripts/memory-search.js'), 'utf8')

const sandbox = new CodeSandboxService()
afterAll(() => sandbox.destroyAll?.())

let dir: string
let ws: AdfWorkspace

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-search-'))
  ws = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'memory-search' })
  const config = ws.getAgentConfig()
  config.context.audit = { loop: true, inbox: false, outbox: false }
  ws.setAgentConfig(config)
})

afterEach(() => {
  ws.close()
  rmSync(dir, { recursive: true, force: true })
})

type Hit = { ref: string; date: string; text: string }

function runner() {
  const tool = new DbQueryTool()
  const calls: string[] = []
  const onAdfCall = async (method: string, args: unknown): Promise<AdfCallResult> => {
    calls.push(method)
    if (method !== 'db_query') return { error: `Tool "${method}" is disabled`, errorCode: 'DISABLED' }
    const result = await tool.execute(args, ws)
    return result.isError ? { error: String(result.content), errorCode: 'TOOL_ERROR' } : { result: String(result.content) }
  }
  return {
    calls,
    async raw(args: Record<string, unknown>) {
      return sandbox.execute(`memory-search-test:${Math.random()}`, `${lambdaSource}\nreturn await search(${JSON.stringify(args)});`, 30000, onAdfCall)
    },
    async run(args: Record<string, unknown>): Promise<Hit[]> {
      const out = await this.raw(args)
      expect(out.error).toBeUndefined()
      const value = JSON.parse(out.result!) as { results: Hit[] }
      expect(Object.keys(value)).toEqual(['results'])
      return value.results
    }
  }
}

const text = (t: string) => [{ type: 'text' as const, text: t }]
const DAY = Date.UTC(2026, 10, 20)
const append = (role: 'user' | 'assistant', t: string, at = DAY) => ws.appendToLoop(role, text(t), undefined, undefined, at)

/** Append messages, then compact all but the last `keep` live rows into an audit blob. */
async function history(lines: string[], keep = 1): Promise<number[]> {
  const seqs = lines.map((l, i) => append(i % 2 ? 'assistant' : 'user', l))
  await ws.compactLoop(seqs.slice(seqs.length - keep), { content: text('Summary of earlier work.'), createdAt: DAY })
  return seqs
}

describe('memory-search skill in the real sandbox', () => {
  it('finds a term that exists only inside a compressed audit blob and cites the seq', async () => {
    const seqs = await history(['We chose the vendor Quillfeather for invoices.', 'Noted.', 'Anything else?'])
    const raw = ws.getDatabase().querySQL("SELECT data FROM adf_audit WHERE source = 'loop:main'") as Array<{ data: Buffer }>
    expect(raw).toHaveLength(1)
    expect(raw[0].data.includes(Buffer.from('Quillfeather'))).toBe(false) // only inside the brotli blob

    const r = runner()
    const results = await r.run({ query: 'which vendor quillfeather?' })
    expect(results[0]).toEqual({
      ref: `[S${seqs[0]}] main`,
      date: '2026-11-20',
      text: `[[S${seqs[0]}] main · 2026-11-20] We chose the vendor Quillfeather for invoices.`
    })
    expect(new Set(r.calls)).toEqual(new Set(['db_query'])) // default tools suffice; nothing is written
  })

  it('a message live and archived, or archived twice, appears once', async () => {
    const first = append('user', 'Budget owner is Marisol Pennywhistle.')
    append('assistant', 'Got it.')
    const later = append('user', 'Pennywhistle approved the spend.')
    await ws.compactLoop([later], { content: text('Summary.'), createdAt: DAY })
    const db = ws.getDatabase()
    // An overlapping compaction archives the same rows again.
    const [blob] = db.querySQL("SELECT * FROM adf_audit WHERE source = 'loop:main'") as Array<Record<string, unknown>>
    db.insertAudit('loop:main', { startSeq: blob.start_seq as number, endSeq: blob.end_seq as number, entryCount: blob.entry_count as number, sizeBytes: blob.size_bytes as number, data: blob.data as Buffer })
    // `later` is still live and also inside an archived copy.
    const json = Buffer.from(JSON.stringify([{ seq: later, role: 'user', content_json: text('Pennywhistle approved the spend.'), created_at: DAY }]))
    db.insertAudit('loop:main', { startSeq: later, endSeq: later, entryCount: 1, sizeBytes: json.length, data: brotliCompressSync(json) })

    const refs = (await runner().run({ query: 'Pennywhistle', k: 20 })).map(x => x.ref)
    expect(refs.sort()).toEqual([`[S${first}] main`, `[S${later}] main`].sort())
  })

  it('a message archived several times counts once in the ranking statistics', async () => {
    // Counted once, A (two hits on a rare term) outranks B. Counted three times,
    // A's term looks common, its idf drops, and B would come first.
    const a = append('user', 'Pennywhistle Pennywhistle approved it.')
    for (let i = 0; i < 4; i++) append('user', `Filler note ${i} about lunch.`)
    await ws.compactLoop([append('user', 'tail one')], { content: text('Summary.'), createdAt: DAY })
    const db = ws.getDatabase()
    const [blob] = db.querySQL("SELECT * FROM adf_audit WHERE source = 'loop:main'") as Array<Record<string, unknown>>
    for (let i = 0; i < 2; i++) {
      db.insertAudit('loop:main', { startSeq: blob.start_seq as number, endSeq: blob.end_seq as number, entryCount: blob.entry_count as number, sizeBytes: blob.size_bytes as number, data: blob.data as Buffer })
    }
    const b = append('user', 'Quorvant approved it too.')
    for (let i = 4; i < 8; i++) append('user', `Filler note ${i} about lunch.`)
    await ws.compactLoop([append('user', 'tail two')], { content: text('Summary.'), createdAt: DAY })
    expect((await runner().run({ query: 'pennywhistle quorvant' })).map(x => x.ref)).toEqual([`[S${a}] main`, `[S${b}] main`])
  })

  it('finds what the agent sent through its communication tools, not other tool inputs', async () => {
    const seq = ws.appendToLoop('assistant', [
      { type: 'tool_use', id: 't1', name: 'msg_send', input: { recipient: 'telegram:1', content: 'Deadline moved to March 3, invoice Inv77zeta.' } },
      { type: 'tool_use', id: 't2', name: 'say', input: { message: 'Chose vendor Quillmoss.' } },
      { type: 'tool_use', id: 't3', name: 'loop_send', input: { to_loop: 'planner', content: 'Plan around Harborlight.' } },
      { type: 'tool_use', id: 't4', name: 'ask', input: { questions: [{ question: 'Approve Cobaltfern?' }] } },
      { type: 'tool_use', id: 't5', name: 'fs_write', input: { path: 'x.md', content: 'Wrotegarnet' } }
    ], undefined, undefined, DAY)
    ws.appendToLoop('user', [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }], undefined, undefined, DAY)
    await ws.compactLoop([], { content: text('Summary.'), createdAt: DAY })
    const r = runner()
    for (const word of ['inv77zeta', 'quillmoss', 'harborlight', 'cobaltfern']) {
      expect((await r.run({ query: word })).map(x => x.ref), word).toEqual([`[S${seq}] main`])
    }
    expect(await r.run({ query: 'wrotegarnet' })).toEqual([])
  })

  it('returns the matching chunk of a long message, once', async () => {
    const paras = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'filler '.repeat(40)}${i === 45 || i === 50 ? 'Saffronlake' : ''}`)
    const seq = append('user', paras.join('\n\n'))
    const results = await runner().run({ query: 'saffronlake' })
    expect(results).toHaveLength(1) // two matching chunks, one ref
    expect(results[0].ref).toBe(`[S${seq}] main`)
    expect(results[0].text).toMatch(/Paragraph (45|50) /)
    expect(results[0].text.length).toBeLessThanOrEqual(1800 + 40)
  })

  it('its own earlier results do not echo into later searches', async () => {
    const [source] = await history(['The archive vendor is Velvetcrane.', 'ok', 'next'])
    for (let i = 0; i < 4; i++) append('user', `Unrelated note ${i} about lunch.`)
    const r = runner()
    for (let round = 0; round < 3; round++) {
      // What the runtime stores for a sys_lambda call: the tool_use, then the return value as the tool_result.
      const out = await r.raw({ query: 'velvetcrane vendor' })
      const id = `call${round}`
      ws.appendToLoop('assistant', [{ type: 'tool_use', id, name: 'sys_lambda', input: { source: 'skills/agent-memory/scripts/memory-search.js:search', args: { query: 'velvetcrane vendor' } } }], undefined, undefined, DAY)
      ws.appendToLoop('user', [{ type: 'tool_result', tool_use_id: id, content: out.result! }], undefined, undefined, DAY)
    }
    const results = await r.run({ query: 'velvetcrane vendor' })
    expect(results.map(x => x.ref)).toEqual([`[S${source}] main`])
  })

  it('ranks like SQLite FTS5 bm25 over the same chunks', async () => {
    const lines = [
      'alpha beta gamma', 'alpha alpha delta epsilon zeta', 'beta beta beta', 'alpha in a much longer message with many other words around it here',
      'gamma delta', 'beta alpha', 'unrelated words only', 'Her Résumé lists Zoë', 'resume resume alpha', 'alpha beta alpha beta alpha beta with tail', 'another unrelated line of text'
    ]
    lines.forEach((l, i) => append('user', l, DAY + i))
    const results = await runner().run({ query: 'the alpha beta RÉSUMÉ', k: 20 })

    const rows = ws.getDatabase().querySQL('SELECT seq, content_json, created_at FROM adf_loop') as Array<{ seq: number; content_json: string; created_at: number }>
    const fts = new Database(':memory:')
    fts.exec('CREATE VIRTUAL TABLE f USING fts5(ref UNINDEXED, text)')
    for (const r of rows) {
      const ref = `[S${r.seq}] main`
      const body = (JSON.parse(r.content_json) as Array<{ text: string }>)[0].text
      fts.prepare('INSERT INTO f (ref, text) VALUES (?, ?)').run(ref, `[${ref} · ${new Date(r.created_at).toISOString().slice(0, 10)}] ${body}`)
    }
    const expected = fts.prepare(`SELECT ref FROM f WHERE f MATCH '"alpha" OR "beta" OR "resume"' ORDER BY bm25(f), rowid`).all() as Array<{ ref: string }>
    fts.close()
    expect(expected.length).toBeGreaterThan(4)
    expect(results.map(x => x.ref)).toEqual(expected.map(x => x.ref))
  })

  it('validates arguments and handles an empty history and symbol-only queries', async () => {
    const r = runner()
    expect((await r.raw({ query: '   ' })).error).toMatch(/query must be a non-empty string/)
    for (const k of [0, -3, 'five']) expect((await r.raw({ query: 'x', k })).error).toMatch(/k must be a number/)
    expect(await r.run({ query: 'anything', k: 1e9 })).toEqual([])
    append('user', 'The config key is NEAR the top.')
    expect(await r.run({ query: '***' })).toEqual([])
    expect((await r.run({ query: 'NEAR(config "top' })).map(x => x.text)).toEqual([expect.stringContaining('NEAR the top')])
    for (let i = 0; i < 30; i++) append('user', `Topic Wrenfield item ${i}`)
    expect(await r.run({ query: 'wrenfield', k: 1e9 })).toHaveLength(20)
  })
})
