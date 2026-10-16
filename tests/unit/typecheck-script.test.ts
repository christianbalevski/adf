import { describe, expect, it, vi } from 'vitest'
import { runTypecheckProjects } from '../../scripts/typecheck.mjs'

describe('typecheck script', () => {
  it('checks both production projects and fails if either check fails', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 0 })

    expect(runTypecheckProjects(run)).toBe(1)
    expect(run.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'tsconfig.node.json',
      'tsconfig.web.json',
    ])
  })
})
