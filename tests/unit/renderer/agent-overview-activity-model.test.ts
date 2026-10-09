import { describe, expect, it } from 'vitest'
import {
  approxTokens,
  compactInput,
  contentsFoldedLine,
  contentsRows,
  dayTooltip,
  foldStep,
  formatUntil,
  hasActivity,
  rowsLabel,
  sparkFact,
  sparkHeights,
  sparkSummary,
  strataSegments,
  strataSummary,
  timerRowText,
  waitingItems,
  type FoldState
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
  const day = (date: string, messages: number, costUsd?: number, costPartial?: boolean, estimated?: boolean): ActivityDay =>
    ({ date, messages, costUsd, costPartial, estimated })

  it('summary and day tooltip', () => {
    expect(sparkSummary([day('2026-10-07', 1), day('2026-10-08', 2)])).toBe('3 messages in the last 2 days')
    expect(dayTooltip(day('2026-10-05', 4, 0.123))).toBe('Mon 5 Oct · 4 messages · $0.12')
    expect(dayTooltip(day('2026-10-08', 1, 2, true), true)).toBe('Today · 1 message · $2.00 or more')
    expect(dayTooltip(day('2026-10-06', 0))).toBe('Tue 6 Oct · 0 messages')
  })

  it('tooltip: unpriced calls and compacted history', () => {
    expect(dayTooltip(day('2026-10-06', 3, undefined, true))).toBe('Tue 6 Oct · 3 messages · cost not recorded')
    expect(dayTooltip(day('2026-10-06', 40, undefined, true, true))).toBe('Tue 6 Oct · 40 messages · cost not recorded · includes compacted history, timing estimated')
    expect(dayTooltip(day('2026-10-06', 40, 0.5, true, true))).toBe('Tue 6 Oct · 40 messages · $0.50 or more · includes compacted history, timing estimated')
  })

  it('folded chart fact; no chart without messages or cost', () => {
    expect(sparkFact([day('2026-10-07', 1), day('2026-10-08', 4)])).toBe('5 messages / 2d')
    expect(sparkFact([day('2026-10-08', 1)])).toBe('1 message / 1d')
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
  const contents = (mind: number, mindTokens: number, skills: number, skillTokens: number, tables: number, rows: number, recent = 0) => ({
    mind: { files: mind, tokens: mindTokens, updatedThisWeek: recent, strata: { older: 0, quarter: 0, month: 0, week: mindTokens } },
    skills: { count: skills, tokens: skillTokens },
    tables: { count: tables, rows }
  })

  it('approxTokens uses the compact formatter', () => {
    expect(approxTokens(850)).toBe('~850')
    expect(approxTokens(12_345)).toBe('~12k')
    expect(approxTokens(1_234_567)).toBe('~1.2M')
  })

  it('memory, skills and tables are separate rows', () => {
    expect(contentsRows(contents(12, 20_000, 5, 18_000, 3, 2100, 3))).toEqual([
      { key: 'mind', label: 'Memory', text: '~20k tokens · 12 files', aside: '3 updated this week' },
      { key: 'skills', label: 'Skills', text: '5 skills · ~18k tokens' },
      { key: 'tables', label: 'Tables', text: '3 tables · 2.1k rows' }
    ])
  })

  it('hides empty rows, the weekly note at 0, and everything when all are empty', () => {
    expect(contentsRows(contents(1, 3, 0, 0, 0, 0))).toEqual([{ key: 'mind', label: 'Memory', text: '~3 tokens · 1 file' }])
    expect(contentsRows(contents(0, 0, 1, 10, 1, 1))).toEqual([
      { key: 'skills', label: 'Skills', text: '1 skill · ~10 tokens' },
      { key: 'tables', label: 'Tables', text: '1 table · 1 row' }
    ])
    expect(contentsRows(contents(0, 0, 0, 0, 0, 0))).toEqual([])
  })

  it('folds into one line', () => {
    expect(contentsFoldedLine(contents(12, 20_000, 5, 18_000, 3, 2100))).toBe('Memory ~20k · 5 skills · 3 tables')
    expect(contentsFoldedLine(contents(0, 0, 1, 10, 1, 1))).toBe('1 skill · 1 table')
    expect(contentsFoldedLine(contents(2, 40, 0, 0, 0, 0))).toBe('Memory ~40')
    expect(contentsFoldedLine(contents(0, 0, 0, 0, 0, 0))).toBe('')
  })
})

describe('memory strata', () => {
  it('segments run oldest to newest with widths as shares of the total', () => {
    const segs = strataSegments({ older: 12_000, quarter: 3000, month: 0, week: 1000 })
    expect(segs.map((s) => s.band)).toEqual(['older', 'quarter', 'week'])
    expect(segs.map((s) => s.pct)).toEqual([75, 18.8, 6.3])
    expect(segs.map((s) => s.tokens)).toEqual([12_000, 3000, 1000])
  })

  it('tooltips name tokens and age', () => {
    const tips = strataSegments({ older: 12_000, quarter: 3000, month: 800, week: 1000 }).map((s) => s.tip)
    expect(tips).toEqual([
      '~12k tokens last updated over 90 days ago',
      '~3k tokens last updated 30–90 days ago',
      '~800 tokens last updated 7–30 days ago',
      '~1k tokens last updated in the last 7 days'
    ])
  })

  it('summary for screen readers', () => {
    expect(strataSummary(strataSegments({ older: 12_000, quarter: 0, month: 0, week: 500 })))
      .toBe('Memory by last update: ~12k tokens over 90 days ago, ~500 tokens in the last 7 days')
  })

  it('no strip when memory is 0 or missing', () => {
    expect(strataSegments({ older: 0, quarter: 0, month: 0, week: 0 })).toEqual([])
    expect(strataSegments(undefined)).toEqual([])
  })
})

describe('overflow folds', () => {
  type K = 'chart' | 'contents'
  const ORDER = ['chart', 'contents'] as const
  const both = { chart: true, contents: true }
  const empty: FoldState<K> = { folds: [], before: 0 }
  const keys = (s: FoldState<K>) => s.folds.map((f) => f.key)

  it('folds the chart first, then contents, one per check', () => {
    let s = foldStep(empty, ORDER, both, 700, 600)
    expect(keys(s)).toEqual(['chart'])
    // Chart folded saved 60; still too tall: contents next.
    s = foldStep(s, ORDER, both, 640, 600)
    expect(s.folds).toEqual([{ key: 'chart', saved: 60 }, { key: 'contents', saved: 0 }])
    s = foldStep(s, ORDER, both, 580, 600)
    expect(s.folds).toEqual([{ key: 'chart', saved: 60 }, { key: 'contents', saved: 60 }])
    // Nothing left to fold: unchanged object.
    const t = foldStep(s, ORDER, both, 580, 600)
    expect(t).toBe(s)
  })

  it('unfolds in reverse order only when what the fold saved fits', () => {
    const s: FoldState<K> = { folds: [{ key: 'chart', saved: 60 }, { key: 'contents', saved: 60 }], before: 640 }
    // 580 + 60 > 630: stays.
    expect(foldStep(s, ORDER, both, 580, 630)).toBe(s)
    // 580 + 60 <= 650: contents unfolds; chart (640 + 60 > 650) stays.
    expect(keys(foldStep(s, ORDER, both, 580, 650))).toEqual(['chart'])
    // Room for both: both unfold, contents first.
    expect(keys(foldStep(s, ORDER, both, 580, 800))).toEqual([])
  })

  it('does not flip-flop at the threshold', () => {
    let s = foldStep(empty, ORDER, both, 610, 600)
    s = foldStep(s, ORDER, both, 550, 600)
    expect(s.folds).toEqual([{ key: 'chart', saved: 60 }])
    // 550 + 60 = 610 > 600: stays folded however often it checks.
    for (let i = 0; i < 3; i++) expect(foldStep(s, ORDER, both, 550, 600)).toBe(s)
  })

  it('skips a disabled section and unfolds one that becomes disabled', () => {
    const s = foldStep(empty, ORDER, { chart: false, contents: true }, 700, 600)
    expect(keys(s)).toEqual(['contents'])
    const folded: FoldState<K> = { folds: [{ key: 'chart', saved: 60 }], before: 640 }
    expect(keys(foldStep(folded, ORDER, { chart: false, contents: true }, 580, 600))).toEqual([])
  })

  it('waits for a measured height', () => {
    const s = foldStep(empty, ORDER, both, 700, 0)
    expect(s).toBe(empty)
  })
})
