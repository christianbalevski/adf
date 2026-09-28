import { describe, expect, it } from 'vitest'
import {
  compactDiff,
  describeTimer,
  entryMatches,
  formatDuration,
  hostLoopTools,
  jsonLineDiff,
  loopPatch,
  parseDuration,
  parseWhen,
  scheduleToTimer,
  timerToDraft,
  timerTriggerWarning,
  timersForLoop,
  toolOptions,
  triggersForLoop,
  validateLoopName,
} from '../../src/main/tui/views/loops/model'
import { findTemplate, freeName, LOOP_TEMPLATES } from '../../src/main/tui/views/loops/templates'
import { valuesToTarget } from '../../src/main/tui/views/loops/TriggerDialog'
import type { AgentConfig, LoopEntry, Timer } from '../../src/main/tui/api/types'

// 2026-09-28 10:00 local time.
const NOW = new Date(2026, 8, 28, 10, 0, 0, 0).getTime()

describe('loop names', () => {
  it('follows LOOP_NAME_PATTERN and reserves main', () => {
    expect(validateLoopName('consolidator')).toBeNull()
    expect(validateLoopName('agent-1_x')).toBeNull()
    expect(validateLoopName('')).toMatch(/required/)
    expect(validateLoopName('main')).toMatch(/implicit/)
    expect(validateLoopName('Main')).toMatch(/lowercase/)
    expect(validateLoopName('-lead')).toMatch(/starting/)
    expect(validateLoopName('a'.repeat(33))).toMatch(/1-32/)
    expect(validateLoopName('critic', ['main', 'critic'])).toMatch(/already exists/)
  })
})

describe('tools', () => {
  it('offers only enabled, unrestricted, non-prohibited host tools', () => {
    const config = {
      tools: [
        { name: 'fs_read', enabled: true, visible: true },
        { name: 'msg_send', enabled: true, visible: true, restricted: true },
        { name: 'db_execute', enabled: false, visible: true },
        { name: 'loop_manage', enabled: true, visible: true },
        { name: 'loop_send', enabled: true, visible: true },
      ],
    } as unknown as AgentConfig
    expect(hostLoopTools(config)).toEqual(['fs_read', 'loop_send'])
    expect(hostLoopTools(undefined)).toBeNull()
    const options = toolOptions(['fs_read', 'loop_send'], ['sys_fetch'])
    expect(options).toEqual([{ name: 'fs_read', unavailable: false }, { name: 'loop_send', unavailable: false }, { name: 'sys_fetch', unavailable: true }])
  })
})

describe('schedules', () => {
  it('parses and formats durations', () => {
    expect(parseDuration('15m')).toBe(900_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('90')).toBe(5_400_000)
    expect(parseDuration('2x')).toBeNull()
    expect(formatDuration(5_400_000)).toBe('1h30m')
    expect(formatDuration(86_400_000)).toBe('1d')
  })

  it('builds interval timers aimed at a loop with a readable preview', () => {
    const result = scheduleToTimer({ kind: 'every', value: '15m', payload: 'tidy' }, 'consolidator', { now: NOW })
    expect(result.error).toBeUndefined()
    expect(result.input).toEqual({ scope: ['agent'], payload: 'tidy', loop: 'consolidator', mode: 'interval', every_ms: 900_000 })
    expect(result.preview).toBe('every 15m, next at 10:15')
  })

  it('turns daily HH:MM into cron and omits loop for main', () => {
    const result = scheduleToTimer({ kind: 'daily', value: '03:00', payload: '' }, 'main', { now: NOW })
    expect(result.input).toEqual({ scope: ['agent'], mode: 'cron', cron: '0 3 * * *' })
    expect(result.preview).toBe('daily at 03:00, next tomorrow 03:00')
  })

  it('validates cron, one-shots and run caps', () => {
    expect(scheduleToTimer({ kind: 'cron', value: 'not cron', payload: '' }, 'x', { now: NOW }).error).toMatch(/valid cron/)
    expect(scheduleToTimer({ kind: 'cron', value: '0 */6 * * *', payload: '', maxRuns: '3' }, 'x', { now: NOW }).input).toMatchObject({ mode: 'cron', cron: '0 */6 * * *', max_runs: 3 })
    expect(scheduleToTimer({ kind: 'every', value: '2s', payload: '' }, 'x', { now: NOW }).error).toMatch(/5s/)
    expect(scheduleToTimer({ kind: 'in', value: '10m', payload: '' }, 'x', { now: NOW }).input).toMatchObject({ mode: 'once_delay', delay_ms: 600_000 })
    const at = scheduleToTimer({ kind: 'at', value: '14:30', payload: '' }, 'x', { now: NOW })
    expect(at.input).toMatchObject({ mode: 'once_at', at: new Date(2026, 8, 28, 14, 30).getTime() })
    expect(at.preview).toBe('once at 14:30')
    expect(scheduleToTimer({ kind: 'at', value: '2020-01-01 09:00', payload: '' }, 'x', { now: NOW }).error).toMatch(/past/)
    expect(scheduleToTimer({ kind: 'every', value: '1h', payload: '' }, 'researcher', { now: NOW, scope: ['system'], lambda: 'a.ts:b' }).input).not.toHaveProperty('loop')
    expect(parseWhen('09:00', NOW)).toBe(new Date(2026, 8, 29, 9, 0).getTime())
  })

  it('describes timers and round-trips them into drafts', () => {
    const daily = { id: 2, schedule: { mode: 'cron', cron: '30 21 * * *' }, next_wake_at: NOW, scope: ['agent'], run_count: 0, created_at: NOW } as Timer
    const every = { id: 1, schedule: { mode: 'interval', every_ms: 3_600_000 }, next_wake_at: NOW + 1, scope: ['agent'], loop: 'consolidator', run_count: 3, created_at: NOW, payload: 'go' } as Timer
    expect(describeTimer(daily)).toBe('daily at 21:30')
    expect(describeTimer(every)).toBe('every 1h')
    expect(timerToDraft(daily)).toMatchObject({ kind: 'daily', value: '21:30' })
    expect(timerToDraft(every)).toMatchObject({ kind: 'every', value: '1h', payload: 'go' })
    expect(timersForLoop([daily, every], 'consolidator').map(t => t.id)).toEqual([1])
    expect(timersForLoop([daily, every], 'main').map(t => t.id)).toEqual([2])
  })
})

describe('triggers', () => {
  const triggers = {
    on_timer: { enabled: true, targets: [{ scope: 'agent' as const }, { scope: 'agent' as const, loop: 'consolidator' }] },
    on_inbox: { enabled: false, targets: [{ scope: 'agent' as const, loop: 'researcher' }, { scope: 'system' as const, lambda: 'a.ts:b' }] },
  }

  it('finds the targets that wake a loop', () => {
    expect(triggersForLoop(triggers, 'consolidator')).toEqual([{ type: 'on_timer', enabled: true, targetIndex: 1 }])
    expect(triggersForLoop(triggers, 'main')).toEqual([{ type: 'on_timer', enabled: true, targetIndex: 0 }])
    expect(triggersForLoop(triggers, 'researcher')).toEqual([{ type: 'on_inbox', enabled: false, targetIndex: 0 }])
  })

  it('warns when on_timer cannot wake a loop', () => {
    expect(timerTriggerWarning({ triggers } as unknown as AgentConfig)).toBeNull()
    expect(timerTriggerWarning({ triggers: { on_timer: { enabled: false, targets: [] } } } as unknown as AgentConfig)).toMatch(/off/)
    expect(timerTriggerWarning({ triggers: {} } as unknown as AgentConfig)).toMatch(/off/)
  })

  it('builds trigger targets from the form, keeping unknown keys', () => {
    const built = valuesToTarget({ scope: 'agent', loop: 'critic', timing: 'debounce', timingValue: '30s', filter: '{"source":"telegram"}', locked: false }, { scope: 'agent', extra: 1 } as never)
    expect(built).toEqual({ target: { scope: 'agent', extra: 1, loop: 'critic', debounce_ms: 30_000, filter: { source: 'telegram' } } })
    expect(valuesToTarget({ scope: 'agent', loop: 'main', timing: 'none' })).toEqual({ target: { scope: 'agent' } })
    expect(valuesToTarget({ scope: 'system', timing: 'none' })).toMatchObject({ errors: { lambda: expect.any(String) } })
    expect(valuesToTarget({ scope: 'agent', timing: 'none', filter: '[1]' })).toMatchObject({ errors: { filter: expect.any(String) } })
  })

  it('diffs configs line by line', () => {
    const lines = jsonLineDiff({ on_timer: { enabled: true } }, { on_timer: { enabled: false } })
    expect(lines.filter(l => l.sign !== ' ').map(l => `${l.sign}${l.text.trim()}`)).toEqual(['-"enabled": true', '+"enabled": false'])
    expect(compactDiff(lines, 0).some(l => l.sign === '…')).toBe(true)
  })
})

describe('loop edits and history', () => {
  it('patches only changed fields', () => {
    const before = { name: 'critic', goal: 'a', enabled: true, tools: ['loop_send', 'fs_read'] }
    const { patch, changes } = loopPatch(before, { goal: 'a', enabled: false, tools: ['fs_read', 'loop_send'], autostart: false })
    expect(patch).toEqual({ enabled: false })
    expect(changes).toEqual([{ field: 'enabled', before: 'true', after: 'false' }])
  })

  it('filters entries by role, tool and text', () => {
    const tool = { seq: 1, role: 'assistant', content_json: [{ type: 'tool_use', id: 't', name: 'fs_read', input: { path: 'mind.md' } }], created_at: NOW } as LoopEntry
    const text = { seq: 2, role: 'user', content_json: [{ type: 'text', text: 'hello there' }], created_at: NOW } as LoopEntry
    expect(entryMatches(tool, 'tools', '')).toBe(true)
    expect(entryMatches(text, 'tools', '')).toBe(false)
    expect(entryMatches(tool, 'all', 'fs_')).toBe(true)
    expect(entryMatches(text, 'user', 'hello')).toBe(true)
    expect(entryMatches(text, 'assistant', '')).toBe(false)
  })
})

describe('templates', () => {
  it('offers the four starters plus blank, with free names', () => {
    expect(LOOP_TEMPLATES.map(t => t.id)).toEqual(['consolidator', 'researcher', 'critic', 'reflector', 'blank'])
    expect(findTemplate('consolidator')?.schedule).toMatchObject({ kind: 'daily', value: '03:00' })
    expect(findTemplate('nope')).toBeUndefined()
    expect(freeName('consolidator', ['main', 'consolidator'])).toBe('consolidator-2')
    for (const t of LOOP_TEMPLATES.filter(t => t.id !== 'blank')) {
      expect(validateLoopName(t.name)).toBeNull()
      expect(t.tools).toEqual(expect.arrayContaining(['loop_send', 'loop_list', 'sys_set_state']))
    }
  })
})
