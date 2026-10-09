/**
 * AgentVitalsService.getAgentActivity / readAgentActivity against real .adf
 * files: upcoming wakes (raw lambda/input, loop/prompt), per-day turns,
 * contents (counts and approximate tokens), the
 * ledger's per-day cost, caching, and the closed-file peek path.
 */

import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentVitalsService, FORCE_MIN_INTERVAL_MS, HEAVY_MIN_AGE_MS, readAgentActivity, type AgentVitalsDeps, type VitalsWorkspace } from '../../../src/main/services/agent-vitals'
import { localDateKey } from '../../../src/shared/utils/date-key'

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

  it('counts finished turns per local day, today last', () => {
    const a = readAgentActivity((s, p) => ws.querySQL(s, p), now)
    expect(a.daily).toHaveLength(14)
    expect(a.daily[13].date).toBe(localDateKey(new Date(now)))
    const byDate = Object.fromEntries(a.daily.map((d) => [d.date, d.turns]))
    expect(byDate[localDateKey(new Date(now - 3 * DAY + 1000))]).toBe(1)
    expect(a.daily.reduce((n, d) => n + d.turns, 0)).toBe(3)
    expect(a.dailyPartial).toBe(false)
  })

  it('sums mind, agent skills and local tables; starter skills and derived files excluded', () => {
    const q = (s: string, p?: unknown[]): unknown[] => ws.querySQL(s, p)
    const a = readAgentActivity(q, now)
    const mind = q("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM adf_files WHERE path LIKE 'mind/%'")[0] as { n: number; bytes: number }
    expect(mind.n).toBeGreaterThan(0)
    // Only people.md is inside the last 7 days: old.md and the seeded files are older.
    expect(a.contents.mind).toEqual({ files: mind.n, tokens: Math.round(mind.bytes / 4), updatedThisWeek: 1 })
    // research (file) + legacy (registry only, 0 tokens); starter excluded.
    expect(a.contents.skills).toEqual({ count: 2, tokens: Math.round('# skills/research/SKILL.md'.length / 4) })
    expect(a.contents.tables).toEqual({ count: 1, rows: 3 })
  })

  it('scans turns incrementally from the last high-water seq', () => {
    const q = (s: string, p?: unknown[]): unknown[] => ws.querySQL(s, p)
    const first = readAgentActivity(q, now)
    expect(first.turnScan.times).toHaveLength(3)
    loopRow('assistant', [{ type: 'text', text: 'another' }], now - 60_000)
    const next = readAgentActivity(q, now, first.turnScan)
    expect(next.turnScan.lastSeq).toBeGreaterThan(first.turnScan.lastSeq)
    expect(next.daily.reduce((n, d) => n + d.turns, 0)).toBe(4)
    // A scan it already did is not redone: a prior with an invented time stays counted.
    const seeded = readAgentActivity(q, now, { ...next.turnScan, times: [...next.turnScan.times, now - 2 * DAY] })
    expect(seeded.daily.reduce((n, d) => n + d.turns, 0)).toBe(5)
    sql("DELETE FROM adf_loop WHERE content_json LIKE '%another%'")
  })

  it('flags the window partial when a loop snapshot was archived inside it', () => {
    sql("INSERT INTO adf_audit (source, start_seq, end_seq, entry_count, size_bytes, data, created_at) VALUES ('loop', 1, 2, 2, 1, x'00', ?)", [now - 2 * DAY])
    expect(readAgentActivity((s, p) => ws.querySQL(s, p), now).dailyPartial).toBe(true)
    sql("DELETE FROM adf_audit WHERE source = 'loop'")
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
      getAgentDailyCost: (id, dates) => (id === agentId ? { [dates[dates.length - 1]]: { usd: 0.42, partial: true } } : {}),
      now: () => clock.now
    }
    return new AgentVitalsService(deps)
  }

  it('adds the ledger cost to its day and caches until the database changes', async () => {
    const clock = { now }
    const svc = service(true, clock)
    const a = await svc.getAgentActivity(file)
    expect(a.live).toBe(true)
    expect(a.filePath).toBe(file)
    expect(a.daily[13]).toEqual(expect.objectContaining({ costUsd: 0.42, costPartial: true }))
    expect(a.daily[12].costUsd).toBeUndefined()

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
    expect(a.contents.tables).toEqual({ count: 1, rows: 3 })
    expect(a.upcoming).toHaveLength(3)
    ws = AdfWorkspace.open(file)
    opened.push(ws)
  })
})
