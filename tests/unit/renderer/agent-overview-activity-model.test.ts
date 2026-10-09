import { describe, expect, it } from 'vitest'
import {
  approxTokens,
  compactInput,
  contentsView,
  dayTooltip,
  formatUntil,
  hasActivity,
  rowsLabel,
  sparkFact,
  sparkHeights,
  sparkSummary,
  timerRowText,
  waitingItems
} from '../../../src/renderer/components/agent/overview/agent-overview-model'
import type { ActivityDay, UpcomingWake } from '../../../src/shared/types/agent-vitals.types'

const MIN = 60_000

describe('relative times', () => {
  it('formatUntil', () => {
    expect(formatUntil(0, 10)).toBe('due')
    expect(formatUntil(20_000, 0)).toBe('in under a minute')
    expect(formatUntil(5 * MIN, 0)).toBe('in 5 min')
    expect(formatUntil(2 * 60 * MIN, 0)).toBe('in 2 h')
    expect(formatUntil(72 * 60 * MIN, 0)).toBe('in 3 days')
  })
})

describe('timer rows', () => {
  const wake = (w: Partial<UpcomingWake>): UpcomingWake => ({ id: 1, at: 0, scope: 'system', ...w })

  it('system: lambda then single-line JSON input, mono', () => {
    expect(timerRowText(wake({ lambda: 'lib/sync.ts:run', input: '{\n  "full": true,\n  "n": 2\n}' }))).toEqual({
      kind: 'lambda', head: 'lib/sync.ts:run', text: '{"full":true,"n":2}', mono: true
    })
    expect(timerRowText(wake({ lambda: 'lib/sync.ts:run' }))).toEqual({ kind: 'lambda', head: 'lib/sync.ts:run', mono: true })
  })

  it('system: long input is cut with the full text kept for the tooltip', () => {
    const input = JSON.stringify({ items: 'x'.repeat(100) })
    const v = timerRowText(wake({ lambda: 'lib/a.ts:go', input }))
    expect(v.text).toHaveLength(60)
    expect(v.text?.endsWith('…')).toBe(true)
    expect(v.full).toBe(input)
  })

  it('compactInput keeps non-JSON text on one line', () => {
    expect(compactInput('hello\n  world')).toBe('hello world')
    expect(compactInput(' [1, 2] ')).toBe('[1,2]')
  })

  it('agent: loop tag then the prompt start', () => {
    expect(timerRowText(wake({ scope: 'agent', loop: 'critic', prompt: 'Review\nthe draft' }))).toEqual({
      kind: 'loop', head: 'critic', text: 'Review the draft', mono: false
    })
    expect(timerRowText(wake({ scope: 'agent' }))).toEqual({ kind: 'loop', head: 'main', mono: false })
    const prompt = 'Check the inbox and answer every message that asks for a status report today'
    const v = timerRowText(wake({ scope: 'agent', loop: 'main', prompt }))
    expect(v.text).toBe(`${prompt.slice(0, 59)}…`)
    expect(v.full).toBe(prompt)
  })

  it('system without lambda or input falls back to a plain label', () => {
    expect(timerRowText(wake({}))).toEqual({ kind: 'none', text: 'System timer', mono: false })
    expect(timerRowText(wake({ input: 'x' }))).toEqual({ kind: 'none', text: 'x', mono: true })
  })
})

describe('waiting items', () => {
  it('lists approvals by tool name and asks by question, side loops named', () => {
    const items = waitingItems([
      {
        loop: 'main',
        log: [{ id: 'e1', type: 'tool_call', content: '', timestamp: 1, metadata: { name: 'fs_delete' } }],
        approvals: ['e1', 'missing'],
        asks: [['e2', { question: 'Which folder?\nMore text' }]]
      },
      { loop: 'critic', log: [], approvals: [], asks: [['e3', { question: '' }]] }
    ])
    expect(items.map((i) => i.text)).toEqual([
      'Approve fs_delete',
      'Approve a tool call',
      'Answer: Which folder?',
      'Answer a question in critic'
    ])
    expect(new Set(items.map((i) => i.key)).size).toBe(4)
  })
})

describe('sparkline', () => {
  const day = (date: string, turns: number, costUsd?: number, costPartial?: boolean): ActivityDay => ({ date, turns, costUsd, costPartial })

  it('summary and day tooltip', () => {
    expect(sparkSummary([day('2026-10-07', 1), day('2026-10-08', 2)])).toBe('3 turns in the last 2 days')
    expect(dayTooltip(day('2026-10-05', 4, 0.123))).toBe('Mon 5 Oct · 4 turns · $0.12')
    expect(dayTooltip(day('2026-10-08', 1, 2, true), true)).toBe('Today · 1 turn · $2.00 or more')
    expect(dayTooltip(day('2026-10-06', 0))).toBe('Tue 6 Oct · 0 turns')
  })

  it('folded chart fact; no chart without turns or cost', () => {
    expect(sparkFact([day('2026-10-07', 1), day('2026-10-08', 4)])).toBe('5 turns / 2d')
    expect(sparkFact([day('2026-10-08', 1)])).toBe('1 turn / 1d')
    expect(hasActivity([day('a', 0), day('b', 0)])).toBe(false)
    expect(hasActivity([day('a', 0, 0.01)])).toBe(true)
  })

  it('heights scale to the busiest day; empty days are 0, tiny days at least 2 px', () => {
    expect(sparkHeights([day('a', 0), day('b', 1), day('c', 100)], 40)).toEqual([0, 2, 40])
    expect(sparkHeights([day('a', 0)], 40)).toEqual([0])
  })

  it('rowsLabel', () => {
    expect(rowsLabel(1)).toBe('1 row')
    expect(rowsLabel(1200)).toBe('1.2k rows')
  })
})

describe('contents', () => {
  const contents = (mind: number, mindTokens: number, skills: number, skillTokens: number, tables: number, rows: number) => ({
    mind: { files: mind, tokens: mindTokens },
    skills: { count: skills, tokens: skillTokens },
    tables: { count: tables, rows }
  })

  it('approxTokens uses the compact formatter', () => {
    expect(approxTokens(850)).toBe('~850')
    expect(approxTokens(12_345)).toBe('~12k')
    expect(approxTokens(1_234_567)).toBe('~1.2M')
  })

  it('meter groups are mind and skills; tables are facts beside them', () => {
    expect(contentsView(contents(12, 20_000, 5, 18_000, 3, 2100))).toEqual({
      groups: [
        { key: 'mind', label: 'Mind', tokens: 20_000, text: 'Mind 12 files · ~20k', short: 'Mind ~20k' },
        { key: 'skills', label: 'Skills', tokens: 18_000, text: 'Skills 5 · ~18k', short: 'Skills ~18k' }
      ],
      total: 38_000,
      tables: 'Tables 3 · 2.1k rows'
    })
  })

  it('hides empty groups, and everything when all are empty', () => {
    expect(contentsView(contents(1, 3, 0, 0, 0, 0))).toEqual({
      groups: [{ key: 'mind', label: 'Mind', tokens: 3, text: 'Mind 1 file · ~3', short: 'Mind ~3' }],
      total: 3,
      tables: null
    })
    expect(contentsView(contents(0, 0, 0, 0, 1, 1))).toEqual({ groups: [], total: 0, tables: 'Tables 1 · 1 row' })
    expect(contentsView(contents(0, 0, 0, 0, 0, 0))).toBeNull()
  })
})
