import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../src/main/runtime/code-sandbox'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { DbQueryTool } from '../../src/main/tools/built-in/db-query.tool'
import { DbExecuteTool } from '../../src/main/tools/built-in/db-execute.tool'
import { FsListTool } from '../../src/main/tools/built-in/fs-list.tool'
import { FsReadTool } from '../../src/main/tools/built-in/fs-read.tool'

/**
 * Runs skills/agent-memory/scripts/memory-search.js the way sys_lambda does,
 * inside the real sandbox worker, against the real db_query, db_execute,
 * fs_list and fs_read tools over a real ADF database. Audit blobs come from
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

type Result = { results: Array<{ ref: string; date: string; text: string }>; indexed: { added: number; removed: number; skipped: number; pending: number; complete: boolean; ms: number } }

function runner(workspace = ws) {
  const tools = { db_query: new DbQueryTool(), db_execute: new DbExecuteTool(), fs_list: new FsListTool(), fs_read: new FsReadTool() }
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
    // Read tools plus db_execute on its own local_ms_* tables; nothing else.
    expect([...new Set(r.calls)].sort()).toEqual(['db_execute', 'db_query', 'fs_list', 'fs_read'])
  })

  it('a second search adds only new rows, and a message live then archived appears once', async () => {
    const r = runner()
    await r.run({ query: 'warmup' }) // index the files a new ADF starts with
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

  it('re-chunks an edited file, removes a deleted one, and skips binary', async () => {
    ws.writeFile('notes/plan.md', '# Plan\n\nThe launch codename is Bluefinch.')
    ws.writeFile('notes/old.md', 'Retired codename Graywhale.')
    ws.writeFileBuffer('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), 'image/png')
    const r = runner()
    const a = await r.run({ query: 'codename' })
    expect(a.results.map(x => x.ref).sort()).toEqual(['file:notes/old.md', 'file:notes/plan.md'])
    expect(a.indexed.skipped).toBe(1)

    ws.writeFile('notes/plan.md', '# Plan\n\nThe launch codename is now Redkite.')
    ws.deleteFile('notes/old.md', { force: true })
    const readsBefore = r.calls.filter(m => m === 'fs_read').length
    const b = await r.run({ query: 'codename bluefinch redkite graywhale' })
    expect(r.calls.filter(m => m === 'fs_read').length - readsBefore).toBe(1) // only the edited file
    expect(b.indexed.removed).toBe(1)
    expect(b.results).toHaveLength(1)
    expect(b.results[0].ref).toBe('file:notes/plan.md')
    expect(b.results[0].text).toContain('Redkite')
    expect(b.results[0].text).not.toContain('Bluefinch')

    const c = await r.run({ query: 'codename' })
    expect(c.indexed).toMatchObject({ added: 0, removed: 0, skipped: 0 }) // unchanged files are not re-read
    expect(r.calls.filter(m => m === 'fs_read').length - readsBefore).toBe(1)
  })

  it('chunks a large file within the size cap and searches it', async () => {
    const paras = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'filler '.repeat(40)}${i === 45 ? 'Saffronlake' : ''}`)
    ws.writeFile('big.md', paras.join('\n\n'))
    const out = await runner().run({ query: 'saffronlake' })
    expect(out.results).toHaveLength(1)
    expect(out.results[0].text).toContain('Paragraph 45')
    expect(out.results[0].text.length).toBeLessThanOrEqual(1900)
    const rows = ws.getDatabase().querySQL("SELECT length(text) AS n FROM local_ms_chunks WHERE doc = 'file:big.md'") as Array<{ n: number }>
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) expect(row.n).toBeLessThanOrEqual(1800 + 40)
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
    ws.writeFile('a.md', 'Tangerinebolt in a file.')
    const r = runner()
    const first = await r.run({ query: 'tangerinebolt', budget_ms: 0 })
    expect(first.indexed.complete).toBe(false)
    expect(first.indexed.pending).toBeGreaterThan(0)
    const second = await r.run({ query: 'tangerinebolt', k: 20 })
    expect(second.indexed.complete).toBe(true)
    expect(second.indexed.pending).toBe(0)
    const refs = second.results.map(x => x.ref)
    expect(refs.filter(x => x.startsWith('[S'))).toHaveLength(4)
    expect(refs).toContain('file:a.md')
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('a call killed mid-write is redone cleanly on the next call', async () => {
    const seq = ws.appendToLoop('user', text('Orphan check Plumquartz.'), undefined, undefined, DAY)
    const r = runner()
    await r.run({ query: 'warmup' })
    expect(ws.getDatabase().querySQL('SELECT id FROM local_ms_chunks WHERE doc = ?', [`msg:${seq}`])).toHaveLength(1)
    // Simulate a cut between the chunk insert and the doc row: drop the doc row only.
    ws.getDatabase().executeSQL("DELETE FROM local_ms_docs WHERE key = ?", [`msg:${seq}`])
    const out = await r.run({ query: 'plumquartz' })
    expect(out.indexed.added).toBe(1)
    expect(out.results).toHaveLength(1)
    expect(ws.getDatabase().querySQL('SELECT id FROM local_ms_chunks WHERE doc = ?', [`msg:${seq}`])).toHaveLength(1)
    expect(ws.getDatabase().querySQL('SELECT count(*) AS n FROM local_ms_fts')).toEqual(ws.getDatabase().querySQL('SELECT count(*) AS n FROM local_ms_chunks'))
  })

  it('reports clearly when db_execute is not enabled', async () => {
    const tools = { db_query: new DbQueryTool(), fs_list: new FsListTool(), fs_read: new FsReadTool() }
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
