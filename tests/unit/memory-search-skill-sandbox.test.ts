import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../src/main/runtime/code-sandbox'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { DbQueryTool } from '../../src/main/tools/built-in/db-query.tool'
import { DbExecuteTool } from '../../src/main/tools/built-in/db-execute.tool'

/**
 * Runs skills/agent-memory/scripts/memory-search.js the way sys_lambda does,
 * inside the real sandbox worker, against the real db_query and db_execute
 * tools over a real ADF database. Audit blobs come from
 * AdfWorkspace.compactLoop, the path runtime compaction takes.
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

type Result = { results: Array<{ ref: string; date: string; text: string }>; indexed: { added: number; pending: number; complete: boolean; ms: number } }

function runner(workspace = ws) {
  const tools = { db_query: new DbQueryTool(), db_execute: new DbExecuteTool() }
  const calls: string[] = []
  const sql: string[] = []
  const onAdfCall = async (method: string, args: unknown): Promise<AdfCallResult> => {
    calls.push(method)
    if (method === 'db_query') sql.push((args as { sql: string }).sql)
    const tool = tools[method as keyof typeof tools]
    if (!tool) return { error: `tool ${method} not available`, errorCode: 'TOOL_ERROR' }
    const result = await tool.execute(args, workspace)
    return result.isError ? { error: String(result.content), errorCode: 'TOOL_ERROR' } : { result: String(result.content) }
  }
  return {
    calls,
    sql,
    async raw(args: Record<string, unknown>) {
      return sandbox.execute(`memory-search-test:${Math.random()}`, `${lambdaSource}\nreturn await search(${JSON.stringify(args)});`, 30000, onAdfCall)
    },
    async run(args: Record<string, unknown>): Promise<Result> {
      const out = await this.raw(args)
      expect(out.error).toBeUndefined()
      return JSON.parse(out.result!) as Result
    }
  }
}

const text = (t: string) => [{ type: 'text' as const, text: t }]
const DAY = Date.UTC(2026, 10, 20)

/** Append messages, then compact all but the last `keep` live rows into an audit blob. */
async function history(lines: string[], keep = 1): Promise<number[]> {
  const seqs = lines.map((l, i) => ws.appendToLoop(i % 2 ? 'assistant' : 'user', text(l), undefined, undefined, DAY))
  await ws.compactLoop(seqs.slice(seqs.length - keep), { content: text('Summary of earlier work.'), createdAt: DAY })
  return seqs
}

describe('memory-search skill in the real sandbox', () => {
  it('indexes a compressed audit blob on first search and cites the seq', async () => {
    const seqs = await history(['We chose the vendor Quillfeather for invoices.', 'Noted.', 'Anything else?'])
    const raw = ws.getDatabase().querySQL("SELECT data FROM adf_audit WHERE source = 'loop:main'") as Array<{ data: Buffer }>
    expect(raw).toHaveLength(1)
    expect(raw[0].data.includes(Buffer.from('Quillfeather'))).toBe(false) // only inside the brotli blob

    const r = runner()
    const out = await r.run({ query: 'which vendor quillfeather?' })
    expect(out.results[0].ref).toBe(`[S${seqs[0]}] main`)
    expect(out.results[0].date).toBe('2026-11-20')
    expect(out.results[0].text).toBe(`[[S${seqs[0]}] main · 2026-11-20] We chose the vendor Quillfeather for invoices.`)
    expect(out.indexed.complete).toBe(true)
    // db_query plus db_execute on its own local_ms_* tables; nothing else.
    expect([...new Set(r.calls)].sort()).toEqual(['db_execute', 'db_query'])
  })

  it('a second search adds only new rows, and a message live then archived appears once', async () => {
    const r = runner()
    const first = ws.appendToLoop('user', text('Budget owner is Marisol Pennywhistle.'), undefined, undefined, DAY)
    ws.appendToLoop('assistant', text('Got it.'), undefined, undefined, DAY)
    const a = await r.run({ query: 'Pennywhistle' })
    expect(a.indexed.added).toBe(2)
    expect(a.results.map(x => x.ref)).toEqual([`[S${first}] main`])

    const again = await r.run({ query: 'Pennywhistle' })
    expect(again.indexed.added).toBe(0)

    // Archive it (twice, as overlapping compactions do) and add one new live row.
    const later = ws.appendToLoop('user', text('Pennywhistle approved the spend.'), undefined, undefined, DAY)
    await ws.compactLoop([later], { content: text('Summary.'), createdAt: DAY })
    const blob = ws.getDatabase().querySQL("SELECT * FROM adf_audit WHERE source = 'loop:main'") as Array<Record<string, unknown>>
    ws.getDatabase().insertAudit('loop:main', { startSeq: blob[0].start_seq as number, endSeq: blob[0].end_seq as number, entryCount: blob[0].entry_count as number, sizeBytes: blob[0].size_bytes as number, data: blob[0].data as Buffer })
    expect(ws.getDatabase().querySQL('SELECT seq FROM adf_loop WHERE seq = ?', [first])).toHaveLength(0)

    const b = await r.run({ query: 'Pennywhistle', k: 20 })
    expect(b.indexed.added).toBe(2) // the new row and the compaction summary
    expect(b.results.map(x => x.ref).sort()).toEqual([`[S${first}] main`, `[S${later}] main`].sort())

    // Indexed audit rows are never decoded again.
    const blobReads = () => r.sql.filter(q => q.includes('data FROM adf_audit')).length
    const before = blobReads()
    expect((await r.run({ query: 'Pennywhistle' })).indexed.added).toBe(0)
    expect(blobReads()).toBe(before)
  })

  it('indexes what the agent sent through its communication tools, not other tool inputs', async () => {
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
      expect((await r.run({ query: word })).results.map(x => x.ref), word).toEqual([`[S${seq}] main`])
    }
    expect((await r.run({ query: 'wrotegarnet' })).results).toEqual([])
  })

  it('chunks a long message within the cap and finds the right chunk', async () => {
    const paras = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'filler '.repeat(40)}${i === 45 ? 'Saffronlake' : ''}`)
    const seq = ws.appendToLoop('user', text(paras.join('\n\n')), undefined, undefined, DAY)
    const out = await runner().run({ query: 'saffronlake' })
    expect(out.results).toHaveLength(1)
    expect(out.results[0].text).toContain('Paragraph 45')
    const rows = ws.getDatabase().querySQL('SELECT length(text) AS n FROM local_ms_chunks WHERE doc = ?', [`msg:${seq}`]) as Array<{ n: number }>
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) expect(row.n).toBeLessThanOrEqual(1800 + 40)
  })

  it('two overlapping searches neither fail nor duplicate chunks', async () => {
    for (let b = 0; b < 3; b++) await history(Array.from({ length: 100 }, (_, i) => `Blob ${b} line ${i} zebracorn`))
    for (let i = 0; i < 300; i++) ws.appendToLoop('user', text(`Live ${i} zebracorn`), undefined, undefined, DAY)
    const [a, b] = await Promise.all([runner().raw({ query: 'zebracorn', k: 20 }), runner().raw({ query: 'zebracorn', k: 20 })])
    expect(a.error).toBeUndefined()
    expect(b.error).toBeUndefined()
    const db = ws.getDatabase()
    const count = (sql: string) => (db.querySQL(sql) as Array<{ n: number }>)[0].n
    expect(count('SELECT count(*) AS n FROM local_ms_chunks')).toBe(count('SELECT count(*) AS n FROM (SELECT DISTINCT doc, n FROM local_ms_chunks)'))
    expect(count('SELECT count(*) AS n FROM local_ms_fts')).toBe(count('SELECT count(*) AS n FROM local_ms_chunks'))
    const after = await runner().run({ query: 'zebracorn', k: 20 })
    expect(after.indexed.complete).toBe(true)
    const refs = after.results.map(x => x.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('FTS special characters in the query do not throw', async () => {
    ws.appendToLoop('user', text('The config key is NEAR the top.'), undefined, undefined, DAY)
    const r = runner()
    for (const query of ['"unbalanced', 'a AND OR NOT (', 'NEAR(config, top) * ^col:x', "it's {x} -y +z", '***']) {
      const out = await r.run({ query })
      expect(Array.isArray(out.results), query).toBe(true)
    }
    expect((await r.run({ query: 'NEAR(config' })).results).toHaveLength(1)
  })

  it('validates arguments and handles an agent with no history', async () => {
    const r = runner()
    expect((await r.raw({ query: '   ' })).error).toMatch(/query must be a non-empty string/)
    expect((await r.raw({ query: 'x', k: 0 })).error).toMatch(/k must be a number/)
    expect((await r.raw({ query: 'x', k: -3 })).error).toMatch(/k must be a number/)
    const empty = await r.run({ query: 'anything', k: 1e9 })
    expect(empty.results).toEqual([])
    expect(empty.indexed.complete).toBe(true)
  })

  it('a spent budget leaves resumable state that completes on the next call', async () => {
    for (let b = 0; b < 4; b++) await history([`Batch ${b} mentions Tangerinebolt.`, 'ok', 'next'])
    ws.appendToLoop('user', text('Live Tangerinebolt.'), undefined, undefined, DAY)
    const r = runner()
    const first = await r.run({ query: 'tangerinebolt', budget_ms: 0 })
    expect(first.indexed.complete).toBe(false)
    expect(first.indexed.pending).toBeGreaterThan(0)
    const second = await r.run({ query: 'tangerinebolt', k: 20 })
    expect(second.indexed.complete).toBe(true)
    expect(second.indexed.pending).toBe(0)
    const refs = second.results.map(x => x.ref)
    expect(refs).toHaveLength(5)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('a call killed mid-write is redone cleanly on the next call', async () => {
    const seq = ws.appendToLoop('user', text('Orphan check Plumquartz.'), undefined, undefined, DAY)
    const r = runner()
    await r.run({ query: 'warmup' })
    expect(ws.getDatabase().querySQL('SELECT id FROM local_ms_chunks WHERE doc = ?', [`msg:${seq}`])).toHaveLength(1)
    // Simulate a cut after the chunk insert: no FTS row, no doc row.
    ws.getDatabase().executeSQL('DELETE FROM local_ms_fts WHERE rowid IN (SELECT id FROM local_ms_chunks WHERE doc = ?)', [`msg:${seq}`])
    ws.getDatabase().executeSQL('DELETE FROM local_ms_docs WHERE key = ?', [`msg:${seq}`])
    const out = await r.run({ query: 'plumquartz' })
    expect(out.indexed.added).toBe(1)
    expect(out.results).toHaveLength(1)
    expect(ws.getDatabase().querySQL('SELECT id FROM local_ms_chunks WHERE doc = ?', [`msg:${seq}`])).toHaveLength(1)
    expect(ws.getDatabase().querySQL('SELECT count(*) AS n FROM local_ms_fts')).toEqual(ws.getDatabase().querySQL('SELECT count(*) AS n FROM local_ms_chunks'))
  })

  it('reports clearly when db_execute is not enabled', async () => {
    const tools = { db_query: new DbQueryTool() }
    const onAdfCall = async (method: string, args: unknown): Promise<AdfCallResult> => {
      const tool = tools[method as keyof typeof tools]
      if (!tool) return { error: `Tool "${method}" is disabled`, errorCode: 'DISABLED' } // adf-call-handler's rejection
      const result = await tool.execute(args, ws)
      return result.isError ? { error: String(result.content), errorCode: 'TOOL_ERROR' } : { result: String(result.content) }
    }
    const out = await sandbox.execute(`memory-search-test:${Math.random()}`, `${lambdaSource}\nreturn await search({ query: 'x' });`, 30000, onAdfCall)
    expect(out.error).toMatch(/needs db_execute, which failed: Tool "db_execute" is disabled/)
  })
})
