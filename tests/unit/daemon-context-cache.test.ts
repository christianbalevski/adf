import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.restoreAllMocks() })
function workspace(file = ':memory:') {
  const ws = AdfWorkspace.create(file, { name: 'context-cache' })
  cleanup.push(() => ws.close())
  return ws
}
const content = [{ type: 'text' as const, text: 'answer' }]

describe('assistant usage snapshot', () => {
  it('reuses immutable rows, and keeps sibling-loop writes separate', () => {
    const ws = workspace(), db = ws.getDatabase()
    const seq = ws.appendToLoop('assistant', content, 'model', { input: 10, reasoning: 3 })
    ws.appendToLoop('user', content)
    const rows = ws.getAssistantTokenRows()
    expect(rows).toEqual([{ seq, tokens: { input: 10, reasoning: 3 } }])
    expect(ws.getAssistantTokenRows()).toBe(rows)
    expect(Object.isFrozen(rows)).toBe(true)
    expect(Object.isFrozen(rows[0])).toBe(true)
    expect(Object.isFrozen(rows[0].tokens)).toBe(true)
    expect(() => { (rows[0].tokens as { input: number }).input = 999 }).toThrow()
    db.appendLoopEntry('side', 'assistant', content, 'model', { input: 20 })
    expect(ws.getAssistantTokenRows()).toBe(rows)
    expect(ws.forLoop('side').getAssistantTokenRows()[0].tokens.input).toBe(20)
    // One connection retains one stream, not an ever-growing map of loops.
    expect(ws.getAssistantTokenRows()).not.toBe(rows)
    expect(ws.getAssistantTokenRows()).toEqual(rows)
  })

  it('invalidates append, update, compaction ordering, range/seq deletion and wipes', () => {
    const db = workspace().getDatabase()
    const a = db.appendLoopEntry('main', 'assistant', content, 'm', { input: 10 })
    const first = db.getAssistantTokenRows('main')
    const b = db.appendLoopEntry('main', 'assistant', content, 'm', { input: 20 })
    expect(db.getAssistantTokenRows('main')).not.toBe(first)
    const beforeContent = db.getAssistantTokenRows('main')
    db.updateLoopContent('main', a, [{ type: 'text', text: 'rewritten' }])
    expect(db.getAssistantTokenRows('main')).not.toBe(beforeContent)
    db.deleteLoopBySeqs('main', [a])
    // A newly appended summary sorts before the preserved assistant row.
    const summary = db.appendLoopEntry('main', 'assistant', content, 'm', { input: 5 }, undefined, { ord: a })
    expect(db.getAssistantTokenRows('main').map(r => r.seq)).toEqual([summary, b])
    db.deleteLoopBySeqRange('main', a, a)
    expect(db.getAssistantTokenRows('main').map(r => r.seq)).toEqual([b])
    db.clearLoop('main')
    expect(db.getAssistantTokenRows('main')).toEqual([])
    db.appendLoopEntry('side', 'assistant', content, 'm', { input: 1 })
    db.getAssistantTokenRows('side')
    db.clearAllLoops()
    expect(db.getAssistantTokenRows('side')).toEqual([])
  })

  it('does not leak transaction or savepoint snapshots across rollback', () => {
    const db = workspace().getDatabase()
    const seq = db.appendLoopEntry('main', 'assistant', content, 'm', { input: 10 })
    db.getAssistantTokenRows('main')
    expect(() => db.transaction(() => {
      db.clearLoop('main')
      db.appendLoopEntry('main', 'assistant', content, 'm', { input: 99 }, undefined, { seq })
      expect(db.getAssistantTokenRows('main')[0].tokens.input).toBe(99)
      throw new Error('rollback')
    })).toThrow('rollback')
    expect(db.getAssistantTokenRows('main')[0].tokens.input).toBe(10)
    db.transaction(() => {
      expect(() => db.transaction(() => {
        db.clearAllLoops()
        expect(db.getAssistantTokenRows('main')).toEqual([])
        throw new Error('savepoint')
      })).toThrow('savepoint')
      expect(db.getAssistantTokenRows('main')[0].tokens.input).toBe(10)
    })
    expect(db.getAssistantTokenRows('main')[0].tokens.input).toBe(10)
  })

  it('observes external commits and same-connection SQL writes, even with identical row identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-usage-cache-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'agent.adf'), ws = workspace(path), db = ws.getDatabase()
    ws.appendToLoop('assistant', content, 'm', { input: 10 })
    const external = new Database(path)
    cleanup.push(() => external.close())
    const before = ws.getAssistantTokenRows()
    external.exec('BEGIN')
    external.prepare('UPDATE adf_loop SET tokens = ?').run('{"input":20}')
    expect(ws.getAssistantTokenRows()).toBe(before)
    external.exec('COMMIT')
    expect(ws.getAssistantTokenRows()[0].tokens.input).toBe(20)
    db.executeSQL('UPDATE adf_loop SET tokens = ?', ['{"input":30}'])
    expect(ws.getAssistantTokenRows()[0].tokens.input).toBe(30)
    db.querySQL('UPDATE adf_loop SET tokens = ? RETURNING seq', ['{"input":40}'])
    expect(ws.getAssistantTokenRows()[0].tokens.input).toBe(40)
    external.prepare('UPDATE adf_loop SET tokens = ?').run('123')
    expect(ws.getAssistantTokenRows()).toEqual([])
    external.prepare('UPDATE adf_loop SET tokens = ?').run('broken JSON')
    expect(ws.getAssistantTokenRows()).toEqual([])
  })

  it('bounds retained row count and token payload size without truncating results', () => {
    const db = workspace().getDatabase()
    db.transaction(() => {
      for (let i = 0; i < 10_001; i++) db.appendLoopEntry('main', 'assistant', content, 'm', { input: i })
    })
    const large = db.getAssistantTokenRows('main')
    expect(large).toHaveLength(10_001)
    expect(db.getAssistantTokenRows('main')).not.toBe(large)
    db.clearLoop('main')
    db.appendLoopEntry('main', 'assistant', content, 'm', { input: 1 })
    db.executeSQL('UPDATE adf_loop SET tokens = ?', [JSON.stringify({ input: 1, extra: 'x'.repeat(512 * 1024) })])
    const oversized = db.getAssistantTokenRows('main')
    expect(oversized[0].tokens.input).toBe(1)
    expect(db.getAssistantTokenRows('main')).not.toBe(oversized)
  })
})
