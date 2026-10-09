import { describe, it, expect } from 'vitest'
import {
  agentStatusLabel,
  compactCount,
  configTargetFor,
  decideLevelUp,
  experienceTooltip,
  formatPoints,
  formatWake,
  overviewFacts,
  parseStoredLevels,
  powerSegments,
  powerTooltip,
  shortDid
} from '../../../src/renderer/components/agent/overview/agent-overview-model'
import { scoreExperience, toPowerStat } from '../../../src/shared/utils/agent-stats'
import type { AgentExperienceInputs, StatFactor } from '../../../src/shared/types/agent-vitals.types'

const factor = (id: string, label: string, points: number, gated = false, configPath = 'tools.x'): StatFactor => ({
  id, label, points, gated, configPath
})

const experienceInputs = (over: Partial<AgentExperienceInputs> = {}): AgentExperienceInputs => ({
  loopEntries: 0,
  filesWritten: 0,
  localTables: 0,
  localRows: 0,
  skills: 0,
  compactions: 0,
  agentsSpawned: null,
  ageDays: 0,
  ...over
})

describe('powerSegments', () => {
  it('fills open first, then gated, then empty', () => {
    expect(powerSegments({ open: 1, gated: 2 })).toEqual(['open', 'gated', 'gated', 'empty', 'empty'])
  })

  it('marks open segments at positions 4 and 5 as high', () => {
    expect(powerSegments({ open: 5, gated: 0 })).toEqual(['open', 'open', 'open', 'open-high', 'open-high'])
    expect(powerSegments({ open: 4, gated: 1 })).toEqual(['open', 'open', 'open', 'open-high', 'gated'])
  })

  it('never draws gated segments in the high colour', () => {
    expect(powerSegments({ open: 0, gated: 5 })).toEqual(['gated', 'gated', 'gated', 'gated', 'gated'])
  })

  it('clamps out-of-range input to five segments', () => {
    expect(powerSegments({ open: 9, gated: 3 })).toHaveLength(5)
    expect(powerSegments({ open: -1, gated: Number.NaN })).toEqual(['empty', 'empty', 'empty', 'empty', 'empty'])
  })

  it('matches segments = open + gated from the scorer', () => {
    const stat = toPowerStat([factor('a', 'A', 1.5), factor('b', 'B', 2, true)])
    const kinds = powerSegments(stat)
    expect(kinds.filter((k) => k !== 'empty')).toHaveLength(stat.segments)
    expect(kinds.filter((k) => k === 'gated')).toHaveLength(stat.gated)
  })
})

describe('powerTooltip', () => {
  it('names the count, the gated share and the two largest factors', () => {
    const stat = toPowerStat([
      factor('serving:public', 'Serves a public web page', 2),
      factor('serving:api', '3 HTTP API routes', 1.5),
      factor('messaging:send', 'Sends messages on its own', 1, true),
      factor('security:signed_only', 'Only accepts signed messages', -0.5)
    ])
    expect(powerTooltip(stat)).toBe(`${stat.segments} of 5, ${stat.gated} gated · serves a public web page, 3 HTTP API routes`)
  })

  it('leaves out the gated part when nothing is gated', () => {
    const stat = toPowerStat([factor('a', 'Reads its own files', 0.25)])
    expect(powerTooltip(stat)).toBe('1 of 5 · reads its own files')
  })

  it('drops trailing parentheticals from factor labels', () => {
    const stat = toPowerStat([
      factor('triggers', 'Wakes on 2 event types (on_inbox, on_timer)', 1),
      factor('tool:sys_update_config', 'Changes its own config (needs approval)', 0.5, true)
    ])
    expect(powerTooltip(stat)).toBe('2 of 5, 1 gated · wakes on 2 event types, changes its own config')
  })

  it('is just the count with no factors', () => {
    expect(powerTooltip(toPowerStat([]))).toBe('0 of 5')
  })
})

describe('experienceTooltip', () => {
  it('lists loop messages, files and skills, then the XP to the next level', () => {
    const exp = scoreExperience(experienceInputs({ loopEntries: 1234, filesWritten: 18, skills: 3 }))
    expect(experienceTooltip(exp)).toBe(
      `1.2k loop messages · 18 files · 3 skills · next level in ${compactCount(Math.ceil(exp.nextLevel.xp))} XP`
    )
  })

  it('omits zero counts', () => {
    const exp = scoreExperience(experienceInputs())
    expect(experienceTooltip(exp)).toBe('next level in 3 XP')
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

  it('signs points', () => {
    expect(formatPoints(1)).toBe('+1')
    expect(formatPoints(0.25)).toBe('+0.25')
    expect(formatPoints(-0.5)).toBe('-0.5')
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
  it('shortens a did:key', () => {
    expect(shortDid('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe('did:key:z6Mk…2doK')
    expect(shortDid('did:key:z6Mk')).toBe('did:key:z6Mk')
  })

  it('labels agent state', () => {
    expect(agentStatusLabel('active', { toolName: 'fs_write' })).toBe('Running fs_write')
    expect(agentStatusLabel('active')).toBe('Thinking')
    expect(agentStatusLabel('active', { waiting: true, toolName: 'fs_write' })).toBe('Waiting for approval')
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
