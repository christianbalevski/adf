/**
 * AgentVitalsService.getAgentActivity / readAgentActivity against real .adf
 * files: upcoming wakes, recent events (tool-run grouping, failed results,
 * messages, files, log errors), per-day turns, knowledge filtering, the
 * ledger's per-day cost, caching, and the closed-file peek path.
 */

import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentVitalsService, readAgentActivity, type AgentVitalsDeps, type VitalsWorkspace } from '../../../src/main/services/agent-vitals'
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
  file_('skills-registry.json', iso(now))
  sql("UPDATE adf_files SET content = ? WHERE path = 'skills-registry.json'", [Buffer.from(JSON.stringify({ skills: { starter: {}, legacy: {} } }))])

  sql('CREATE TABLE local_notes (id INTEGER PRIMARY KEY, body TEXT)')
  sql("INSERT INTO local_notes (body) VALUES ('a'), ('b'), ('c')")

  // Timers: one expired, four live; the soonest three come back.
  const timer = (next: number, scope: string, payload: string | null, lambda: string | null, schedule: unknown, expired = 0): void =>
    sql('INSERT INTO adf_timers (schedule_json, next_wake_at, payload, scope, lambda, created_at, expired) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [JSON.stringify(schedule), next, payload, JSON.stringify([scope]), lambda, now - DAY, expired])
  timer(now + 5 * 60_000, 'agent', 'Check the inbox', null, { mode: 'interval', every_ms: 300_000 })
  timer(now + HOUR, 'system', null, 'lib/sync.ts:run', { mode: 'cron', cron: '0 * * * *' })
  timer(now + 2 * HOUR, 'agent', null, null, { mode: 'interval', every_ms: 7_200_000 })
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

  ws.addToInbox({ from: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', sender_alias: 'agent-2', content: 'ping', received_at: now - 20 * 60_000, status: 'unread' })
  ws.addToOutbox({ from: 'did:key:self', to: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', content: 'pong', created_at: now - 10 * 60_000, status: 'sent' })
  sql("INSERT INTO adf_logs (level, origin, event, message, created_at) VALUES ('error', 'lambda', 'error', ?, ?)", ['Lambda crashed: boom\nstack...', now - 5 * 60_000])
})

describe('readAgentActivity', () => {
  it('reads the next three live timers with scope and a label', () => {
    const a = readAgentActivity((s, p) => ws.querySQL(s, p), now)
    expect(a.upcoming.map((t) => [t.scope, t.label])).toEqual([
      ['agent', 'Check the inbox'],
      ['system', 'lib/sync.ts:run'],
      ['agent', 'Every 2 h']
    ])
    expect(a.upcoming[0].at).toBe(now + 5 * 60_000)
  })

  it('merges recent events newest first and folds consecutive same-tool calls', () => {
    const a = readAgentActivity((s, p) => ws.querySQL(s, p), now)
    expect(a.recent.map((e) => [e.kind, e.label, e.count])).toEqual([
      ['error', 'Lambda crashed: boom', undefined],
      ['message_out', 'did:key:z6MkpTHR…vktH', undefined],
      ['message_in', 'agent-2', undefined],
      ['turn', 'critic', undefined],
      ['turn', 'main', undefined],
      ['error', 'fs_read failed', undefined],
      ['tool', 'fs_read', undefined],
      ['tool', 'fs_write', 3]
    ])
    expect(a.recent[3].loop).toBe('critic')
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

  it('knows agent skills, local tables and agent-written files; starter and derived files excluded', () => {
    const a = readAgentActivity((s, p) => ws.querySQL(s, p), now)
    expect(a.knowledge.skills).toEqual(['legacy', 'research'])
    expect(a.knowledge.tables).toEqual([{ name: 'local_notes', rows: 3 }])
    expect(a.knowledge.files.map((f) => f.path)).toEqual(['notes/today.md', 'skills/research/SKILL.md'])
    expect(a.knowledge.filesTotal).toBe(2)
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
    expect(cached.knowledge).toEqual(a.knowledge)

    file_('notes/later.md', iso(now))
    clock.now = now + 10_000
    const fresh = await svc.getAgentActivity(file)
    expect(fresh.computedAt).toBe(now + 10_000)
    expect(fresh.knowledge.filesTotal).toBe(3)
    expect(fresh.recent.some((e) => e.kind === 'file' && e.label === 'notes/later.md')).toBe(true)
  })

  it('reads a closed file through a readonly peek', async () => {
    ws.close()
    opened.splice(opened.indexOf(ws), 1)
    const a = await service(false, { now }).getAgentActivity(file)
    expect(a.live).toBe(false)
    expect(a.knowledge.tables).toEqual([{ name: 'local_notes', rows: 3 }])
    expect(a.upcoming).toHaveLength(3)
    ws = AdfWorkspace.open(file)
    opened.push(ws)
  })
})
