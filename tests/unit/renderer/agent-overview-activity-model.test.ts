import { describe, expect, it } from 'vitest'
import {
  activityEventText,
  approxTokens,
  contentsView,
  dayTooltip,
  formatAgo,
  formatUntil,
  liveLogEvents,
  mergeLiveActivity,
  rowsLabel,
  sparkHeights,
  sparkSummary,
  waitingItems,
  type LiveLogEntry
} from '../../../src/renderer/components/agent/overview/agent-overview-model'
import type { ActivityDay, ActivityEvent } from '../../../src/shared/types/agent-vitals.types'

const MIN = 60_000

describe('relative times', () => {
  it('formatAgo', () => {
    expect(formatAgo(1000, 30_000)).toBe('just now')
    expect(formatAgo(0, 4 * MIN)).toBe('4 min ago')
    expect(formatAgo(0, 3 * 60 * MIN)).toBe('3 h ago')
    expect(formatAgo(0, 3 * 24 * 60 * MIN)).toBe('3 days ago')
  })

  it('formatUntil', () => {
    expect(formatUntil(0, 10)).toBe('due')
    expect(formatUntil(20_000, 0)).toBe('in under a minute')
    expect(formatUntil(5 * MIN, 0)).toBe('in 5 min')
    expect(formatUntil(2 * 60 * MIN, 0)).toBe('in 2 h')
    expect(formatUntil(72 * 60 * MIN, 0)).toBe('in 3 days')
  })
})

describe('event text', () => {
  it('names each kind plainly; tool names and paths go monospace', () => {
    expect(activityEventText({ kind: 'turn', at: 0, label: 'main', loop: 'main' })).toEqual({ lead: 'Turn finished' })
    expect(activityEventText({ kind: 'turn', at: 0, label: 'critic', loop: 'critic' })).toEqual({ lead: 'Turn finished in ', mono: 'critic' })
    expect(activityEventText({ kind: 'tool', at: 0, label: 'fs_write', count: 4 })).toEqual({ lead: '', mono: 'fs_write', tail: ' ×4' })
    expect(activityEventText({ kind: 'tool', at: 0, label: 'fs_read' }).tail).toBeUndefined()
    expect(activityEventText({ kind: 'message_in', at: 0, label: 'agent-2' }).lead).toBe('Message from agent-2')
    expect(activityEventText({ kind: 'message_out', at: 0, label: 'agent-2' }).lead).toBe('Message to agent-2')
    expect(activityEventText({ kind: 'file', at: 0, label: 'notes/a.md' })).toEqual({ lead: 'Wrote ', mono: 'notes/a.md' })
    expect(activityEventText({ kind: 'error', at: 0, label: 'fs_read failed' }).lead).toBe('fs_read failed')
  })
})

describe('live merge', () => {
  const log: LiveLogEntry[] = [
    { type: 'tool_call', content: 'Calling fs_write', timestamp: 100, metadata: { name: 'fs_write' } },
    { type: 'tool_call', content: 'Calling fs_write', timestamp: 200, metadata: { name: 'fs_write' } },
    { type: 'tool_result', content: 'ok', timestamp: 210, metadata: { name: 'fs_write', isError: false } },
    { type: 'tool_call', content: 'Calling fs_read', timestamp: 300, metadata: { name: 'fs_read' } },
    { type: 'tool_result', content: 'nope', timestamp: 310, metadata: { name: 'fs_read', isError: true } },
    { type: 'inter_agent', content: 'hi', timestamp: 400, metadata: { direction: 'incoming', fromAgent: 'agent-2', toAgent: 'agent-1' } },
    { type: 'error', content: 'Provider error\ndetails', timestamp: 500 },
    { type: 'text', content: 'thinking out loud', timestamp: 600 }
  ]

  it('converts only entries after the read, newest first', () => {
    expect(liveLogEvents(log, 150).map((e) => [e.kind, e.label])).toEqual([
      ['error', 'Provider error'],
      ['message_in', 'agent-2'],
      ['error', 'fs_read failed'],
      ['tool', 'fs_read'],
      ['tool', 'fs_write']
    ])
    expect(liveLogEvents(log, 1000)).toEqual([])
  })

  it('folds a live tool run into the server run it continues', () => {
    const server: ActivityEvent[] = [{ kind: 'tool', at: 90, label: 'fs_write', count: 2 }, { kind: 'turn', at: 50, label: 'main' }]
    const merged = mergeLiveActivity(server, log.slice(0, 2), 50)
    expect(merged[0]).toEqual({ kind: 'tool', at: 200, label: 'fs_write', count: 4 })
    expect(merged[1].kind).toBe('turn')
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
        { key: 'mind', label: 'Mind', tokens: 20_000, text: 'Mind 12 files · ~20k' },
        { key: 'skills', label: 'Skills', tokens: 18_000, text: 'Skills 5 · ~18k' }
      ],
      total: 38_000,
      tables: 'Tables 3 · 2.1k rows'
    })
  })

  it('hides empty groups, and everything when all are empty', () => {
    expect(contentsView(contents(1, 3, 0, 0, 0, 0))).toEqual({
      groups: [{ key: 'mind', label: 'Mind', tokens: 3, text: 'Mind 1 file · ~3' }],
      total: 3,
      tables: null
    })
    expect(contentsView(contents(0, 0, 0, 0, 1, 1))).toEqual({ groups: [], total: 0, tables: 'Tables 1 · 1 row' })
    expect(contentsView(contents(0, 0, 0, 0, 0, 0))).toBeNull()
  })
})
