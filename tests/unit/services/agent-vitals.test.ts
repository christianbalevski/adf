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
import { AgentVitalsService, type AgentVitalsDeps, type VitalsWorkspace } from '../../../src/main/services/agent-vitals'
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
    expect(v.maturity).toMatchObject({ loopEntries: 0, filesWritten: 0, localTables: 0, localRows: 0, skills: 0, compactions: 0 })
    expect(v.stats.experience.level).toBe(1)
    expect(v.cost7dUsd).toBe(1.25)
    expect(v.stats.access.points).toBeGreaterThan(0)
    expect(v.stats.reach.points).toBeGreaterThan(0)
  })

  it('counts the agent\'s own work and agrees between live and peeked reads', async () => {
    const ws = opened.find((w) => w.getFilePath() === fileB)!
    ws.writeFile('notes/plan.md', '# plan')
    ws.writeFile('skills/agent-skill/SKILL.md', '---\nname: agent-skill\ndescription: test skill\n---\nbody')
    // A real agent writes these long after creation; seed files stay inside the grace window.
    const later = new Date(Date.now() + 3_600_000).toISOString()
    ws.executeSQL("UPDATE adf_files SET updated_at = ? WHERE path IN ('notes/plan.md', 'skills/agent-skill/SKILL.md')", [later])
    ws.executeSQL('CREATE TABLE local_items (id INTEGER PRIMARY KEY, v TEXT)')
    ws.executeSQL("INSERT INTO local_items (v) VALUES ('a'), ('b'), ('c')")
    for (let i = 0; i < 4; i++) ws.appendToLoop(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `m${i}` }])
    ws.addTimer({ mode: 'interval', every_ms: 120_000 }, Date.now() + 120_000)

    const fake: Fake = { mesh: [], states: [], workspaces: [{ filePath: fileB, workspace: ws }], now: Date.now() }
    const svc = service(fake)
    const live = await svc.getAgentVitals(fileB, { force: true })
    expect(live.maturity).toMatchObject({ loopEntries: 4, filesWritten: 2, localTables: 1, localRows: 3, skills: 1 })
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
})
