/**
 * AgentVitalsService.getAgentActivity / readAgentActivity against real .adf
 * files: upcoming wakes (raw lambda/input, loop/prompt), per-day messages
 * and cost from the file's loop rows, contents (counts and approximate
 * tokens), caching, and the closed-file peek path. The per-day computation
 * itself is covered in agent-daily.test.ts.
 */

import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentVitalsService, FORCE_MIN_INTERVAL_MS, HEAVY_MIN_AGE_MS, memoryBytes, readAgentActivity, readMemoryStrata, type AgentVitalsDeps, type VitalsWorkspace } from '../../../src/main/services/agent-vitals'
import { localDateKey } from '../../../src/shared/utils/date-key'
import { DEFAULT_MIND_LOG_CONTENT } from '../../../src/shared/types/adf-v02.types'

const dir = mkdtempSync(join(tmpdir(), 'adf-agent-activity-'))
const file = join(dir, 'agent-1.adf')
const opened: AdfWorkspace[] = []
const agentId = randomUUID()

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.now()
const created = new Date(now - 20 * DAY).toISOString()
const iso = (ms: number): string => new Date(ms).toISOString()

let ws: AdfWorkspace

afterAll(() => {
  for (const w of opened) try { w.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function sql(statement: string, params: unknown[] = []): void {
  ws.executeSQL(statement, params)
}

function loopRow(role: 'user' | 'assistant', content: unknown[], at: number, loop = 'main'): void {
  sql('INSERT INTO adf_loop (role, content_json, created_at, loop) VALUES (?, ?, ?, ?)', [role, JSON.stringify(content), at, loop])
}

function file_(path: string, updatedAt: string): void {
  sql(
    'INSERT OR REPLACE INTO adf_files (path, content, mime_type, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [path, Buffer.from(`# ${path}`), 'text/markdown', path.length + 2, updatedAt, updatedAt]
  )
}

beforeAll(() => {
  ws = AdfWorkspace.create(file, { name: 'agent-1' })
  opened.push(ws)
  ws.setAgentConfig({ ...ws.getAgentConfig(), id: agentId })
  ws.setMeta('adf_created_at', created)
  // Everything seeded at creation is a starter file.
  sql('UPDATE adf_files SET updated_at = ?, created_at = ?', [created, created])

  // Starter skill (at creation), agent skill, agent file, derived registry.
  file_('skills/starter/SKILL.md', created)
  file_('skills/research/SKILL.md', iso(now - 2 * HOUR))
  file_('notes/today.md', iso(now - HOUR))
  file_('mind/people.md', iso(now - HOUR))
  file_('mind/old.md', iso(now - 8 * DAY))
  file_('skills-registry.json', iso(now))
  sql("UPDATE adf_files SET content = ? WHERE path = 'skills-registry.json'", [Buffer.from(JSON.stringify({ skills: { starter: {}, legacy: {} } }))])

  sql('CREATE TABLE local_notes (id INTEGER PRIMARY KEY, body TEXT)')
  sql("INSERT INTO local_notes (body) VALUES ('a'), ('b'), ('c')")

  // Timers: one expired, four live; the soonest three come back.
  const timer = (next: number, scope: string, payload: string | null, lambda: string | null, schedule: unknown, expired = 0, loop: string | null = null): void =>
    sql('INSERT INTO adf_timers (schedule_json, next_wake_at, payload, scope, lambda, created_at, expired, loop) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [JSON.stringify(schedule), next, payload, JSON.stringify([scope]), lambda, now - DAY, expired, loop])
  timer(now + 5 * 60_000, 'agent', 'Check the inbox', null, { mode: 'interval', every_ms: 300_000 })
  timer(now + HOUR, 'system', '{"full":true}', 'lib/sync.ts:run', { mode: 'cron', cron: '0 * * * *' })
  timer(now + 2 * HOUR, 'agent', 'x'.repeat(1200), null, { mode: 'interval', every_ms: 7_200_000 }, 0, 'critic')
  timer(now + 3 * HOUR, 'agent', 'Too late to show', null, { mode: 'once', at: now + 3 * HOUR })
  timer(now + 60_000, 'agent', 'Expired', null, { mode: 'once', at: now + 60_000 }, 1)

  // Loop: a turn three days ago, then today a run of fs_write calls, a failed
  // fs_read and a finished turn in a side loop.
  loopRow('user', [{ type: 'text', text: 'hello' }], now - 3 * DAY)
  loopRow('assistant', [{ type: 'text', text: 'hi' }], now - 3 * DAY + 1000)
  loopRow('user', [{ type: 'text', text: 'write notes' }], now - 50 * 60_000)
  loopRow('assistant', [{ type: 'tool_use', id: 't1', name: 'fs_write', input: {} }, { type: 'tool_use', id: 't2', name: 'fs_write', input: {} }], now - 49 * 60_000)
  loopRow('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'tool_result', tool_use_id: 't2', content: 'ok' }], now - 48 * 60_000)
  loopRow('assistant', [{ type: 'tool_use', id: 't3', name: 'fs_write', input: {} }], now - 47 * 60_000)
  loopRow('user', [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }], now - 46 * 60_000)
  loopRow('assistant', [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', id: 't4', name: 'fs_read', input: {} }], now - 45 * 60_000)
  loopRow('user', [{ type: 'tool_result', tool_use_id: 't4', content: 'not found', is_error: true }], now - 44 * 60_000)
  loopRow('assistant', [{ type: 'text', text: 'done' }], now - 43 * 60_000)
  loopRow('assistant', [{ type: 'text', text: 'critic done' }], now - 30 * 60_000, 'critic')
  // Not JSON: skipped, never fails the read.
  sql("INSERT INTO adf_loop (role, content_json, created_at, loop) VALUES ('user', 'not json', ?, 'main')", [now - 29 * 60_000])
})

describe('readAgentActivity', () => {
  it('reads the next three live timers as raw pieces', () => {
    const a = readAgentActivity((s, p) => ws.querySQL(s, p), now)
    expect(a.upcoming[0]).toEqual({ id: expect.any(Number), at: now + 5 * 60_000, scope: 'agent', loop: 'main', prompt: 'Check the inbox' })
    expect(a.upcoming[1]).toEqual({ id: expect.any(Number), at: now + HOUR, scope: 'system', lambda: 'lib/sync.ts:run', input: '{"full":true}' })
    expect(a.upcoming[2]).toEqual(expect.objectContaining({ scope: 'agent', loop: 'critic' }))
    expect(a.upcoming[2].prompt).toHaveLength(1000)
    expect(a.upcoming[2].prompt?.endsWith('…')).toBe(true)
    expect(a.upcoming).toHaveLength(3)
    expect('recent' in a).toBe(false)
  })

  it('counts messages of every role and loop per local day, today last', () => {
    const a = readAgentActivity((s, p) => ws.querySQL(s, p), now)
    expect(a.daily).toHaveLength(14)
    expect(a.daily[13].date).toBe(localDateKey(new Date(now)))
    const byDate = Object.fromEntries(a.daily.map((d) => [d.date, d.messages]))
    expect(byDate[localDateKey(new Date(now - 3 * DAY + 1000))]).toBeGreaterThanOrEqual(1)
    expect(a.daily.reduce((n, d) => n + d.messages, 0)).toBe(12)
    expect(a.daily.some((d) => d.estimated || d.costUsd !== undefined || d.costPartial)).toBe(false)
  })

  it('sums mind, agent skills and local tables; starter skills and derived files excluded', () => {
    const q = (s: string, p?: unknown[]): unknown[] => ws.querySQL(s, p)
    const a = readAgentActivity(q, now)
    const mind = q("SELECT path, size FROM adf_files WHERE path LIKE 'mind/%'") as Array<{ path: string; size: number }>
    expect(mind.length).toBeGreaterThan(0)
    // The seeded mind/log.md header is not memory, here as in memoryTokens and the strata.
    expect(mind.some((f) => f.path === 'mind/log.md')).toBe(true)
    const bytes = mind.reduce((n, f) => n + memoryBytes(f.path, f.size), 0)
    expect(bytes).toBe(mind.reduce((n, f) => n + f.size, 0) - Buffer.byteLength(DEFAULT_MIND_LOG_CONTENT))
    // Only people.md is inside the last 7 days: old.md and the seeded files are older.
    const { items: mindItems, ...mindTotals } = a.contents.mind
    expect(mindTotals).toEqual({ files: mind.length, tokens: Math.round(bytes / 4), updatedThisWeek: 1, strata: readMemoryStrata(q, now) })
    // Every mind/ file, newest first (people.md was updated an hour ago).
    expect(mindItems?.map((f) => f.path).sort()).toEqual(mind.map((f) => f.path).sort())
    expect(mindItems?.[0]).toEqual({ path: 'mind/people.md', tokens: Math.round(('mind/people.md'.length + 2) / 4), updatedAt: iso(now - HOUR) })
    // research (file) + legacy (registry only, 0 tokens); starter excluded.
    const researchTokens = Math.round('# skills/research/SKILL.md'.length / 4)
    expect(a.contents.skills).toEqual({
      count: 2,
      tokens: researchTokens,
      // Per skill, largest first: the bookshelf's spines.
      items: [
        { name: 'research', tokens: researchTokens, files: 1 },
        { name: 'legacy', tokens: 0, files: 0 }
      ]
    })
    expect(a.contents.tables).toEqual({ count: 1, rows: 3, items: [{ name: 'local_notes', rows: 3, columns: 2 }] })
  })

  it('scans incrementally from the last high-water seq', () => {
    const q = (s: string, p?: unknown[]): unknown[] => ws.querySQL(s, p)
    const first = readAgentActivity(q, now)
    expect(first.dayScan.rows.size).toBe(12)
    const firstLastSeq = first.dayScan.lastSeq
    loopRow('assistant', [{ type: 'text', text: 'another' }], now - 60_000)
    const next = readAgentActivity(q, now, first.dayScan)
    expect(next.dayScan.lastSeq).toBeGreaterThan(firstLastSeq)
    expect(next.daily.reduce((n, d) => n + d.messages, 0)).toBe(13)
    sql("DELETE FROM adf_loop WHERE content_json LIKE '%another%'")
    expect(readAgentActivity(q, now, next.dayScan).daily.reduce((n, d) => n + d.messages, 0)).toBe(12)
  })

  it('adds compacted history from adf_audit, marked estimated', () => {
    sql("INSERT INTO adf_audit (source, start_seq, end_seq, entry_count, size_bytes, data, created_at) VALUES ('loop:main', 900001, 900004, 4, 1, x'00', ?)", [now - 2 * DAY])
    const a = readAgentActivity((s, p) => ws.querySQL(s, p), now)
    expect(a.daily.reduce((n, d) => n + d.messages, 0)).toBe(16)
    expect(a.daily.some((d) => d.estimated)).toBe(true)
    sql("DELETE FROM adf_audit WHERE source = 'loop:main'")
  })
})

describe('readMemoryStrata', () => {
  const sw = AdfWorkspace.create(join(dir, 'agent-2.adf'), { name: 'agent-2' })
  opened.push(sw)
  const q = (st: string, p?: unknown[]): unknown[] => sw.querySQL(st, p)
  const put = (path: string, bytes: number, updatedMs: number): void => {
    sw.executeSQL(
      'INSERT OR REPLACE INTO adf_files (path, content, mime_type, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [path, Buffer.alloc(bytes, 'a'), 'text/markdown', bytes, iso(updatedMs), iso(updatedMs)]
    )
  }

  it('splits mind/ bytes by updated_at age, boundaries in the younger band', () => {
    sw.executeSQL("DELETE FROM adf_files WHERE path LIKE 'mind/%'")
    put('mind/w-edge.md', 400, now - 7 * DAY)
    put('mind/w.md', 400, now - HOUR)
    put('mind/m-start.md', 800, now - 7 * DAY - 1)
    put('mind/m-edge.md', 800, now - 30 * DAY)
    put('mind/q-start.md', 1200, now - 30 * DAY - 1)
    put('mind/q-edge.md', 1200, now - 90 * DAY)
    put('mind/o.md', 4000, now - 90 * DAY - 1)
    put('notes/not-mind.md', 9999, now)
    expect(readMemoryStrata(q, now)).toEqual({ week: 200, month: 400, quarter: 600, older: 1000 })
  })

  it('takes the seeded log header off mind/log.md only', () => {
    sw.executeSQL("DELETE FROM adf_files WHERE path LIKE 'mind/%'")
    const seed = Buffer.byteLength(DEFAULT_MIND_LOG_CONTENT)
    put('mind/log.md', seed, now - 100 * DAY)
    expect(readMemoryStrata(q, now)).toEqual({ week: 0, month: 0, quarter: 0, older: 0 })
    put('mind/log.md', seed + 400, now - HOUR)
    put('mind/other.md', seed, now - HOUR)
    expect(readMemoryStrata(q, now).week).toBe(Math.round((400 + seed) / 4))
  })
})

describe('AgentVitalsService.getAgentActivity', () => {
  function service(open: boolean, clock: { now: number }): AgentVitalsService {
    const deps: AgentVitalsDeps = {
      isMeshRunning: () => false,
      getLiveMeshAgents: () => [],
      getTrackedDirectories: () => [dir],
      getMaxScanDepth: () => 5,
      listAdfFiles: async () => [file],
      getContextGauge: () => undefined,
      getWsConnectionCount: () => undefined,
      getLiveExecStates: () => [],
      getOpenWorkspaces: () => (open ? [{ filePath: file, workspace: ws as VitalsWorkspace }] : []),
      now: () => clock.now
    }
    return new AgentVitalsService(deps)
  }

  it('reads cost from the loop rows, shares it with the vitals, and caches until the database changes', async () => {
    const clock = { now }
    const svc = service(true, clock)
    sql("INSERT INTO adf_loop (role, content_json, model, tokens, created_at, loop) VALUES ('assistant', '[]', 'm', ?, ?, 'main')", [JSON.stringify({ input: 10, output: 5, cost_usd: 0.42 }), now - 60_000])
    sql("INSERT INTO adf_loop (role, content_json, model, tokens, created_at, loop) VALUES ('assistant', '[]', 'm', ?, ?, 'main')", [JSON.stringify({ input: 10, output: 5 }), now - 50_000])
    const a = await svc.getAgentActivity(file)
    expect(a.live).toBe(true)
    expect(a.filePath).toBe(file)
    expect(a.daily[13]).toEqual(expect.objectContaining({ costUsd: 0.42, costPartial: true }))
    expect(a.daily[12].costUsd).toBeUndefined()
    const v = await svc.getAgentVitals(file)
    expect(v).toMatchObject({ cost7dUsd: 0.42, cost7dPartial: true })
    sql("DELETE FROM adf_loop WHERE content_json = '[]'")

    // Inside the live minimum interval: the cached read, untouched.
    clock.now = now + 1_000
    expect((await svc.getAgentActivity(file)).computedAt).toBe(a.computedAt)
    // Past it, nothing written: same key, the read is only re-stamped.
    clock.now = now + 5_000
    const cached = await svc.getAgentActivity(file)
    expect(cached.computedAt).toBe(now + 5_000)
    expect(cached.contents).toEqual(a.contents)

    // A write inside HEAVY_MIN_AGE_MS: wakes re-read, the scanned contents reused.
    file_('mind/later.md', iso(now))
    sql("UPDATE adf_timers SET payload = 'moved' WHERE id = ?", [a.upcoming[0].id])
    clock.now = now + 10_000
    const cheap = await svc.getAgentActivity(file)
    expect(cheap.computedAt).toBe(now + 10_000)
    expect(cheap.upcoming[0]).toEqual(expect.objectContaining({ id: a.upcoming[0].id }))
    expect(JSON.stringify(cheap.upcoming[0])).toContain('moved')
    expect(cheap.contents).toEqual(a.contents)

    // Past it, the next change re-reads the scans too.
    sql("UPDATE adf_timers SET payload = 'moved again' WHERE id = ?", [a.upcoming[0].id])
    clock.now = now + HEAVY_MIN_AGE_MS + 1
    const fresh = await svc.getAgentActivity(file)
    expect(fresh.contents.mind.files).toBe(a.contents.mind.files + 1)
    sql("DELETE FROM adf_files WHERE path = 'mind/later.md'")
    sql("UPDATE adf_timers SET payload = 'Check the inbox' WHERE id = ?", [a.upcoming[0].id])
  })

  it('force re-reads the scans, at most every FORCE_MIN_INTERVAL_MS', async () => {
    const clock = { now }
    const svc = service(true, clock)
    const a = await svc.getAgentActivity(file)
    file_('mind/forced.md', iso(now))
    // Too soon after the last scan: force re-reads the cheap part only.
    clock.now = now + FORCE_MIN_INTERVAL_MS - 1
    const early = await svc.getAgentActivity(file, { force: true })
    expect(early.computedAt).toBe(clock.now)
    expect(early.contents).toEqual(a.contents)
    clock.now = now + FORCE_MIN_INTERVAL_MS
    const forced = await svc.getAgentActivity(file, { force: true })
    expect(forced.contents.mind.files).toBe(a.contents.mind.files + 1)
    sql("DELETE FROM adf_files WHERE path = 'mind/forced.md'")
  })

  it('reads a closed file through a readonly peek', async () => {
    ws.close()
    opened.splice(opened.indexOf(ws), 1)
    const a = await service(false, { now }).getAgentActivity(file)
    expect(a.live).toBe(false)
    expect(a.contents.tables).toEqual({ count: 1, rows: 3, items: [{ name: 'local_notes', rows: 3, columns: 2 }] })
    expect(a.upcoming).toHaveLength(3)
    ws = AdfWorkspace.open(file)
    opened.push(ws)
  })
})
