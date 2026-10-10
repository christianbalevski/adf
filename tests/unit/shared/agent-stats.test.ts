import { describe, expect, it } from 'vitest'
import {
  EXPERIENCE_CURVE,
  EXPERIENCE_WEIGHTS,
  ACCESS_POINTS,
  POWER_HIGH_OPEN_SHARE,
  POWER_MAX,
  levelForXp,
  levelPosition,
  powerFill,
  powerInputsFromConfig,
  powerLevel,
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

/** A heavily equipped agent: public, autonomous, host access, 3 adapters, 6 MCP servers, every tool open. */
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
    adapters: { telegram: { enabled: true }, slack: { enabled: true }, discord: { enabled: true } } as AgentConfig['adapters'],
    ws_connections: [
      { id: 'a', url: 'wss://example.test/a', enabled: true },
      { id: 'b', url: 'wss://example.test/b', enabled: true }
    ],
    compute: { enabled: true, host_access: true, allowed_targets: ['host'] },
    code_execution: { network: true, packages: Array.from({ length: 5 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0' })) } as AgentConfig['code_execution'],
    mcp: { servers: ['github', 'files', 'search', 'mail', 'calendar', 'db'].map((name) => ({ name, transport: 'stdio' as const, env_keys: ['TOKEN'] })) },
    loops: [{}, {}] as AgentConfig['loops']
  }, { credentials: { plain: 4, sealed: 0 }, privateKey: 'plain', timers: { active: 3, fastestIntervalMs: 60_000 } })
}

/** Every factor at its cap, no mitigations. */
function maxedInputs(): AgentPowerInputs {
  return inputs({
    autonomous: true,
    autostart: true,
    tools: DEFAULT_TOOLS.map((t) => ({ ...t, enabled: true, restricted: false })),
    messaging: { receive: true, mode: 'proactive', visibility: 'public' },
    serving: {
      public: { enabled: true },
      shared: { enabled: true },
      api: Array.from({ length: 10 }, (_, i) => ({ method: 'GET' as const, path: `/r${i}`, lambda: 'api.ts:handler' }))
    },
    adapters: { telegram: { enabled: true }, slack: { enabled: true }, discord: { enabled: true }, email: { enabled: true } } as AgentConfig['adapters'],
    ws_connections: Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, url: `wss://example.test/${i}`, enabled: true })),
    compute: { enabled: true, host_access: true, allowed_targets: ['host'] },
    code_execution: { network: true, packages: Array.from({ length: 8 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0' })) } as AgentConfig['code_execution'],
    mcp: { servers: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, transport: 'stdio' as const, env_keys: ['TOKEN'] })) },
    triggers: {
      on_inbox: { enabled: true, targets: Array.from({ length: 8 }, () => ({ scope: 'agent' as const })) }
    } as AgentConfig['triggers'],
    loops: [{}, {}, {}, {}] as AgentConfig['loops']
  }, { credentials: { plain: 10, sealed: 0 }, privateKey: 'plain', timers: { active: 3, fastestIntervalMs: 60_000 } })
}

const HEAVY_XP: AgentExperienceInputs = {
  contextsWorked: 150,
  filesWritten: 40,
  memoryTokens: 20_000,
  skills: 10,
  localTables: 5,
  localRows: 8_000,
  agentsSpawned: 3,
  messages: 30_000,
  ageDays: 120
}

const factor = (id: string, points: number, gated = false): StatFactor => ({ id, label: id, points, gated, configPath: id })

const EMPTY_XP: AgentExperienceInputs = {
  contextsWorked: 0,
  filesWritten: 0,
  memoryTokens: 0,
  localTables: 0,
  localRows: 0,
  skills: 0,
  agentsSpawned: 0,
  messages: 0,
  ageDays: 0
}

describe('level curve', () => {
  for (const [name, curve] of Object.entries({ experience: EXPERIENCE_CURVE })) {
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
    const pos = levelPosition(mid, EXPERIENCE_CURVE)
    expect(pos.level).toBe(5)
    // The midpoint of two float level starts is only 0.5 to within rounding.
    expect(pos.progress).toBeCloseTo(0.5, 12)
  })
})

describe('power scale', () => {
  it('maps points / max onto 1..20', () => {
    expect(powerLevel(0, 10)).toBe(1)
    expect(powerLevel(10, 10)).toBe(20)
    expect(powerLevel(25, 10)).toBe(20)
    expect(powerLevel(-3, 10)).toBe(1)
    expect(powerLevel(5, 10)).toBe(11) // 1 + round(9.5)
    expect(powerLevel(Number.NaN, 10)).toBe(1)
    expect(powerFill(3, 0)).toBe(0)
  })

  it('POWER_MAX is the sum of every capped positive factor', () => {
    expect(POWER_MAX).toEqual({ access: 19.25, reach: 21.5, autonomy: 15.5 })
  })
})

describe('toPowerStat', () => {
  it('scales points against max, gated points included', () => {
    const s = toPowerStat([factor('a', 4), factor('b', 4, true)], 10)
    expect(s).toMatchObject({ points: 8, max: 10, fill: 0.8, open: 4, gated: 4, rawPoints: 8 })
    expect(s.level).toBe(powerLevel(8, 10))
  })

  it('applies mitigations to open points first, then gated', () => {
    expect(toPowerStat([factor('a', 2), factor('b', 2, true), factor('m', -1)], 10)).toMatchObject({ points: 3, open: 1, gated: 2, rawPoints: 3 })
    expect(toPowerStat([factor('a', 1), factor('b', 2, true), factor('m', -2)], 10)).toMatchObject({ points: 1, open: 0, gated: 1 })
    expect(toPowerStat([factor('a', 1), factor('m', -3)], 10)).toMatchObject({ points: 0, fill: 0, level: 1, rawPoints: -2 })
  })

  it('is Lv 1 with nothing', () => {
    expect(toPowerStat([], 10)).toMatchObject({ level: 1, fill: 0, points: 0, open: 0, gated: 0, high: false })
  })

  it('flags high only when the open share of max reaches the threshold', () => {
    const needed = POWER_HIGH_OPEN_SHARE * 10
    expect(toPowerStat([factor('a', needed)], 10)).toMatchObject({ high: true, level: 12 })
    expect(toPowerStat([factor('a', needed - 0.25)], 10).high).toBe(false)
    // Same level, but gated: not high.
    expect(toPowerStat([factor('a', needed, true)], 10)).toMatchObject({ high: false, level: 12 })
  })
})

describe('power calibration', () => {
  const all = (p: AgentPowerInputs) => ({ access: scoreAccess(p), reach: scoreReach(p), autonomy: scoreAutonomy(p) })

  it('an empty config is Lv 1 on all three', () => {
    const empty = inputs({ tools: [], messaging: { receive: false, mode: 'listen_only', visibility: 'off' }, triggers: {} })
    for (const s of Object.values(all(empty))) expect(s).toMatchObject({ level: 1, points: 0, fill: 0 })
  })

  it('a default fresh agent is Lv 3 on all three', () => {
    const s = all(inputs())
    expect([s.access.points, s.reach.points, s.autonomy.points]).toEqual([1.75, 2, 2])
    for (const stat of Object.values(s)) expect(stat).toMatchObject({ level: 3, high: false })
  })

  it('a heavily equipped agent is at or near Lv 20', () => {
    const s = all(heavyInputs())
    expect([s.access.points, s.reach.points, s.autonomy.points]).toEqual([18.75, 19.5, 14.25])
    expect([s.access.level, s.reach.level, s.autonomy.level]).toEqual([20, 18, 18])
    for (const stat of Object.values(s)) expect(stat.high).toBe(true)
  })

  it('every factor at its cap is exactly Lv 20 with a full bar', () => {
    const s = all(maxedInputs())
    expect(s.access).toMatchObject({ level: 20, points: POWER_MAX.access, fill: 1 })
    expect(s.reach).toMatchObject({ level: 20, points: POWER_MAX.reach, fill: 1 })
    expect(s.autonomy).toMatchObject({ level: 20, points: POWER_MAX.autonomy, fill: 1 })
  })

  it('a heavily equipped agent lands near a heavily used agent\'s Experience', () => {
    const exp = scoreExperience(HEAVY_XP).level
    expect(exp).toBeGreaterThanOrEqual(18)
    expect(exp).toBeLessThanOrEqual(30)
    for (const s of Object.values(all(heavyInputs()))) expect(Math.abs(s.level - exp)).toBeLessThanOrEqual(6)
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

  it('MCP servers cap at six; the rest are listed at 0 points', () => {
    const servers = (n: number) => ({ mcp: { servers: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, transport: 'stdio' as const, env_keys: ['T'] })) } })
    const ten = scoreAccess(inputs(servers(10)))
    const six = scoreAccess(inputs(servers(6)))
    expect(ten.points).toBe(six.points)
    expect(ten.level).toBe(six.level)
    expect(ten.factors.filter((f) => /^mcp:[^:]+$/.test(f.id))).toHaveLength(10)
    expect(ten.factors.filter((f) => f.id.startsWith('mcp:') && f.points > 0)).toHaveLength(12)
    expect(six.points - scoreAccess(inputs()).points).toBe(ACCESS_POINTS.mcpServerCap * (ACCESS_POINTS.mcpServer + ACCESS_POINTS.mcpCredentials))
  })

  it('MCP cap counts the heaviest servers, open before gated', () => {
    const s = scoreAccess(inputs({
      mcp: {
        servers: [
          ...Array.from({ length: 6 }, (_, i) => ({ name: `bare${i}`, transport: 'stdio' as const })),
          { name: 'gated', transport: 'stdio' as const, restricted: true, env_keys: ['T'] },
          { name: 'open', transport: 'stdio' as const, env_keys: ['T'] }
        ]
      }
    }))
    const pts = (id: string) => s.factors.find((f) => f.id === id)?.points
    expect(pts('mcp:open')).toBe(ACCESS_POINTS.mcpServer)
    expect(pts('mcp:gated')).toBe(ACCESS_POINTS.mcpServer)
    expect(pts('mcp:bare0')).toBe(ACCESS_POINTS.mcpServer)
    expect(pts('mcp:bare4')).toBe(0)
    expect(pts('mcp:bare5')).toBe(0)
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
    expect(s).toMatchObject({ points: 15, level: 14 })
    expect(s.factors.find((f) => f.id === 'serving:api')?.points).toBe(3)
    expect(s.factors.find((f) => f.id === 'adapter:telegram')).toBeDefined()
    expect(s.factors.find((f) => f.id === 'adapter:email')).toBeUndefined()
  })
})

describe('Reach adapters', () => {
  it('chat adapters cap at three; the rest are listed at 0 points', () => {
    const adapters = (types: string[]) => ({ adapters: Object.fromEntries(types.map((t) => [t, { enabled: true }])) as AgentConfig['adapters'] })
    const five = scoreReach(inputs(adapters(['telegram', 'slack', 'discord', 'email', 'matrix'])))
    const three = scoreReach(inputs(adapters(['telegram', 'slack', 'discord'])))
    expect(five.points).toBe(three.points)
    expect(five.factors.filter((f) => f.id.startsWith('adapter:'))).toHaveLength(5)
    expect(five.factors.filter((f) => f.id.startsWith('adapter:') && f.points === 0)).toHaveLength(2)
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

  it('a first session reaches level 2-3', () => {
    const typical = scoreExperience({ ...EMPTY_XP, contextsWorked: 0.3, filesWritten: 3, memoryTokens: 300, messages: 60, ageDays: 0.1 })
    expect(typical.level).toBeGreaterThanOrEqual(2)
    expect(typical.level).toBeLessThanOrEqual(3)
    expect(scoreExperience({ ...EMPTY_XP, contextsWorked: 0.2, filesWritten: 3, messages: 40 }).level).toBe(2)
    // A long first session that also writes a skill stays single digit.
    expect(scoreExperience({ ...EMPTY_XP, contextsWorked: 0.8, filesWritten: 10, memoryTokens: 800, skills: 1 }).level).toBeLessThanOrEqual(5)
  })

  it('a heavily used months-old agent reaches level 20-25, with work at most half the XP', () => {
    const heavy = scoreExperience(HEAVY_XP)
    expect(heavy.level).toBeGreaterThanOrEqual(20)
    expect(heavy.level).toBeLessThanOrEqual(25)
    const work = heavy.breakdown.find((b) => b.id === 'contextsWorked')?.xp ?? 0
    expect(work / heavy.score).toBeLessThanOrEqual(0.5)
    expect(work / heavy.score).toBeGreaterThan(0.25)
    const messages = heavy.breakdown.find((b) => b.id === 'messages')?.xp ?? 0
    expect(messages).toBeGreaterThan(0)
    expect(messages / heavy.score).toBeLessThan(0.1)
  })

  it('raw message volume barely counts: one context outweighs 500 messages', () => {
    expect(scoreExperience({ ...EMPTY_XP, contextsWorked: 1 }).score).toBeGreaterThan(scoreExperience({ ...EMPTY_XP, messages: 500 }).score)
  })

  it('age alone does not level an idle agent; an active one earns about 0.5 XP a day', () => {
    expect(scoreExperience({ ...EMPTY_XP, ageDays: 365 }).level).toBe(1)
    const active = scoreExperience({ ...EMPTY_XP, contextsWorked: 10, ageDays: 100 })
    expect(active.breakdown.find((b) => b.id === 'ageDays')?.xp).toBeCloseTo(50)
    const half = scoreExperience({ ...EMPTY_XP, contextsWorked: 5, ageDays: 100 })
    expect(half.breakdown.find((b) => b.id === 'ageDays')?.xp).toBeCloseTo(25)
  })

  it('work counts in contexts: about 10 XP each, fractions included', () => {
    expect(scoreExperience({ ...EMPTY_XP, contextsWorked: 1 }).score).toBe(EXPERIENCE_WEIGHTS.contextsWorked)
    expect(EXPERIENCE_WEIGHTS.contextsWorked).toBeGreaterThanOrEqual(8)
    expect(EXPERIENCE_WEIGHTS.contextsWorked).toBeLessThanOrEqual(12)
    expect(scoreExperience({ ...EMPTY_XP, contextsWorked: 0.5 }).score).toBeCloseTo(EXPERIENCE_WEIGHTS.contextsWorked / 2)
  })

  it('is monotonic in every input', () => {
    const base: AgentExperienceInputs = { contextsWorked: 5, filesWritten: 10, memoryTokens: 2_000, skills: 2, localTables: 1, localRows: 100, agentsSpawned: 1, messages: 500, ageDays: 30 }
    const baseScore = scoreExperience(base).score
    for (const key of Object.keys(base) as Array<keyof AgentExperienceInputs>) {
      const more = scoreExperience({ ...base, [key]: (base[key] as number) * 2 + 1 })
      expect(more.score, key).toBeGreaterThan(baseScore)
      expect(more.level, key).toBeGreaterThanOrEqual(scoreExperience(base).level)
    }
  })

  it('goes down when the agent deletes its work', () => {
    const before = scoreExperience({ ...EMPTY_XP, contextsWorked: 2, filesWritten: 40, skills: 3 })
    const after = scoreExperience({ ...EMPTY_XP, contextsWorked: 2, filesWritten: 5, skills: 0 })
    expect(after.score).toBeLessThan(before.score)
  })

  it('memory counts in tokens, square-rooted', () => {
    const note = scoreExperience({ ...EMPTY_XP, memoryTokens: 500 })
    expect(note.score).toBeCloseTo(Math.sqrt(500) * EXPERIENCE_WEIGHTS.memoryTokensSqrt)
    expect(note.breakdown.find((b) => b.id === 'memoryTokens')?.value).toBe(500)
  })

  it('memory is sublinear: 10x tokens is about 3.2x XP and a bulk dump stays below Lv 20', () => {
    const mem = (tokens: number): number => scoreExperience({ ...EMPTY_XP, memoryTokens: tokens }).score
    expect(mem(200_000) / mem(20_000)).toBeCloseTo(Math.sqrt(10), 5)
    expect(mem(20_000) / mem(2_000)).toBeCloseTo(3.16, 2)
    expect(scoreExperience({ ...EMPTY_XP, memoryTokens: 1_000_000 }).level).toBeLessThanOrEqual(20)
  })

  it('skills weigh more than plain files', () => {
    expect(scoreExperience({ ...EMPTY_XP, skills: 1 }).score).toBeGreaterThan(scoreExperience({ ...EMPTY_XP, filesWritten: 1 }).score)
  })

  it('uses the experience curve: score is the plain XP sum', () => {
    for (const n of [5, 24, 59, 700, 4229]) {
      // Contexts only: score = n exactly.
      const e = scoreExperience({ ...EMPTY_XP, contextsWorked: n / EXPERIENCE_WEIGHTS.contextsWorked })
      expect(e.score).toBe(n)
      expect(e.level).toBe(levelForXp(n, EXPERIENCE_CURVE))
      expect(e.levelStart).toBeLessThanOrEqual(n)
      expect(e.nextLevelAt).toBeGreaterThan(n)
    }
  })

  it('next-level hint matches the remaining XP', () => {
    const e = scoreExperience({ ...EMPTY_XP, contextsWorked: 0.6 })
    expect(e.nextLevel.xp).toBeCloseTo(e.nextLevelAt - e.score)
    expect(e.nextLevel.contexts).toBe(Math.ceil(e.nextLevel.xp / EXPERIENCE_WEIGHTS.contextsWorked))
    expect(e.nextLevel.memoryTokens).toBe(Math.ceil((e.nextLevel.xp / EXPERIENCE_WEIGHTS.memoryTokensSqrt) ** 2))
    expect(e.level).toBe(2)
    expect(e.nextLevel.hint).toBe(`Lv 3 needs ${Math.ceil(e.nextLevel.xp)} more XP: about ${e.nextLevel.contexts} contexts of work, ${e.nextLevel.memoryTokens} memory tokens or 1 skill`)
  })

  it('next-level memory hint inverts the sqrt from the current memory', () => {
    const e = scoreExperience({ ...EMPTY_XP, memoryTokens: 10_000 })
    const k = EXPERIENCE_WEIGHTS.memoryTokensSqrt
    const need = e.nextLevel.memoryTokens
    expect(need).toBe(Math.ceil(((Math.sqrt(10_000) * k + e.nextLevel.xp) / k) ** 2 - 10_000))
    // Adding that many tokens reaches the next level; it costs more than starting from 0 would.
    expect(scoreExperience({ ...EMPTY_XP, memoryTokens: 10_000 + need }).level).toBe(e.level + 1)
    expect(need).toBeGreaterThan(Math.ceil((e.nextLevel.xp / k) ** 2))
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
