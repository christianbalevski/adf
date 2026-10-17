import { describe, expect, it } from 'vitest'
import { statusHandlers } from '../../../src/main/tools/shell/commands/status'
import type { CommandContext } from '../../../src/main/tools/shell/commands/types'

/**
 * `status` promised "token usage, budget remaining" but printed neither: the
 * only extra line read `limits.token_budget`, a field that has never existed.
 * It now reports the current loop's token usage, counted the same way as the
 * daemon's /agents/:id/usage.
 */

const status = statusHandlers.find((h) => h.name === 'status')!

function run(loop: () => unknown[], limits: Record<string, unknown> = {}) {
  const ctx = {
    stdin: '',
    args: [],
    flags: {},
    config: {
      name: 'agent-1',
      state: 'active',
      model: { provider: 'anthropic', model_id: 'claude-x' },
      autonomous: false,
      limits,
    },
    workspace: { getLoop: loop },
  } as unknown as CommandContext
  return status.execute(ctx)
}

describe('shell status', () => {
  it('reports token usage summed over the current loop', async () => {
    const r = await run(() => [
      { role: 'user', content_json: [] },
      { role: 'assistant', model: 'claude-x', tokens: { input: 10_000, output: 1_200, cache_read: 8_000 } },
      { role: 'assistant', model: 'claude-y', tokens: { input: 2_500, output: 300 } },
    ])
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain('Model:     anthropic/claude-x')
    expect(r.stdout).toContain(
      'Tokens:    14,000 total: 12,500 in (8,000 cached), 1,500 out; 2 calls in the current loop',
    )
  })

  it('says so when the loop has no usage yet', async () => {
    const r = await run(() => [{ role: 'user', content_json: [] }])
    expect(r.stdout).toContain('Tokens:    none recorded in the current loop')
  })

  it('still prints the rest when the loop cannot be read', async () => {
    const r = await run(() => { throw new Error('locked') })
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain('State:     active')
    expect(r.stdout).toContain('Tokens:    unavailable')
  })

  it('no longer prints a budget line for a field the runtime never had', async () => {
    const r = await run(() => [], { token_budget: 50_000 })
    expect(r.stdout).not.toContain('Budget')
  })

  it('describes what it prints', () => {
    expect(status.helpText).toContain('token usage')
    expect(status.helpText).not.toContain('budget')
  })
})
