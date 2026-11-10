import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { brotliCompressSync } from 'zlib'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { readArchivedChatPage, ARCHIVE_MAX_SNAPSHOT_BYTES } from '../../../src/main/adf/archived-loop-page'

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

describe('readArchivedChatPage', () => {
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
