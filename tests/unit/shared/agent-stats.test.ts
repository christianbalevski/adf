import { describe, expect, it } from 'vitest'
import {
  EXPERIENCE_CURVE,
  POWER_CURVE,
  POWER_HIGH_OPEN_LEVEL,
  levelForXp,
  levelPosition,
  powerInputsFromConfig,
  scheduleIntervalMs,
  scoreAccess,
  scoreAutonomy,
  scoreExperience,
  scoreReach,
  toPowerStat,
  xpForLevel,
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

/** A heavily equipped agent: public, autonomous, host access, every tool open. */
function heavyInputs(): AgentPowerInputs {
  return inputs({
    autonomous: true,
    autostart: true,
    tools: DEFAULT_TOOLS.map((t) => ({ ...t, enabled: true, restricted: false })),
    messaging: { receive: true, mode: 'proactive', visibility: 'public' },
    serving: {
      public: { enabled: true },
      shared: { enabled: true },
      api: Array.from({ length: 4 }, (_, i) => ({ method: 'GET' as const, path: `/r${i}`, lambda: 'api.ts:handler' }))
    },
    adapters: { telegram: { enabled: true }, slack: { enabled: true } } as AgentConfig['adapters'],
    ws_connections: [
      { id: 'a', url: 'wss://example.test/a', enabled: true },
      { id: 'b', url: 'wss://example.test/b', enabled: true }
    ],
    compute: { enabled: true, host_access: true, allowed_targets: ['host'] },
    code_execution: { network: true, packages: Array.from({ length: 5 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0' })) } as AgentConfig['code_execution'],
    mcp: { servers: ['github', 'files', 'search'].map((name) => ({ name, transport: 'stdio' as const, env_keys: ['TOKEN'] })) },
    loops: [{}, {}] as AgentConfig['loops']
  }, { credentials: { plain: 4, sealed: 0 }, privateKey: 'plain', timers: { active: 3, fastestIntervalMs: 60_000 } })
}

const HEAVY_XP: AgentExperienceInputs = {
  loopEntries: 30_000,
  filesWritten: 200,
  skills: 10,
  localTables: 8,
  localRows: 20_000,
  compactions: 150,
  agentsSpawned: 3,
  ageDays: 120
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

describe('level curve', () => {
  const curves = { experience: EXPERIENCE_CURVE, power: POWER_CURVE }

  for (const [name, curve] of Object.entries(curves)) {
    it(`${name}: Lv 1 at zero, monotonic, exact at every boundary`, () => {
      expect(levelForXp(0, curve)).toBe(1)
      expect(levelForXp(-5, curve)).toBe(1)
      expect(levelForXp(Number.NaN, curve)).toBe(1)
      let prev = 1
      for (let x = 0; x <= 12_000; x += curve.scale / 7) {
        const lv = levelForXp(x, curve)
        expect(lv).toBeGreaterThanOrEqual(prev)
        prev = lv
      }
      for (let lv = 2; lv <= 40; lv++) {
        const at = xpForLevel(lv, curve)
        expect(xpForLevel(lv + 1, curve)).toBeGreaterThan(at)
        expect(levelForXp(at, curve)).toBe(lv)
        expect(levelForXp(at - 1e-6, curve)).toBe(lv - 1)
        const pos = levelPosition(at, curve)
        expect(pos).toMatchObject({ level: lv, levelStart: at, nextLevelAt: xpForLevel(lv + 1, curve) })
        expect(pos.progress).toBeCloseTo(0)
      }
    })
  }

  it('experience bands get relatively narrower as levels rise', () => {
    let prevShare = Infinity
    for (let lv = 2; lv <= 40; lv++) {
      const share = (xpForLevel(lv + 1, EXPERIENCE_CURVE) - xpForLevel(lv, EXPERIENCE_CURVE)) / xpForLevel(lv, EXPERIENCE_CURVE)
      expect(share).toBeLessThan(prevShare)
      prevShare = share
    }
    // Lv 20 is about 11% wide, against 100% for a log2 curve.
    const lv20 = (xpForLevel(21, EXPERIENCE_CURVE) - xpForLevel(20, EXPERIENCE_CURVE)) / xpForLevel(20, EXPERIENCE_CURVE)
    expect(lv20).toBeLessThan(0.15)
  })

  it('experience calibration anchors', () => {
    const lv = (xp: number): number => levelForXp(xp, EXPERIENCE_CURVE)
    expect(lv(9)).toBe(2)
    expect(lv(4800)).toBe(22)
    expect(lv(7000)).toBe(26)
    expect(lv(10_000)).toBe(30)
    expect(lv(7000) - lv(4800)).toBeGreaterThanOrEqual(3)
  })

  it('progress is in [0,1) mid-level', () => {
    const mid = (xpForLevel(5, EXPERIENCE_CURVE) + xpForLevel(6, EXPERIENCE_CURVE)) / 2
    expect(levelPosition(mid, EXPERIENCE_CURVE)).toMatchObject({ level: 5, progress: 0.5 })
  })
})

describe('toPowerStat', () => {
  it('places uncapped points on the power curve, gated points included', () => {
    const s = toPowerStat([factor('a', 9), factor('b', 9, true)])
    expect(s).toMatchObject({ points: 18, open: 9, gated: 9, rawPoints: 18 })
    expect(s.level).toBe(levelForXp(18, POWER_CURVE))
    expect(s.openLevel).toBe(levelForXp(9, POWER_CURVE))
    expect(s.level).toBeGreaterThan(20)
  })

  it('applies mitigations to open points first, then gated', () => {
    expect(toPowerStat([factor('a', 2), factor('b', 2, true), factor('m', -1)])).toMatchObject({ points: 3, open: 1, gated: 2, rawPoints: 3 })
    expect(toPowerStat([factor('a', 1), factor('b', 2, true), factor('m', -2)])).toMatchObject({ points: 1, open: 0, gated: 1 })
    expect(toPowerStat([factor('a', 1), factor('m', -3)])).toMatchObject({ points: 0, level: 1, rawPoints: -2 })
  })

  it('is Lv 1 with nothing', () => {
    expect(toPowerStat([])).toMatchObject({ level: 1, progress: 0, points: 0, open: 0, gated: 0, high: false })
  })

  it('flags high only when the open points alone reach the threshold', () => {
    const needed = xpForLevel(POWER_HIGH_OPEN_LEVEL, POWER_CURVE)
    expect(toPowerStat([factor('a', needed)]).high).toBe(true)
    expect(toPowerStat([factor('a', needed - 0.25)]).high).toBe(false)
    // Same level, but gated: not high.
    expect(toPowerStat([factor('a', needed, true)])).toMatchObject({ high: false, level: POWER_HIGH_OPEN_LEVEL })
  })
})

describe('power calibration', () => {
  it('a default fresh agent is low single digits on all three', () => {
    const d = inputs()
    for (const s of [scoreAccess(d), scoreReach(d), scoreAutonomy(d)]) {
      expect(s.level).toBeGreaterThanOrEqual(2)
      expect(s.level).toBeLessThanOrEqual(4)
      expect(s.high).toBe(false)
    }
  })

  it('a heavily equipped agent lands in the same range as a heavily used agent\'s Experience', () => {
    const h = heavyInputs()
    const exp = scoreExperience(HEAVY_XP).level
    expect(exp).toBeGreaterThanOrEqual(18)
    expect(exp).toBeLessThanOrEqual(30)
    for (const s of [scoreAccess(h), scoreReach(h), scoreAutonomy(h)]) {
      expect(s.level).toBeGreaterThanOrEqual(18)
      expect(s.level).toBeLessThanOrEqual(30)
      expect(Math.abs(s.level - exp)).toBeLessThanOrEqual(6)
      expect(s.high).toBe(true)
    }
  })
})

describe('Access', () => {
  it('a default agent sits low', () => {
    const s = scoreAccess(inputs())
    expect(s.points).toBe(1.75)
    expect(s.level).toBe(3)
  })

  it('restricted tools count as gated, unrestricted as open', () => {
    const gated = scoreAccess(inputs(withTool('compute_exec', { enabled: true, restricted: true })))
    const open = scoreAccess(inputs(withTool('compute_exec', { enabled: true, restricted: false })))
    expect(gated.factors.find((f) => f.id === 'tool:compute_exec')).toMatchObject({ gated: true, configPath: 'tools.compute_exec' })
    expect(open.factors.find((f) => f.id === 'tool:compute_exec')?.gated).toBe(false)
    expect(open.open).toBeGreaterThan(gated.open)
    expect(open.level).toBe(gated.level)
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

  it('is uncapped: more MCP servers keep raising it', () => {
    const servers = (n: number) => ({ mcp: { servers: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, transport: 'stdio' as const })) } })
    expect(scoreAccess(inputs(servers(30))).level).toBeGreaterThan(scoreAccess(inputs(servers(20))).level)
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
    expect(s).toMatchObject({ points: 0, level: 1 })
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

  it('public page, routes, shared files, adapters and ws connections add up; per-kind counts cap', () => {
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
    expect(s.level).toBeGreaterThanOrEqual(18)
    expect(s.factors.find((f) => f.id === 'serving:api')?.points).toBe(3)
    expect(s.factors.find((f) => f.id === 'adapter:telegram')).toBeDefined()
    expect(s.factors.find((f) => f.id === 'adapter:email')).toBeUndefined()
  })
})

describe('Autonomy', () => {
  it('a default agent is low', () => {
    expect(scoreAutonomy(inputs()).level).toBeLessThanOrEqual(4)
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

  it('a first session reaches level 2-4', () => {
    const typical = scoreExperience({ ...EMPTY_XP, loopEntries: 60, filesWritten: 3 })
    const long = scoreExperience({ ...EMPTY_XP, loopEntries: 200, filesWritten: 10, skills: 1 })
    expect(typical.level).toBeGreaterThanOrEqual(2)
    expect(long.level).toBeLessThanOrEqual(4)
  })

  it('a heavily used months-old agent reaches level 20-30', () => {
    const heavy = scoreExperience(HEAVY_XP)
    expect(heavy.score).toBeGreaterThan(4000)
    expect(heavy.level).toBeGreaterThanOrEqual(20)
    expect(heavy.level).toBeLessThanOrEqual(30)
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

  it('uses the experience curve: score is the plain XP sum', () => {
    for (const n of [5, 24, 59, 700, 4229]) {
      // Files only: score = n exactly.
      const e = scoreExperience({ ...EMPTY_XP, filesWritten: n })
      expect(e.score).toBe(n)
      expect(e.level).toBe(levelForXp(n, EXPERIENCE_CURVE))
      expect(e.levelStart).toBeLessThanOrEqual(n)
      expect(e.nextLevelAt).toBeGreaterThan(n)
    }
  })

  it('next-level hint matches the remaining XP', () => {
    const e = scoreExperience({ ...EMPTY_XP, loopEntries: 60 })
    expect(e.nextLevel.xp).toBeCloseTo(e.nextLevelAt - e.score)
    expect(e.nextLevel.loopEntries).toBe(Math.ceil(e.nextLevel.xp / 0.1))
    expect(e.level).toBe(2)
    expect(e.nextLevel.hint).toBe(`Lv 3 needs ${Math.ceil(e.nextLevel.xp)} more XP: about ${e.nextLevel.loopEntries} loop messages, ${e.nextLevel.files} files or ${e.nextLevel.skills} skills`)
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
