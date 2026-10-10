import { describe, it, expect } from 'vitest'
import {
  HIGH_POWER_LABEL,
  SECTION_LIMIT,
  agentStatusLabel,
  shelfSpines,
  SHELF_MAX_PX,
  SHELF_MIN_PX,
  compactCount,
  configTargetFor,
  decideLevelUp,
  contextsLine,
  experienceContributors,
  experienceHeadline,
  experienceTooltip,
  experienceValueText,
  factorGroup,
  foldFactors,
  formatWake,
  levelBarParts,
  overviewFacts,
  parseStoredLevels,
  powerSections,
  powerTooltip,
  visibleItems
} from '../../../src/renderer/components/agent/overview/agent-overview-model'
import { POWER_HIGH_OPEN_SHARE, POWER_MAX, scoreAccess, scoreExperience, toPowerStat as toPowerStatMax } from '../../../src/shared/utils/agent-stats'
import type { AgentExperienceInputs, StatFactor } from '../../../src/shared/types/agent-vitals.types'

/** Scored against Access's max, as the card does. */
const toPowerStat = (factors: StatFactor[]) => toPowerStatMax(factors, POWER_MAX.access)

const factor = (id: string, label: string, points: number, gated = false, configPath = 'tools.x'): StatFactor => ({
  id, label, points, gated, configPath
})

const experienceInputs = (over: Partial<AgentExperienceInputs> = {}): AgentExperienceInputs => ({
  contextsWorked: 0,
  filesWritten: 0,
  memoryTokens: 0,
  localTables: 0,
  localRows: 0,
  skills: 0,
  agentsSpawned: null,
  messages: 0,
  ageDays: 0,
  ...over
})

describe('levelBarParts', () => {
  it('splits the fill by the open share', () => {
    expect(levelBarParts({ fill: 0.5, open: 3, gated: 1, high: false })).toEqual({ openPct: 37.5, gatedPct: 12.5, high: false })
  })

  it('is all hatched when everything asks first, all solid when nothing does', () => {
    expect(levelBarParts({ fill: 0.4, open: 0, gated: 2 })).toEqual({ openPct: 0, gatedPct: 40, high: false })
    expect(levelBarParts({ fill: 0.4, open: 2, gated: 0 })).toEqual({ openPct: 40, gatedPct: 0, high: false })
  })

  it('treats experience (no open/gated) as solid', () => {
    expect(levelBarParts({ fill: 0.25 })).toEqual({ openPct: 25, gatedPct: 0, high: false })
  })

  it('clamps a bad fill and carries the high flag', () => {
    expect(levelBarParts({ fill: Number.NaN, open: 1, gated: 0 })).toMatchObject({ openPct: 0, gatedPct: 0 })
    expect(levelBarParts({ fill: 3, open: 1, gated: 1, high: true })).toEqual({ openPct: 50, gatedPct: 50, high: true })
  })

  it('a power stat fills by its share of max, not progress to the next level', () => {
    const stat = toPowerStat([factor('a', 'A', POWER_MAX.access / 2), factor('b', 'B', POWER_MAX.access / 4, true)])
    expect(stat.fill).toBeCloseTo(0.75)
    expect(levelBarParts(stat)).toEqual({ openPct: 50, gatedPct: 25, high: false })
  })

  it('matches the scorer', () => {
    const stat = toPowerStat([factor('a', 'A', 1.5), factor('b', 'B', 2, true), factor('c', 'C', 0.2)])
    const parts = levelBarParts(stat)
    expect(parts.openPct + parts.gatedPct).toBeCloseTo(stat.fill * 100, 0)
  })
})

describe('powerTooltip', () => {
  it('names the level, how much asks first and the two largest factors', () => {
    const stat = toPowerStat([
      factor('serving:public', 'Serves a public web page', 3),
      factor('serving:api', '3 HTTP API routes', 1.5),
      factor('messaging:send', 'Sends messages on its own', 1, true),
      factor('security:signed_only', 'Only accepts signed messages', -0.5)
    ])
    expect(powerTooltip(stat)).toBe(`Lv ${stat.level} of 20, some asks you first · serves a public web page, 3 HTTP API routes`)
  })

  it('leaves out the gated part when nothing is gated', () => {
    const stat = toPowerStat([factor('a', 'Reads its own files', 0.25)])
    expect(powerTooltip(stat)).toBe('Lv 1 of 20 · reads its own files')
  })

  it('drops trailing parentheticals and says when most asks first', () => {
    const stat = toPowerStat([
      factor('triggers', 'Wakes on 2 event types (on_inbox, on_timer)', 1),
      factor('tool:sys_update_config', 'Changes its own config (needs approval)', 1.5, true)
    ])
    expect(powerTooltip(stat)).toBe(`Lv ${stat.level} of 20, mostly asks you first · changes its own config, wakes on 2 event types`)
  })

  it('labels the warn state in words', () => {
    const stat = toPowerStat([factor('a', 'Runs commands on the host machine', POWER_HIGH_OPEN_SHARE * POWER_MAX.access)])
    expect(stat.high).toBe(true)
    expect(powerTooltip(stat)).toContain(HIGH_POWER_LABEL)
  })

  it('is just the level with no factors', () => {
    expect(powerTooltip(toPowerStat([]))).toBe('Lv 1 of 20')
  })
})

describe('power sections', () => {
  const f = (id: string, label: string, points: number, gated = false, configPath = 'tools.x'): StatFactor => factor(id, label, points, gated, configPath)

  it('groups factors by kind', () => {
    expect(factorGroup('tool:fs_read')).toBe('files')
    expect(factorGroup('tool:sys_fetch')).toBe('network')
    expect(factorGroup('tool:compute_exec')).toBeNull()
    expect(factorGroup('mcp:github')).toBe('mcp')
    expect(factorGroup('mcp:github:credentials')).toBe('mcp-credentials')
    expect(factorGroup('adapter:telegram')).toBe('adapters')
    expect(factorGroup('serving:public')).toBeNull()
  })

  it('folds same-kind factors into one counted line, keeping the first config path', () => {
    const items = foldFactors([
      f('tool:fs_read', 'Reads its own files', 0.25, false, 'tools.fs_read'),
      f('tool:fs_write', 'Writes its own files', 0.25, false, 'tools.fs_write'),
      f('tool:db_execute', 'Writes to its database tables', 0.25, false, 'tools.db_execute'),
      f('mcp:a', 'MCP server a', 0.5, false, 'mcp.servers'),
      f('mcp:b', 'MCP server b', 0.5, false, 'mcp.servers'),
      f('mcp:c', 'MCP server c', 0.5, false, 'mcp.servers'),
      f('tool:compute_exec', 'Runs commands on compute targets', 1, false, 'tools.compute_exec')
    ])
    expect(items.map((i) => [i.text, i.count, i.configPath])).toEqual([
      ['3 file and data tools', 3, 'tools.fs_read'],
      ['3 MCP servers', 3, 'mcp.servers'],
      ['Runs commands on compute targets', 1, 'tools.compute_exec']
    ])
    expect(items[1].points).toBe(1.5)
  })

  it('a group of one keeps its own label, minus the parenthetical', () => {
    expect(foldFactors([f('mcp:github', 'MCP server github (tools need approval)', 0.5, true)])[0].text).toBe('MCP server github')
  })

  it('splits open, gated and limits, heaviest first, with no points in the text', () => {
    const stat = toPowerStat([
      f('tool:fs_read', 'Reads its own files', 0.25),
      f('compute:host_access', 'May run MCP servers on the host machine', 2, false, 'compute.host_access'),
      f('tool:compute_exec', 'Runs commands on compute targets (needs approval)', 1, true),
      f('mcp:github', 'MCP server github (tools need approval)', 0.5, true, 'mcp.servers'),
      f('mcp:files', 'MCP server files (tools need approval)', 0.5, true, 'mcp.servers'),
      f('tools:restricted', '3 tools need approval', -0.75, false, 'tools[].restricted')
    ])
    const s = powerSections(stat)
    expect(s.open.map((i) => i.text)).toEqual(['May run MCP servers on the host machine', 'Reads its own files'])
    expect(s.gated.map((i) => i.text)).toEqual(['Runs commands on compute targets', '2 MCP servers'])
    expect(s.limits.map((i) => i.text)).toEqual(['3 tools need approval'])
    for (const i of [...s.open, ...s.gated, ...s.limits]) expect(i.text).not.toMatch(/[+-]\d/)
  })

  it('lists the real count past a cap ("10 MCP servers") while only six count', () => {
    const servers = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, restricted: false, hasCredentials: false }))
    const base = scoreAccess({
      tools: [], autonomous: false, autostart: false,
      messaging: { receive: false, mode: 'listen_only', visibility: 'off', allowListCount: 0 },
      security: { allowUnsigned: true, requireSignature: false },
      serving: { publicEnabled: false, apiRouteCount: 0, sharedEnabled: false },
      adapters: [], wsConnectionCount: 0, mcpServers: servers, npmPackageCount: 0, codeNetwork: false,
      compute: { enabled: false, hostAccess: false, allowedTargets: [] }, triggers: [], sideLoopCount: 0,
      credentials: { plain: 0, sealed: 0 }, privateKey: 'none', timers: { active: 0 }
    })
    expect(base.points).toBe(3)
    expect(powerSections(base).open).toEqual([expect.objectContaining({ text: '10 MCP servers', count: 10, points: 3 })])
  })

  it('shows at most SECTION_LIMIT items until expanded', () => {
    const items = Array.from({ length: SECTION_LIMIT + 3 }, (_, i) => i)
    expect(visibleItems(items, false)).toEqual({ shown: items.slice(0, SECTION_LIMIT), hidden: 3 })
    expect(visibleItems(items, true)).toEqual({ shown: items, hidden: 0 })
    expect(visibleItems([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 })
  })
})

describe('experience popover', () => {
  it('heads with the XP to the next level', () => {
    const exp = scoreExperience(experienceInputs({ filesWritten: 10 }))
    expect(exp.level).toBe(2)
    expect(experienceHeadline(exp)).toBe(`${Math.ceil(exp.nextLevelAt - 20)} XP to Lv 3`)
  })

  it('lists the top contributors as plain lines, largest first', () => {
    const exp = scoreExperience(experienceInputs({
      contextsWorked: 150, memoryTokens: 20_000, filesWritten: 40, skills: 10, localRows: 4, agentsSpawned: 3, messages: 30_000, ageDays: 120
    }))
    expect(experienceContributors(exp)).toEqual([
      '~150 contexts of work',
      '10 skills',
      'Memory ~20k tokens',
      '30k messages',
      '3 agents created',
      '120 days'
    ])
    // Skills, messages and days keep their own lines outside the top two.
    expect(experienceContributors(exp, 2)).toEqual(['~150 contexts of work', '10 skills', 'Memory ~20k tokens', '30k messages', '120 days'])
  })

  it('formats contexts of work compactly', () => {
    expect(contextsLine(0.02)).toBe('<0.1 contexts of work')
    expect(contextsLine(0.4)).toBe('~0.4 contexts of work')
    expect(contextsLine(1)).toBe('~1 context of work')
    expect(contextsLine(150.3)).toBe('~150 contexts of work')
    expect(contextsLine(1_234)).toBe('~1.2k contexts of work')
    expect(experienceValueText({ id: 'contextsWorked', value: 0.34 })).toBe('0.3')
    expect(experienceValueText({ id: 'messages', value: 30_000 })).toBe('30k')
  })

  it('lists memory as approximate tokens', () => {
    expect(experienceContributors(scoreExperience(experienceInputs({ memoryTokens: 850 })))).toEqual(['Memory ~850 tokens'])
    expect(experienceContributors(scoreExperience(experienceInputs({ memoryTokens: 12_345 })))).toEqual(['Memory ~12k tokens'])
    expect(experienceContributors(scoreExperience(experienceInputs({ memoryTokens: 1_200_000 })))).toEqual(['Memory ~1.2M tokens'])
    expect(experienceTooltip(scoreExperience(experienceInputs({ skills: 2, memoryTokens: 12_000 })))).toMatch(/^2 skills · memory ~12k tokens · /)
  })

  it('skips zero and negligible signals and uses the singular for one', () => {
    const exp = scoreExperience(experienceInputs({ skills: 1, ageDays: 400 }))
    expect(experienceContributors(exp)).toEqual(['1 skill'])
  })
})

describe('experienceTooltip', () => {
  it('lists contexts of work, files and skills, then the XP to the next level', () => {
    const exp = scoreExperience(experienceInputs({ contextsWorked: 3.4, filesWritten: 18, skills: 3 }))
    expect(experienceTooltip(exp)).toBe(
      `~3.4 contexts of work · 18 files · 3 skills · ${compactCount(Math.ceil(exp.nextLevel.xp))} XP to Lv ${exp.level + 1}`
    )
  })

  it('omits zero counts', () => {
    const exp = scoreExperience(experienceInputs())
    expect(experienceTooltip(exp)).toBe('5 XP to Lv 2')
  })

  it('uses the singular for one', () => {
    const exp = scoreExperience(experienceInputs({ skills: 1 }))
    expect(experienceTooltip(exp)).toMatch(/^1 skill · /)
  })
})

describe('number formatting', () => {
  it('compacts counts', () => {
    expect(compactCount(950)).toBe('950')
    expect(compactCount(1000)).toBe('1k')
    expect(compactCount(1234)).toBe('1.2k')
    expect(compactCount(12_345)).toBe('12k')
    expect(compactCount(1_500_000)).toBe('1.5M')
  })
})

describe('overviewFacts', () => {
  const now = Date.UTC(2026, 9, 8, 12)

  it('shows cost, age and next wake in order', () => {
    const facts = overviewFacts({ cost7dUsd: 0.84, createdAt: '2026-08-27T00:00:00Z', ageDays: 42.3, nextWakeAt: now + 2 * 3_600_000 }, now)
    expect(facts.map((f) => f.text)).toEqual(['$0.84 / 7d', '42 days old', 'wakes in 2 h'])
  })

  it('omits unknown and zero facts', () => {
    expect(overviewFacts({ ageDays: 3 }, now)).toEqual([])
    expect(overviewFacts({ cost7dUsd: 0, createdAt: '2026-10-08T00:00:00Z', ageDays: 0.2 }, now).map((f) => f.text)).toEqual(['created today'])
  })

  it('formats wake times', () => {
    expect(formatWake(now - 1, now)).toBe('wake due')
    expect(formatWake(now + 20_000, now)).toBe('wakes in under a minute')
    expect(formatWake(now + 5 * 60_000, now)).toBe('wakes in 5 min')
    expect(formatWake(now + 3 * 86_400_000, now)).toBe('wakes in 3 days')
  })
})

describe('header helpers', () => {
  it('labels agent state', () => {
    expect(agentStatusLabel('active', { toolName: 'fs_write' })).toBe('Running fs_write')
    expect(agentStatusLabel('active')).toBe('Thinking')
    expect(agentStatusLabel('active', { approvals: 2, toolName: 'fs_write' })).toBe('Waiting for you · 2 approvals')
    expect(agentStatusLabel('active', { approvals: 1, asks: 1 })).toBe('Waiting for you · 1 approval, 1 question')
    expect(agentStatusLabel('active', { suspend: true })).toBe('Waiting for you')
    expect(agentStatusLabel('off', { approvals: 1 })).toBe('Stopped')
    expect(agentStatusLabel('idle', { nextWakeAt: 56 * 60_000, now: 0 })).toBe('Wakes in 56 min')
    expect(agentStatusLabel('idle')).toBe('')
    expect(agentStatusLabel('idle', { starting: true })).toBe('Starting')
    expect(agentStatusLabel('off')).toBe('Stopped')
    expect(agentStatusLabel(undefined)).toBe('Stopped')
  })
})

describe('decideLevelUp', () => {
  it('never pulses on first sight', () => {
    expect(decideLevelUp(undefined, 7)).toEqual({ pulse: false, store: 7 })
  })

  it('pulses when the level rises past the stored one', () => {
    expect(decideLevelUp(6, 7)).toEqual({ pulse: true, store: 7 })
  })

  it('stays quiet at the same or a lower level and keeps the higher mark', () => {
    expect(decideLevelUp(7, 7)).toEqual({ pulse: false, store: 7 })
    expect(decideLevelUp(7, 5)).toEqual({ pulse: false, store: 7 })
  })

  it('parses stored levels defensively', () => {
    expect(parseStoredLevels(null)).toEqual({})
    expect(parseStoredLevels('not json')).toEqual({})
    expect(parseStoredLevels('[1,2]')).toEqual({})
    expect(parseStoredLevels('{"did:key:a":3,"did:key:b":"x"}')).toEqual({ 'did:key:a': 3 })
  })
})

describe('configTargetFor', () => {
  it('maps config paths to the config section that edits them', () => {
    expect(configTargetFor('tools.sys_create_adf')).toEqual({ subTab: 'config', section: 'Tools' })
    expect(configTargetFor('tools[].restricted')).toEqual({ subTab: 'config', section: 'Tools' })
    expect(configTargetFor('serving.public.enabled')).toEqual({ subTab: 'config', section: 'Serving' })
    expect(configTargetFor('adapters.telegram')).toEqual({ subTab: 'config', section: 'Channels' })
    expect(configTargetFor('autonomous')).toEqual({ subTab: 'config', section: 'Identity' })
    expect(configTargetFor('ws_connections')).toEqual({ subTab: 'config', section: 'WebSocket Connections' })
  })

  it('sends table-backed factors to their sub-tabs', () => {
    expect(configTargetFor('adf_identity.crypto:signing:private_key')).toEqual({ subTab: 'identity' })
    expect(configTargetFor('adf_timers')).toEqual({ subTab: 'timers' })
  })

  it('falls back to the config tab for unknown paths', () => {
    expect(configTargetFor('something_new')).toEqual({ subTab: 'config' })
  })
})

describe('skills bookshelf', () => {
  it('one spine per skill, taller for bigger skills, on an absolute scale', () => {
    const spines = shelfSpines([
      { name: 'big', tokens: 20_000, files: 9 },
      { name: 'small', tokens: 800, files: 1 },
      { name: 'registry', tokens: 0, files: 0 }
    ])
    expect(spines.map((s) => s.name)).toEqual(['big', 'small', 'registry'])
    expect(spines[0].height).toBeGreaterThan(spines[1].height)
    expect(spines[2]).toMatchObject({ height: SHELF_MIN_PX, empty: true, tip: 'registry · no files' })
    expect(spines[0].tip).toBe('big · ~20k tokens · 9 files')
  })

  it('caps a spine at full height and never limits the count', () => {
    expect(shelfSpines([{ name: 'huge', tokens: 5_000_000, files: 400 }])[0].height).toBe(SHELF_MAX_PX)
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `s${i}`, tokens: 1000, files: 1 }))
    expect(shelfSpines(many)).toHaveLength(300)
    expect(shelfSpines(undefined)).toEqual([])
  })
})
