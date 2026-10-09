/**
 * AgentVitalsService: the fleet status rows extracted from the IPC module
 * (refactor safety) and the overview card's slow read (maturity counts and
 * stat inputs), for both a closed file (readonly peek) and an open workspace.
 */

import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { AgentVitalsService, FORCE_MIN_INTERVAL_MS, HEAVY_MIN_AGE_MS, readContextsWorked, readSummaryScan, type AgentVitalsDeps, type VitalsWorkspace } from '../../../src/main/services/agent-vitals'
import { DEFAULT_MIND_LOG_CONTENT, type AgentConfig } from '../../../src/shared/types/adf-v02.types'
import { appendAdfAttestation, createAttestation } from '../../../src/main/services/attestation.service'
import { extractRawPublicKey, generateEd25519KeyPair, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import type { AgentState, MeshAgentStatus } from '../../../src/shared/types/ipc.types'

const dir = mkdtempSync(join(tmpdir(), 'adf-agent-vitals-'))
const fileA = join(dir, 'agent-1.adf')
const fileB = join(dir, 'agent-2.adf')
const opened: AdfWorkspace[] = []

afterAll(() => {
  for (const ws of opened) try { ws.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function create(filePath: string, name: string): AdfWorkspace {
  const ws = AdfWorkspace.create(filePath, { name })
  opened.push(ws)
  return ws
}

interface Fake {
  mesh: MeshAgentStatus[]
  states: Array<{ filePath: string; state: AgentState }>
  workspaces: Array<{ filePath: string; workspace: VitalsWorkspace }>
  now: number
}

function service(fake: Fake): AgentVitalsService {
  const deps: AgentVitalsDeps = {
    isMeshRunning: () => fake.mesh.length > 0,
    getLiveMeshAgents: () => fake.mesh,
    getTrackedDirectories: () => [dir],
    getMaxScanDepth: () => 5,
    listAdfFiles: async () => [fileA, fileB].filter((f) => existsSync(f)),
    getContextGauge: (fp) => (fake.states.some((s) => s.filePath === fp) ? { tokens: 1200, threshold: 100_000 } : undefined),
    getWsConnectionCount: () => 2,
    getLiveExecStates: () => fake.states,
    getOpenWorkspaces: () => fake.workspaces,
    getAgentCost: () => ({ usd: 1.25, partial: false }),
    now: () => fake.now
  }
  return new AgentVitalsService(deps)
}

describe('fleet status (moved out of the IPC module)', () => {
  it('reports a closed file as an offline ghost with peeked metadata', async () => {
    const ws = create(fileA, 'agent-1')
    ws.setMeta('status', 'reading the inbox')
    const peekedBefore = (() => { ws.close(); opened.splice(opened.indexOf(ws), 1); return AdfDatabase.peekFleetMeta(fileA)! })()

    const fake: Fake = { mesh: [], states: [], workspaces: [], now: 1_000 }
    const svc = service(fake)
    const result = await svc.getFleetStatus()
    expect(result.running).toBe(false)
    expect(result.agents).toHaveLength(1)
    const row = result.agents[0]
    expect(row).toMatchObject({
      filePath: fileA,
      handle: peekedBefore.handle,
      did: peekedBefore.did ?? undefined,
      agentId: peekedBefore.agentId ?? undefined,
      state: 'off',
      online: false,
      participating: false,
      status: 'reading the inbox',
      statusSince: 1_000,
      trackedDirRoot: dir,
      contextTokens: undefined
    })

    // Status age sticks while the line is unchanged.
    fake.now = 5_000
    expect((await svc.getFleetStatus()).agents[0].statusSince).toBe(1_000)
  })

  it('reads a live agent from its open workspace and overlays its state', async () => {
    const ws = AdfWorkspace.open(fileA)
    opened.push(ws)
    const fake: Fake = { mesh: [], states: [{ filePath: fileA, state: 'idle' }], workspaces: [{ filePath: fileA, workspace: ws }], now: 2_000 }
    const row = (await service(fake).getFleetStatus()).agents[0]
    expect(row).toMatchObject({ handle: 'agent-1', state: 'idle', online: true, contextTokens: 1200, contextThreshold: 100_000 })
  })

  it('passes mesh agents through with ws connections and skips their files in the scan', async () => {
    const mesh: MeshAgentStatus = { filePath: fileA, handle: 'agent-1', state: 'active', participating: true } as MeshAgentStatus
    const fake: Fake = { mesh: [mesh], states: [], workspaces: [], now: 3_000 }
    const result = await service(fake).getFleetStatus()
    expect(result.running).toBe(true)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]).toMatchObject({ handle: 'agent-1', online: true, wsConnections: 2, participating: true })
  })
})

describe('agent vitals', () => {
  it('a brand-new agent: Lv 1, no files counted, header facts filled', async () => {
    const ws = create(fileB, 'agent-2')
    const fake: Fake = { mesh: [], states: [], workspaces: [{ filePath: fileB, workspace: ws }], now: Date.now() }
    const v = await service(fake).getAgentVitals(fileB)
    expect(v.live).toBe(true)
    expect(v.handle).toBe('agent-2')
    expect(v.maturity).toMatchObject({ contextsWorked: 0, messages: 0, filesWritten: 0, localTables: 0, localRows: 0, skills: 0 })
    expect(v.stats.experience.level).toBe(1)
    expect(v.metrics).toEqual([])
    expect(v.cost7dUsd).toBe(1.25)
    expect(v.stats.access.points).toBeGreaterThan(0)
    expect(v.stats.reach.points).toBeGreaterThan(0)
  })

  it('counts the agent\'s own work and agrees between live and peeked reads', async () => {
    const ws = opened.find((w) => w.getFilePath() === fileB)!
    ws.writeFile('notes/plan.md', '# plan')
    const seededMind = (ws.querySQL("SELECT COALESCE(SUM(size), 0) AS n FROM adf_files WHERE path LIKE 'mind/%'")[0] as { n: number }).n
    ws.writeFile('mind/memory.md', 'x'.repeat(4_000))
    ws.setMeta('metric:tickets_closed', '42')
    ws.setMeta('metric:a_rate', '0.93')
    ws.writeFile('skills/agent-skill/SKILL.md', '---\nname: agent-skill\ndescription: test skill\n---\nbody')
    // A real agent writes these long after creation; seed files stay inside the grace window.
    const later = new Date(Date.now() + 3_600_000).toISOString()
    ws.executeSQL("UPDATE adf_files SET updated_at = ? WHERE path IN ('notes/plan.md', 'skills/agent-skill/SKILL.md', 'mind/memory.md')", [later])
    ws.executeSQL('CREATE TABLE local_items (id INTEGER PRIMARY KEY, v TEXT)')
    ws.executeSQL("INSERT INTO local_items (v) VALUES ('a'), ('b'), ('c')")
    for (let i = 0; i < 4; i++) ws.appendToLoop(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `m${i}` }])
    ws.addTimer({ mode: 'interval', every_ms: 120_000 }, Date.now() + 120_000)

    const fake: Fake = { mesh: [], states: [], workspaces: [{ filePath: fileB, workspace: ws }], now: Date.now() }
    const svc = service(fake)
    const live = await svc.getAgentVitals(fileB, { force: true })
    // mind/ counts as memory tokens (bytes / 4), not as a file.
    expect(live.maturity).toMatchObject({ messages: 4, filesWritten: 2, memoryTokens: Math.round((seededMind - Buffer.byteLength(DEFAULT_MIND_LOG_CONTENT) + 4_000) / 4), localTables: 1, localRows: 3, skills: 1 })
    expect(live.metrics).toEqual([{ name: 'a_rate', value: '0.93' }, { name: 'tickets_closed', value: '42' }])
    expect(live.nextWakeAt).toBeGreaterThan(Date.now())
    expect(live.stats.autonomy.factors.find((f) => f.id === 'timers:fastest')?.label).toBe('Wakes every 2 min')

    // Cached: an unchanged live connection is not re-read.
    const again = await svc.getAgentVitals(fileB)
    expect(again.computedAt).toBe(live.computedAt)

    ws.close()
    opened.splice(opened.indexOf(ws), 1)
    fake.workspaces = []
    const peeked = await svc.getAgentVitals(fileB)
    expect(peeked.live).toBe(false)
    expect(peeked.maturity).toEqual(live.maturity)
    expect(peeked.metrics).toEqual(live.metrics)
    expect(peeked.stats.access).toEqual(live.stats.access)
    expect(peeked.contextTokens).toBeUndefined()
  })

  it('counts children from the last fleet scan', async () => {
    const parent = AdfDatabase.peekFleetMeta(fileB)!
    const ws = AdfWorkspace.open(fileA)
    opened.push(ws)
    ws.getDatabase().setMeta('adf_parent_did', parent.did ?? parent.agentId!, 'readonly')
    ws.close()
    opened.splice(opened.indexOf(ws), 1)

    const fake: Fake = { mesh: [], states: [], workspaces: [], now: Date.now() }
    const svc = service(fake)
    expect((await svc.getAgentVitals(fileB)).maturity.agentsSpawned).toBeNull()
    await svc.getFleetStatus()
    expect((await svc.getAgentVitals(fileB)).maturity.agentsSpawned).toBe(1)
  })

  it('counts the agent age', async () => {
    const fake: Fake = { mesh: [], states: [], workspaces: [], now: Date.now() + 3 * 86_400_000 }
    const v = await service(fake).getAgentVitals(fileB)
    expect(v.maturity.ageDays).toBeGreaterThan(2.9)
    expect(v.ageDays).toBe(v.maturity.ageDays)
  })

  it('card face: status, description, public flag and a verified owner attestation', async () => {
    const file = join(dir, 'agent-3.adf')
    const ws = create(file, 'agent-3')
    const fake: Fake = { mesh: [], states: [], workspaces: [{ filePath: file, workspace: ws }], now: Date.now() }
    const svc = service(fake)
    const bare = await svc.getAgentVitals(file)
    expect(bare).toMatchObject({ public: false, ownerVerified: false })
    expect(bare.status).toBeUndefined()

    const did = (k: { publicKey: Buffer }): string => publicKeyToDid(extractRawPublicKey(k.publicKey))
    const agentKey = generateEd25519KeyPair()
    const ownerKey = generateEd25519KeyPair()
    const config = ws.getAgentConfig()
    ws.setAgentConfig({ ...config, description: ' Syncs the ledger. ', serving: { ...config.serving, public: { enabled: true } } } as AgentConfig)
    ws.setMeta('status', 'Reconciling March')
    ws.setMeta('adf_did', did(agentKey))
    appendAdfAttestation(ws, createAttestation({ issuer: did(ownerKey), subject: did(agentKey), role: 'owner', issued_at: new Date().toISOString() }, ownerKey.privateKey))

    const v = await svc.getAgentVitals(file, { force: true })
    expect(v).toMatchObject({ status: 'Reconciling March', description: 'Syncs the ledger.', public: true, ownerVerified: true })

    // An attestation about another subject does not count.
    ws.setMeta('adf_did', did(generateEd25519KeyPair()))
    expect((await svc.getAgentVitals(file, { force: true })).ownerVerified).toBe(false)
  })
})

describe('vitals cache ages', () => {
  it('a running agent: cheap parts follow every write, scans wait HEAVY_MIN_AGE_MS unless forced', async () => {
    const file = join(dir, 'agent-4.adf')
    const ws = create(file, 'agent-4')
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const write = (path: string): void => {
      ws.writeFile(path, 'x')
      ws.executeSQL('UPDATE adf_files SET updated_at = ? WHERE path = ?', [later, path])
    }
    const t0 = Date.now()
    const fake: Fake = { mesh: [], states: [], workspaces: [{ filePath: file, workspace: ws }], now: t0 }
    const svc = service(fake)
    const first = await svc.getAgentVitals(file)
    expect(first.maturity.filesWritten).toBe(0)

    // Inside HEAVY_MIN_AGE_MS the database moved: status and messages are new, the file scan is not.
    write('notes/a.md')
    ws.setMeta('status', 'Writing notes')
    ws.appendToLoop('user', [{ type: 'text', text: 'hi' }])
    fake.now = t0 + 10_000
    const cheap = await svc.getAgentVitals(file)
    expect(cheap.status).toBe('Writing notes')
    expect(cheap.maturity.messages).toBe(1)
    expect(cheap.maturity.filesWritten).toBe(0)

    // Forced: the scans re-read.
    fake.now = t0 + 11_000
    expect((await svc.getAgentVitals(file, { force: true })).maturity.filesWritten).toBe(1)

    // A second force inside FORCE_MIN_INTERVAL_MS re-reads the cheap part only.
    write('notes/b.md')
    ws.setMeta('status', 'Still writing')
    fake.now = t0 + 11_000 + FORCE_MIN_INTERVAL_MS - 1
    const spam = await svc.getAgentVitals(file, { force: true })
    expect(spam.status).toBe('Still writing')
    expect(spam.maturity.filesWritten).toBe(1)

    // Past HEAVY_MIN_AGE_MS the next change re-reads the scans unforced.
    ws.setMeta('status', 'Done')
    fake.now = t0 + 11_000 + HEAVY_MIN_AGE_MS
    expect((await svc.getAgentVitals(file)).maturity.filesWritten).toBe(2)
  })
})

describe('compaction summary scan', () => {
  it('is incremental and drops rows that are gone', () => {
    const ws = create(join(dir, 'summary.adf'), 'agent-5')
    const q = (sql: string, params?: unknown[]): unknown[] => ws.querySQL(sql, params)
    ws.appendToLoop('user', [{ type: 'text', text: '[Loop Compacted] one' }])
    ws.appendToLoop('assistant', [{ type: 'text', text: 'ok' }])
    const first = readSummaryScan(q)
    expect(first.hits).toHaveLength(1)
    ws.appendToLoop('user', [{ type: 'text', text: '[Loop Compacted] two' }])
    const next = readSummaryScan(q, first)
    expect(next.hits).toHaveLength(2)
    // Rows below the high-water mark are not matched again.
    expect(readSummaryScan(q, { ...next, hits: [] }).hits).toEqual([])
    ws.executeSQL('DELETE FROM adf_loop WHERE seq = ?', [first.hits[0].seq])
    expect(readSummaryScan(q, next).hits).toEqual([next.hits[1]])
  })
})

describe('contexts worked', () => {
  let n = 0
  const fresh = (): AdfWorkspace => create(join(dir, `ctx-${++n}.adf`), `agent-${n + 2}`)
  const q = (ws: AdfWorkspace) => (sql: string, params?: unknown[]): unknown[] => ws.querySQL(sql, params)
  const baseline = (ws: AdfWorkspace, tokens: number, loop?: string): void => {
    ws.getDatabase().setMeta(loop ? `context_baseline_tokens:${loop}` : 'context_baseline_tokens', JSON.stringify({ tokens, estimated: false, updated_at: 1 }), 'readonly')
  }
  const audit = (ws: AdfWorkspace, source: string, tokens: number): void => {
    ws.getDatabase().insertAudit(source, { entryCount: 10, sizeBytes: tokens * 4, data: Buffer.from('x') })
  }
  const text = (s: string) => [{ type: 'text' as const, text: s }]

  it('one compaction is about one full current loop', () => {
    const compacted = fresh()
    audit(compacted, 'loop:main', 90_000)
    const full = fresh()
    full.appendToLoop('user', text('hi'))
    baseline(full, 100_000)
    expect(readContextsWorked(q(compacted), {})).toBe(1)
    expect(readContextsWorked(q(full), {})).toBe(1)
  })

  it('sums every loop, current and past, against the threshold of each loop', () => {
    const ws = fresh()
    const db = ws.getDatabase()
    audit(ws, 'loop', 80_000) // legacy main snapshot: 1
    audit(ws, 'loop:scout', 60_000) // deleted side loop: 1
    audit(ws, 'loop:main', 5_000) // slice clear: 5k / (100k / 2) = 0.1
    db.appendLoopEntry('main', 'user', text('hi'))
    baseline(ws, 25_000) // main fill 0.25
    // Side loop without a baseline: row bytes / 4 against its own 20k threshold, about 0.5.
    db.appendLoopEntry('helper', 'assistant', text('x'.repeat(39_970)))
    const config = { loops: [{ name: 'helper', compact_threshold: 20_000 }] } as unknown as Partial<AgentConfig>
    expect(readContextsWorked(q(ws), config)).toBeCloseTo(2.85, 1)
    // Fill is capped at one context per loop.
    baseline(ws, 500_000)
    expect(readContextsWorked(q(ws), config)).toBeCloseTo(3.6, 1)
  })

  it('falls back to live compaction summaries when loop audit is off', () => {
    const ws = fresh()
    ws.appendToLoop('user', text('[Loop Compacted] summary'))
    baseline(ws, 0)
    expect(readContextsWorked(q(ws), {})).toBe(1)
  })
})
