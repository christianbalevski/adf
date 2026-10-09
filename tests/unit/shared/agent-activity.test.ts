import { describe, expect, it } from 'vitest'
import { bucketByLocalDay, groupToolRuns, localDayKeys, mergeRecent, windowStartMs } from '../../../src/shared/utils/agent-activity'
import type { ActivityEvent } from '../../../src/shared/types/agent-vitals.types'

const tool = (label: string, at: number): ActivityEvent => ({ kind: 'tool', at, label })

describe('local day buckets', () => {
  it('splits at local midnight, not UTC', () => {
    const now = new Date(2026, 9, 8, 0, 30).getTime()
    const before = new Date(2026, 9, 7, 23, 59, 59).getTime()
    const after = new Date(2026, 9, 8, 0, 0, 1).getTime()
    const days = bucketByLocalDay([before, after, after], now)
    expect(days).toHaveLength(14)
    expect(days[13]).toEqual({ date: '2026-10-08', count: 2 })
    expect(days[12]).toEqual({ date: '2026-10-07', count: 1 })
  })

  it('drops times outside the window and keeps empty days', () => {
    const now = new Date(2026, 9, 8, 12).getTime()
    const tooOld = new Date(2026, 8, 24, 23, 59).getTime()
    const first = new Date(2026, 8, 25, 0, 0).getTime()
    const days = bucketByLocalDay([tooOld, first, NaN], now)
    expect(days[0]).toEqual({ date: '2026-09-25', count: 1 })
    expect(days.reduce((n, d) => n + d.count, 0)).toBe(1)
    expect(windowStartMs(now)).toBe(first)
  })

  it('crosses month and year ends', () => {
    expect(localDayKeys(new Date(2027, 0, 2, 9).getTime(), 3)).toEqual(['2026-12-31', '2027-01-01', '2027-01-02'])
  })
})

describe('tool-run grouping', () => {
  it('folds consecutive same-tool calls only', () => {
    const out = groupToolRuns([tool('fs_write', 5), tool('fs_write', 4), tool('fs_read', 3), tool('fs_write', 2), { ...tool('fs_write', 1), count: 2 }])
    expect(out.map((e) => [e.label, e.count, e.at])).toEqual([['fs_write', 2, 5], ['fs_read', undefined, 3], ['fs_write', 3, 2]])
  })

  it('never folds across another kind', () => {
    const turn: ActivityEvent = { kind: 'turn', at: 2, label: 'main' }
    expect(groupToolRuns([tool('a', 3), turn, tool('a', 1)])).toHaveLength(3)
  })

  it('mergeRecent sorts newest first, folds runs across lists and limits', () => {
    const merged = mergeRecent([[tool('fs_write', 10)], [tool('fs_write', 9), tool('fs_write', 8), { kind: 'file', at: 7, label: 'a.md' }]], 2)
    expect(merged).toEqual([{ kind: 'tool', at: 10, label: 'fs_write', count: 3 }, { kind: 'file', at: 7, label: 'a.md' }])
  })
})
