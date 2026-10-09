import { describe, expect, it } from 'vitest'
import {
  MAX_SEGMENTS,
  powerInputsFromConfig,
  scheduleIntervalMs,
  scoreAccess,
  scoreAutonomy,
  scoreExperience,
  scoreReach,
  toPowerStat,
  type PowerTableInputs
} from '../../../src/shared/utils/agent-stats'
import { DEFAULT_TOOLS, type AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AgentExperienceInputs, AgentPowerInputs, StatFactor } from '../../../src/shared/types/agent-vitals.types'

const NO_TABLES: PowerTableInputs = { credentials: { plain: 0, sealed: 0 }, privateKey: 'none', timers: { active: 0 } }

/** Shape of a freshly created agent: default tools, localhost, proactive, triggers as shipped. */
function defaultConfig(overrides: Partial<AgentConfig> = {}): Partial<AgentConfig> {
  return {
    id: '7c1d6f0e-3a52-4c8e-9a51-2b7f0d4e9c11',
    name: 'agent-1',
    handle: 'agent-1',
    autonomous: false,
    tools: DEFAULT_TOOLS.map((t) => ({ ...t })),
    messaging: { receive: true, mode: 'proactive', visibility: 'localhost', inbox_mode: true },
    security: { allow_unsigned: true, level: 1 },
    triggers: {
      on_inbox: { enabled: true, targets: [{ scope: 'agent' }] },
      on_chat: { enabled: true, targets: [{ scope: 'agent' }] },
      on_timer: { enabled: true, targets: [{ scope: 'system' }, { scope: 'agent' }] }
    },
    ...overrides
  }
}

function inputs(overrides: Partial<AgentConfig> = {}, tables: Partial<PowerTableInputs> = {}): AgentPowerInputs {
  return powerInputsFromConfig(defaultConfig(overrides), { ...NO_TABLES, ...tables })
}

function withTool(name: string, patch: { enabled?: boolean; restricted?: boolean }): Partial<AgentConfig> {
  const tools = DEFAULT_TOOLS.map((t) => (t.name === name ? { ...t, ...patch, visible: true } : { ...t }))
  return { tools }
}

const factor = (id: string, points: number, gated = false): StatFactor => ({ id, label: id, points, gated, configPath: id })

const EMPTY_XP: AgentExperienceInputs = {
  loopEntries: 0,
  filesWritten: 0,
  localTables: 0,
  localRows: 0,
  skills: 0,
  compactions: 0,
  agentsSpawned: 0,
  ageDays: 0
}

describe('toPowerStat', () => {
  it('caps at 5 segments and keeps segments = open + gated', () => {
    const s = toPowerStat([factor('a', 4), factor('b', 4, true)])
    expect(s.segments).toBe(MAX_SEGMENTS)
    expect(s.open).toBe(4)
    expect(s.gated).toBe(1)
    expect(s.rawPoints).toBe(8)
  })

  it('fills open segments before gated ones', () => {
    const s = toPowerStat([factor('a', 6), factor('b', 3, true)])
    expect(s).toMatchObject({ segments: 5, open: 5, gated: 0 })
  })

  it('applies mitigations to open points first, then gated', () => {
    expect(toPowerStat([factor('a', 2), factor('b', 2, true), factor('m', -1)])).toMatchObject({ segments: 3, open: 1, gated: 2 })
    expect(toPowerStat([factor('a', 1), factor('b', 2, true), factor('m', -2)])).toMatchObject({ segments: 1, open: 0, gated: 1 })
  })

  it('shows any nonzero capability as at least one segment', () => {
    expect(toPowerStat([factor('a', 0.25)])).toMatchObject({ segments: 1, open: 1 })
    expect(toPowerStat([])).toMatchObject({ segments: 0, open: 0, gated: 0 })
  })
})

describe('Access', () => {
  it('a default agent sits low', () => {
    const s = scoreAccess(inputs())
    expect(s.segments).toBeGreaterThanOrEqual(1)
    expect(s.segments).toBeLessThanOrEqual(3)
  })

  it('restricted tools count as gated, unrestricted as open', () => {
    const gated = scoreAccess(inputs(withTool('compute_exec', { enabled: true, restricted: true })))
    const open = scoreAccess(inputs(withTool('compute_exec', { enabled: true, restricted: false })))
    expect(gated.factors.find((f) => f.id === 'tool:compute_exec')).toMatchObject({ gated: true, configPath: 'tools.compute_exec' })
    expect(open.factors.find((f) => f.id === 'tool:compute_exec')?.gated).toBe(false)
    expect(open.open).toBeGreaterThan(gated.open)
  })

  it('host access and host compute targets add points', () => {
    const base = scoreAccess(inputs()).rawPoints
    const host = scoreAccess(inputs({ compute: { enabled: true, host_access: true } }))
    expect(host.rawPoints).toBeGreaterThan(base)
    expect(host.factors.map((f) => f.id)).toEqual(expect.arrayContaining(['compute:enabled', 'compute:host_access']))
    const target = scoreAccess(inputs({
      ...withTool('compute_exec', { enabled: true, restricted: true }),
      compute: { enabled: true, allowed_targets: ['isolated', 'host'] }
    }))
    expect(target.factors.find((f) => f.id === 'compute:host_target')).toMatchObject({ gated: true })
  })

  it('MCP servers: one factor each, gated when restricted, extra for credentials', () => {
    const s = scoreAccess(inputs({
      mcp: {
        servers: [
          { name: 'github', transport: 'stdio', restricted: true, env_keys: ['GITHUB_TOKEN'] },
          { name: 'files', transport: 'stdio' }
        ]
      }
    }))
    expect(s.factors.find((f) => f.id === 'mcp:github')?.gated).toBe(true)
    expect(s.factors.find((f) => f.id === 'mcp:github:credentials')).toBeDefined()
    expect(s.factors.find((f) => f.id === 'mcp:files')?.gated).toBe(false)
    expect(s.factors.find((f) => f.id === 'mcp:files:credentials')).toBeUndefined()
  })

  it('npm packages are capped', () => {
    const many = { code_execution: { packages: Array.from({ length: 40 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0' })) } } as Partial<AgentConfig>
    expect(scoreAccess(inputs(many)).factors.find((f) => f.id === 'code:packages')?.points).toBe(1)
  })

  it('credentials: sealed are gated, plain are open, shared cap', () => {
    const s = scoreAccess(inputs({}, { credentials: { plain: 2, sealed: 20 } }))
    const plain = s.factors.find((f) => f.id === 'identity:credentials_plain')!
    const sealed = s.factors.find((f) => f.id === 'identity:credentials_sealed')!
    expect(plain.gated).toBe(false)
    expect(sealed.gated).toBe(true)
    expect(plain.points + sealed.points).toBe(1.5)
  })

  it('an unsealed signing key is open and worth more than a sealed one', () => {
    const plain = scoreAccess(inputs({}, { privateKey: 'plain' })).factors.find((f) => f.id === 'identity:private_key')!
    const sealed = scoreAccess(inputs({}, { privateKey: 'sealed' })).factors.find((f) => f.id === 'identity:private_key')!
    expect(plain.gated).toBe(false)
    expect(sealed.gated).toBe(true)
    expect(plain.points).toBeGreaterThan(sealed.points)
  })

  it('everything on saturates at 5', () => {
    const tools = DEFAULT_TOOLS.map((t) => ({ ...t, enabled: true, restricted: false }))
    const s = scoreAccess(inputs({ tools, compute: { enabled: true, host_access: true, allowed_targets: ['host'] }, code_execution: { network: true } as AgentConfig['code_execution'] }, { privateKey: 'plain', credentials: { plain: 10, sealed: 0 } }))
    expect(s).toMatchObject({ segments: 5, open: 5, gated: 0 })
  })
})

describe('Reach', () => {
  it('visibility tiers are ordered', () => {
    const pts = (['off', 'directory', 'localhost', 'lan', 'public'] as const).map(
      (v) => scoreReach(inputs({ messaging: { receive: true, mode: 'listen_only', visibility: v } })).rawPoints
    )
    for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThan(pts[i - 1])
  })

  it('receive off removes inbound reach', () => {
    const s = scoreReach(inputs({ messaging: { receive: false, mode: 'listen_only', visibility: 'public' } }))
    expect(s.segments).toBe(0)
  })

  it('respond_only and listen_only reduce outbound', () => {
    const mode = (m: 'proactive' | 'respond_only' | 'listen_only'): number =>
      scoreReach(inputs({ messaging: { receive: true, mode: m, visibility: 'localhost' } })).rawPoints
    expect(mode('proactive')).toBeGreaterThan(mode('respond_only'))
    expect(mode('respond_only')).toBeGreaterThan(mode('listen_only'))
  })

  it('signed-only and allow lists are mitigations', () => {
    const open = scoreReach(inputs({ messaging: { receive: true, mode: 'listen_only', visibility: 'lan' } })).rawPoints
    const signed = scoreReach(inputs({ messaging: { receive: true, mode: 'listen_only', visibility: 'lan' }, security: { allow_unsigned: false } }))
    const listed = scoreReach(inputs({ messaging: { receive: true, mode: 'listen_only', visibility: 'lan', allow_list: ['did:key:z6Mk1'] } }))
    expect(signed.rawPoints).toBeLessThan(open)
    expect(signed.factors.find((f) => f.id === 'security:signed_only')?.points).toBeLessThan(0)
    expect(listed.rawPoints).toBeLessThan(open)
  })

  it('outbound send is gated when msg_send is restricted', () => {
    const s = scoreReach(inputs(withTool('msg_send', { enabled: true, restricted: true })))
    expect(s.factors.find((f) => f.id === 'messaging:send')?.gated).toBe(true)
  })

  it('public page, routes, shared files, adapters and ws connections add up and cap', () => {
    const s = scoreReach(inputs({
      messaging: { receive: true, mode: 'proactive', visibility: 'public' },
      serving: {
        public: { enabled: true },
        shared: { enabled: true },
        api: Array.from({ length: 6 }, (_, i) => ({ method: 'GET' as const, path: `/r${i}`, lambda: 'api.ts:handler' }))
      },
      adapters: { telegram: { enabled: true }, email: { enabled: false } },
      ws_connections: [{ id: 'a', url: 'wss://example.test', enabled: true }]
    }))
    expect(s.segments).toBe(5)
    expect(s.factors.find((f) => f.id === 'serving:api')?.points).toBe(1.5)
    expect(s.factors.find((f) => f.id === 'adapter:telegram')).toBeDefined()
    expect(s.factors.find((f) => f.id === 'adapter:email')).toBeUndefined()
  })
})

describe('Autonomy', () => {
  it('a default agent is low', () => {
    expect(scoreAutonomy(inputs()).segments).toBeLessThanOrEqual(2)
  })

  it('autonomous, autostart, fast timers raise it', () => {
    const base = scoreAutonomy(inputs()).rawPoints
    const s = scoreAutonomy(inputs({ autonomous: true, autostart: true }, { timers: { active: 3, fastestIntervalMs: 60_000 } }))
    expect(s.rawPoints).toBeGreaterThan(base)
    expect(s.factors.find((f) => f.id === 'timers:fastest')?.label).toBe('Wakes every 1 min')
  })

  it('on_chat does not count as a trigger', () => {
    const s = scoreAutonomy(inputs())
    expect(s.factors.find((f) => f.id === 'triggers')?.label).not.toContain('on_chat')
  })

  it('agent creation is gated when restricted', () => {
    const gated = scoreAutonomy(inputs(withTool('sys_create_adf', { enabled: true, restricted: true })))
    const open = scoreAutonomy(inputs(withTool('sys_create_adf', { enabled: true, restricted: false })))
    expect(gated.factors.find((f) => f.id === 'tool:sys_create_adf')?.gated).toBe(true)
    expect(open.factors.find((f) => f.id === 'tool:sys_create_adf')?.gated).toBe(false)
  })

  it('restricted tools reduce it, bounded', () => {
    const tools = DEFAULT_TOOLS.map((t) => ({ ...t, enabled: true, restricted: true }))
    const s = scoreAutonomy(inputs({ tools }))
    expect(s.factors.find((f) => f.id === 'tools:restricted')?.points).toBe(-1)
  })
})

describe('scheduleIntervalMs', () => {
  it('reads interval and simple cron minute steps', () => {
    expect(scheduleIntervalMs({ mode: 'interval', every_ms: 30_000 })).toBe(30_000)
    expect(scheduleIntervalMs({ mode: 'cron', cron: '*/15 * * * *' })).toBe(900_000)
    expect(scheduleIntervalMs({ mode: 'cron', cron: '* * * * *' })).toBe(60_000)
    expect(scheduleIntervalMs({ mode: 'cron', cron: '0 9 * * 1' })).toBeUndefined()
    expect(scheduleIntervalMs({ mode: 'once', at: 1 })).toBeUndefined()
  })
})

describe('Experience', () => {
  it('a brand-new agent is level 1 with zero progress', () => {
    const e = scoreExperience(EMPTY_XP)
    expect(e.level).toBe(1)
    expect(e.progress).toBe(0)
    expect(e.nextLevel.xp).toBeGreaterThan(0)
  })

  it('a first session reaches level 2-3', () => {
    const short = scoreExperience({ ...EMPTY_XP, loopEntries: 20, filesWritten: 1 })
    const typical = scoreExperience({ ...EMPTY_XP, loopEntries: 60, filesWritten: 3 })
    expect(short.level).toBeGreaterThanOrEqual(2)
    expect(typical.level).toBeLessThanOrEqual(3)
  })

  it('a heavily used months-old agent reaches level 10-12', () => {
    const heavy = scoreExperience({
      loopEntries: 30_000,
      filesWritten: 200,
      skills: 10,
      localTables: 8,
      localRows: 20_000,
      compactions: 150,
      agentsSpawned: 3,
      ageDays: 120
    })
    expect(heavy.level).toBeGreaterThanOrEqual(10)
    expect(heavy.level).toBeLessThanOrEqual(12)
  })

  it('is monotonic in every input', () => {
    const base: AgentExperienceInputs = { loopEntries: 500, filesWritten: 10, skills: 2, localTables: 1, localRows: 100, compactions: 3, agentsSpawned: 1, ageDays: 30 }
    const baseScore = scoreExperience(base).score
    for (const key of Object.keys(base) as Array<keyof AgentExperienceInputs>) {
      const more = scoreExperience({ ...base, [key]: (base[key] as number) * 2 + 1 })
      expect(more.score, key).toBeGreaterThan(baseScore)
      expect(more.level, key).toBeGreaterThanOrEqual(scoreExperience(base).level)
    }
  })

  it('goes down when the agent deletes its work', () => {
    const before = scoreExperience({ ...EMPTY_XP, loopEntries: 200, filesWritten: 40, skills: 3 })
    const after = scoreExperience({ ...EMPTY_XP, loopEntries: 200, filesWritten: 5, skills: 0 })
    expect(after.score).toBeLessThan(before.score)
  })

  it('skills weigh more than plain files', () => {
    expect(scoreExperience({ ...EMPTY_XP, skills: 1 }).score).toBeGreaterThan(scoreExperience({ ...EMPTY_XP, filesWritten: 1 }).score)
  })

  it('age alone does not level an idle agent', () => {
    expect(scoreExperience({ ...EMPTY_XP, ageDays: 365 }).level).toBe(1)
  })

  it('level boundaries: one level per doubling, progress in [0,1)', () => {
    for (let lv = 2; lv <= 14; lv++) {
      // Files only: score = 1 + n exactly, so n = 2^lv - 1 lands on the boundary.
      const at = scoreExperience({ ...EMPTY_XP, filesWritten: 2 ** lv - 1 })
      expect(at.level).toBe(lv)
      expect(at.progress).toBeCloseTo(0)
      expect(at.levelStart).toBe(2 ** lv)
      expect(at.nextLevelAt).toBe(2 ** (lv + 1))
    }
    const mid = scoreExperience({ ...EMPTY_XP, filesWritten: 11 })
    expect(mid.level).toBe(3)
    expect(mid.progress).toBeCloseTo(0.5)
  })

  it('next-level hint matches the remaining XP', () => {
    const e = scoreExperience({ ...EMPTY_XP, loopEntries: 60 })
    expect(e.nextLevel.xp).toBeCloseTo(e.nextLevelAt - e.score)
    expect(e.nextLevel.loopEntries).toBe(Math.ceil(e.nextLevel.xp / 0.1))
    expect(e.nextLevel.hint).toBe('Level 3 needs 1 more XP: about 10 loop messages, 1 file or 1 skill')
  })

  it('omits agents spawned when unknown', () => {
    const e = scoreExperience({ ...EMPTY_XP, agentsSpawned: null })
    expect(e.breakdown.find((b) => b.id === 'agentsSpawned')).toBeUndefined()
  })
})

describe('labels', () => {
  it('contain no em dashes', () => {
    const all = [
      ...scoreAccess(inputs({ compute: { enabled: true, host_access: true } }, { privateKey: 'plain', credentials: { plain: 1, sealed: 1 } })).factors,
      ...scoreReach(inputs({ serving: { public: { enabled: true } } })).factors,
      ...scoreAutonomy(inputs({ autonomous: true }, { timers: { active: 1, fastestIntervalMs: 7_200_000 } })).factors
    ]
    for (const f of all) expect(f.label).not.toContain('—')
    expect(scoreExperience(EMPTY_XP).nextLevel.hint).not.toContain('—')
  })
})
