/**
 * docs/guides/agent-overview.md states every scoring constant in tables whose
 * second column is the constant (`NAME.key` or `NAME`) and third its value.
 * Every such row must match the export, and every export must have a row.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_POINTS,
  ACCESS_TOOL_POINTS,
  AUTONOMY_POINTS,
  EXPERIENCE_CURVE,
  EXPERIENCE_WEIGHTS,
  POWER_HIGH_OPEN_SHARE,
  POWER_LEVEL_MAX,
  POWER_MAX,
  REACH_POINTS,
  VISIBILITY_POINTS
} from '../../../src/shared/utils/agent-stats'
import { MEMORY_STRATA_DAYS } from '../../../src/shared/types/agent-vitals.types'

const DOC = readFileSync(join(__dirname, '../../../docs/guides/agent-overview.md'), 'utf-8')

const expected = new Map<string, number>()
const add = (name: string, obj: Record<string, number | { points: number }>): void => {
  for (const [k, v] of Object.entries(obj)) expected.set(`${name}.${k}`, typeof v === 'number' ? v : v.points)
}
add('EXPERIENCE_WEIGHTS', EXPERIENCE_WEIGHTS)
add('EXPERIENCE_CURVE', EXPERIENCE_CURVE as unknown as Record<string, number>)
add('ACCESS_TOOL_POINTS', ACCESS_TOOL_POINTS)
add('ACCESS_POINTS', ACCESS_POINTS)
add('VISIBILITY_POINTS', VISIBILITY_POINTS)
add('REACH_POINTS', REACH_POINTS)
add('AUTONOMY_POINTS', AUTONOMY_POINTS)
add('POWER_MAX', POWER_MAX)
add('MEMORY_STRATA_DAYS', MEMORY_STRATA_DAYS)
expected.set('POWER_LEVEL_MAX', POWER_LEVEL_MAX)
expected.set('POWER_HIGH_OPEN_SHARE', POWER_HIGH_OPEN_SHARE)

/** Table rows `| … | `CONST` | value | …` → CONST → value as written. */
function docRows(): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of DOC.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // cells[0] is '' before the first pipe; the constant is in column 2 or, for two-column tables, column 1.
    for (let i = 1; i < cells.length - 1; i++) {
      const m = /^`([A-Z_]+(?:\.[A-Za-z_]+)?)`$/.exec(cells[i])
      if (m && expected.has(m[1])) rows.set(m[1], cells[i + 1])
    }
  }
  return rows
}

describe('agent-overview.md matches agent-stats.ts and MEMORY_STRATA_DAYS', () => {
  const rows = docRows()

  it('documents every constant', () => {
    expect([...expected.keys()].filter((k) => !rows.has(k))).toEqual([])
  })

  for (const [name, value] of expected) {
    it(`${name} = ${value}`, () => {
      expect(Number(rows.get(name)?.replace(/\s/g, ''))).toBe(value)
    })
  }
})
