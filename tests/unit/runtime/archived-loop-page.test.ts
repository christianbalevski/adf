import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { brotliCompressSync, constants as zlibConstants } from 'zlib'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import type { LoopEntryRow } from '../../../src/main/adf/adf-database'
import { readArchivedChatPage, ARCHIVE_MAX_SNAPSHOT_BYTES } from '../../../src/main/adf/archived-loop-page'
import { indexArchiveRows } from '../../../src/main/adf/archive-snapshot-index'

let rootDir: string
let ws: AdfWorkspace

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-archived-page-'))
  ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'archived-page' })
  const config = ws.getAgentConfig()
  config.context.audit = { loop: true, inbox: false, outbox: false }
  ws.setAgentConfig(config)
})

afterEach(() => {
  ws.close()
  rmSync(rootDir, { recursive: true, force: true })
})

function text(t: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: t }]
}

function contents(page: { uiLog: Array<{ content: string }> }): string[] {
  return page.uiLog.map(e => e.content)
}

/** Every archived row, walking pages from the live head the way Studio does. */
async function walk(workspace: AdfWorkspace, limit?: number): Promise<string[]> {
  const pages: string[][] = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const page = await readArchivedChatPage(workspace, cursor, { limit })
    if (page.uiLog.length > 0) pages.unshift(contents(page))
    if (!page.hasMore || page.cursor === null) break
    cursor = page.cursor
  }
  return pages.flat()
}

function db(workspace: AdfWorkspace): AdfDatabase {
  return (workspace as unknown as { db: AdfDatabase }).db
}

function archive(rows: LoopEntryRow[], workspace = ws): number {
  const seqs = rows.map((row) => row.seq)
  const json = Buffer.from(JSON.stringify(rows))
  return db(workspace).insertAudit('loop:main', {
    startSeq: Math.min(...seqs),
    endSeq: Math.max(...seqs),
    entryCount: rows.length,
    sizeBytes: json.length,
    data: brotliCompressSync(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }),
  })
}

function row(seq: number, label = `r${seq}`, ord?: number): LoopEntryRow {
  return { seq, ord, role: 'user', content_json: text(label), created_at: 1 }
}

describe('readArchivedChatPage', () => {
  it('seeks successive large pages without decoding again, including a shifted duplicate and live exclusion', async () => {
    const baseline = AdfWorkspace.create(join(rootDir, 'small.adf'), { name: 'small' })
    try {
      const label = (seq: number) => `内容 ${seq}, ["\\\\"]`
      const source = Array.from({ length: 130 }, (_, i) => row(i + 1, label(i + 1)))
      const padding = 'a'.repeat(525_000)
      for (const workspace of [ws, baseline]) {
        workspace.appendToLoop('user', text('live: omit the archived seq 1'))
        archive([row(10, 'older only', -1), row(94, 'earliest duplicate', 47)], workspace)
      }
      archive(source.toReversed().map((entry) => ({ ...entry, padding })))
      archive(source.toReversed(), baseline)
      const getBlob = vi.spyOn(ws, 'getAuditBlob')
      const tape = async (workspace: AdfWorkspace) => {
        const pages: Awaited<ReturnType<typeof readArchivedChatPage>>[] = []
        let cursor: string | null = '1000:1000'
        for (let i = 0; i < 10 && cursor; i++) {
          const page = await readArchivedChatPage(workspace, cursor, { limit: 23 })
          pages.push(page)
          cursor = page.hasMore ? page.cursor : null
        }
        return pages
      }
      const pages = await tape(ws)
      const control = await tape(baseline)
      expect(pages).toEqual(control)
      expect(pages.length).toBeGreaterThan(3)
      expect(pages.at(-1)?.hasMore).toBe(false)
      expect(pages.flatMap(contents)).toContain('earliest duplicate')
      expect(pages.flatMap(contents)).not.toContain(label(1))
      expect(getBlob.mock.calls).toEqual([[2], [1]])
    } finally {
      baseline.close()
    }
  })

  it('seeks successive pages in one decoded snapshot, including a display-order tie at the cursor', async () => {
    const oldAudit = archive([row(1)])
    const source = Array.from({ length: 600 }, (_, i) => row(i + 2))
    const summary = row(605, 'summary', 402)
    const recentAudit = archive([summary, ...source.slice().reverse()])
    const getBlob = vi.spyOn(ws, 'getAuditBlob')

    const first = await readArchivedChatPage(ws, null)
    expect(first.uiLog).toHaveLength(200)
    expect(first.cursor).toBe('402:605')
    expect(first.uiLog[0].content).toBe('summary')
    expect(first.hasMore).toBe(true)
    expect(getBlob.mock.calls).toEqual([[recentAudit]])

    const second = await readArchivedChatPage(ws, first.cursor)
    expect(second.uiLog).toHaveLength(200)
    expect(second.uiLog.at(-1)?.content).toBe('r402')
    expect(second.cursor).toBe('203:203')
    expect(second.hasMore).toBe(true)
    expect(getBlob.mock.calls).toEqual([[recentAudit]])

    const third = await readArchivedChatPage(ws, second.cursor)
    expect(third.uiLog).toHaveLength(200)
    expect(third.cursor).toBe('3:3')
    expect(third.hasMore).toBe(true)
    expect(getBlob.mock.calls).toEqual([[recentAudit]])

    const last = await readArchivedChatPage(ws, third.cursor)
    expect(contents(last)).toEqual(['r1', 'r2'])
    expect(last.hasMore).toBe(false)
    expect(getBlob.mock.calls).toEqual([[recentAudit], [oldAudit]])
  })

  it('uses the oldest copy in an overlapping snapshot even if its display key changed', async () => {
    const earliest = archive([row(10), row(20, 'original', 12)])
    archive([row(20, 'changed'), row(30)])
    const first = await readArchivedChatPage(ws, null, { limit: 2 })
    expect(contents(first)).toEqual(['original', 'r30'])
    expect(first.uiLog[0].id).toMatch(new RegExp(`^audit-${earliest}-`))
    expect(first.cursor).toBe('12:20')
    const second = await readArchivedChatPage(ws, first.cursor, { limit: 2 })
    expect(contents(second)).toEqual(['r10'])
    expect(second.hasMore).toBe(false)
  })

  it('peeks without walking live seqs and shares a concurrent decode', async () => {
    const seq = ws.appendToLoop('user', text('previous answer'))
    const live = ws.appendToLoop('user', text('still live'))
    await ws.compactLoop([live], { content: text('[Loop Compacted] summary') })
    const sequences = vi.spyOn(ws, 'listLoopSeqs')
    const blobs = vi.spyOn(ws, 'getAuditBlob')
    expect(await readArchivedChatPage(ws, null, { peek: true })).toMatchObject({ hasMore: true, uiLog: [] })
    expect(sequences).not.toHaveBeenCalled()
    expect(blobs).not.toHaveBeenCalled()

    const [first, second] = await Promise.all([
      readArchivedChatPage(ws, `${live}:${live}`),
      readArchivedChatPage(ws, `${live}:${live}`),
    ])
    expect(first).toEqual(second)
    expect(first.uiLog[0].metadata?.seq).toBe(seq)
    expect(blobs).toHaveBeenCalledOnce()
  })

  it('pages successive compactions in display order with summaries before their tails', async () => {
    ws.appendToLoop('user', text('first-1'))
    ws.appendToLoop('assistant', text('first-2'))
    const keep1 = ws.appendToLoop('user', text('tail-1'))
    await ws.compactLoop([keep1], { content: text('[Loop Compacted] summary one') })
    ws.appendToLoop('assistant', text('second-1'))
    const keep2 = ws.appendToLoop('user', text('tail-2'))
    await ws.compactLoop([keep2], { content: text('[Loop Compacted] summary two') })

    expect(await readArchivedChatPage(ws, null, { peek: true })).toMatchObject({ uiLog: [], hasMore: true })
    expect(await walk(ws)).toEqual(['first-1', 'first-2', 'summary one', 'tail-1', 'second-1'])
    // Same history, two rows at a time.
    expect(await walk(ws, 2)).toEqual(['first-1', 'first-2', 'summary one', 'tail-1', 'second-1'])

    const page = await readArchivedChatPage(ws, null)
    expect(page.uiLog.find(e => e.content === 'summary one')?.type).toBe('compaction')
    expect(page.uiLog.every(e => e.id.startsWith('audit-') && e.metadata?.archived === true)).toBe(true)
  })

  it('serves both snapshots that start at the same seq (rebuild, then compaction)', async () => {
    const a = ws.appendToLoop('user', text('a'))
    const b = ws.appendToLoop('assistant', [{ type: 'tool_use', id: 't1', name: 'fs_read', input: {} }] as never)
    const c = ws.appendToLoop('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] as never)
    const d = ws.appendToLoop('assistant', text('d'))
    // Rebuild that strips b/c (keeps seqs): audit #1 holds a..d.
    const kept = ws.getLoop().filter(e => e.seq !== b && e.seq !== c)
    await ws.replaceLoop(kept.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq, ord: e.ord })))
    const e = ws.appendToLoop('user', text('e'))
    // Compaction from the same first row: audit #2 starts at `a` too.
    await ws.compactLoop([e], { content: text('[Loop Compacted] s') })

    const rows = await walk(ws)
    expect(rows).toContain('a')
    expect(rows).toContain('d')
    expect(rows.filter(r => r === 'a')).toHaveLength(1)
    // The stripped tool call survives from the rebuild's snapshot.
    const page = await readArchivedChatPage(ws, null)
    expect(page.uiLog.some(x => x.type === 'tool_call')).toBe(true)
    void a; void d
  })

  it('merges a middle-slice clear into place instead of after newer rows', async () => {
    for (let i = 1; i <= 8; i++) ws.appendToLoop(i % 2 ? 'user' : 'assistant', text(`r${i}`))
    await ws.clearLoopSlice(3, 5) // r4, r5
    const last = ws.getLoop().at(-1)!.seq
    await ws.compactLoop([last], { content: text('[Loop Compacted] s') })
    expect(await walk(ws)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'])
  })

  it('leaves out rows a rebuild archived but kept live', async () => {
    ws.appendToLoop('assistant', [{ type: 'tool_use', id: 'x', name: 'fs_read', input: {} }] as never)
    ws.appendToLoop('user', text('u1'))
    ws.appendToLoop('assistant', text('a1'))
    const kept = ws.getLoop().slice(1)
    await ws.replaceLoop(kept.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq, ord: e.ord })))
    const page = await readArchivedChatPage(ws, null)
    expect(page.uiLog.map(e => e.type)).toEqual(['tool_call'])
  })

  it('reads a cleared stream and keeps loops apart', async () => {
    ws.appendToLoop('user', text('main-before-clear'))
    await ws.clearLoop()
    const side = ws.forLoop('scratch')
    side.appendToLoop('user', text('side-row'))
    await side.clearLoop()

    expect(await walk(ws)).toEqual(['main-before-clear'])
    expect(await walk(side)).toEqual(['side-row'])
  })

  it('skips a snapshot that inflates past the cap and counts it', async () => {
    ws.appendToLoop('user', text('readable'))
    await ws.clearLoop()
    // A small blob claiming a small size that inflates past the cap.
    const bomb = brotliCompressSync(Buffer.alloc(ARCHIVE_MAX_SNAPSHOT_BYTES + 1024, 0x20))
    db(ws).insertAudit('loop:main', { startSeq: 0, endSeq: 0, entryCount: 1, sizeBytes: 10, data: bomb })
    const rows = await walk(ws)
    expect(rows).toEqual(['readable'])
    let unreadable = 0
    let cursor: string | null = null
    for (;;) {
      const page = await readArchivedChatPage(ws, cursor)
      unreadable += page.unreadable
      if (!page.hasMore || !page.cursor) break
      cursor = page.cursor
    }
    expect(unreadable).toBe(1)
  })

  it('refuses a malformed cursor', async () => {
    await expect(readArchivedChatPage(ws, 'nope')).rejects.toThrow(/Invalid archive cursor/)
  })
})

describe('archive byte index', () => {
  it('indexes valid rows among other JSON values and preserves slices when sorting by ord', async () => {
    const a = row(2, '\u2603 quote " and backslash \\', 1)
    const b = row(1, 'some ])}+ delimiters', 1)
    const json = Buffer.from(`\t [ ${JSON.stringify(a)}, 1.2e10, {"k":[1,2]}, null, "[s]", ${JSON.stringify(b)} ] \r\n`)
    const index = await indexArchiveRows(json)
    expect(index?.length).toBe(2)
    expect(index?.positionAt(0)).toEqual({ key: 1, seq: 1 })
    expect(index?.rowAt(0)).toEqual(b)
    expect(index?.rowAt(1)).toEqual(a)
  })

  it.each(['[{},]', '[{} {}]', '[1] null', '["unclosed]', '[{"x":[1,2}]'])('rejects malformed arrays, including a bad suffix after a valid value: %s', async (json) => {
    await expect(indexArchiveRows(Buffer.from(json))).rejects.toThrow(SyntaxError)
  })

  it('defers duplicate and unsafe positions to the legacy reader', async () => {
    await expect(indexArchiveRows(Buffer.from(JSON.stringify([row(1), row(1)])))).resolves.toBeNull()
    await expect(indexArchiveRows(Buffer.from(JSON.stringify([row(2, 'bad ord', Number.MAX_SAFE_INTEGER + 1)])))).resolves.toBeNull()
  })
})
