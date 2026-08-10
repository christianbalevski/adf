import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { SysSetMetaTool } from '../../../src/main/tools/built-in/sys-set-meta.tool'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { metaHandlers } from '../../../src/main/tools/shell/commands/meta'
import type { AdfWorkspace as Ws } from '../../../src/main/adf/adf-workspace'

/**
 * Atomic meta counters.
 *
 * LIVE BUG: an agent kept a cumulative `llm_tokens_total` on an
 * increment-protected key and updated it read-then-write from concurrent async
 * tasks. Two tasks read the same base, the larger write landed first, and the
 * smaller one was then "not increasing" — so the protection raised a human
 * approval prompt for what was really a lost update. Approving would have been
 * WORSE than denying: the override writes the value verbatim, erasing the other
 * task's tokens.
 *
 * `delta` makes the read-modify-write atomic, so the race cannot happen and no
 * prompt is raised. These tests pin both halves: the race is real for `value`,
 * and absent for `delta`.
 */

const dirs: string[] = []
function realWorkspace(): AdfWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'adf-counter-'))
  dirs.push(dir)
  return AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'agent-1' })
}
// Windows keeps the sqlite handle briefly after close; cleanup is best-effort
// and must never fail an otherwise-passing test.
function cleanup(): void {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

describe('incrementMeta is atomic', () => {
  it('concurrent read-then-write loses an update; delta does not', async () => {
    const ws = realWorkspace()
    try {
      ws.setMeta('tokens_rmw', '1000', 'increment')
      ws.setMeta('tokens_atomic', '1000', 'increment')

      // Two "tasks" that both read before either writes — exactly what async
      // batches do across an await boundary.
      const baseA = Number(ws.getMeta('tokens_rmw'))
      const baseB = Number(ws.getMeta('tokens_rmw'))
      ws.setMeta('tokens_rmw', String(baseA + 500))
      ws.setMeta('tokens_rmw', String(baseB + 200))   // clobbers A's 500
      expect(ws.getMeta('tokens_rmw')).toBe('1200')   // 500 tokens vanished

      expect(ws.incrementMeta('tokens_atomic', 500)).toBe('1500')
      expect(ws.incrementMeta('tokens_atomic', 200)).toBe('1700')
      expect(ws.getMeta('tokens_atomic')).toBe('1700') // nothing lost
    } finally {
      ws.close?.()
      cleanup()
    }
  })

  it('creates a missing key at delta, keeps integers integral, preserves protection', async () => {
    const ws = realWorkspace()
    try {
      expect(ws.incrementMeta('fresh', 1200, 'increment')).toBe('1200')
      expect(ws.getMetaProtection('fresh')).toBe('increment')
      expect(ws.incrementMeta('fresh', 1)).toBe('1201')      // not "1201.0"
      // A later add must not reset the protection level.
      expect(ws.getMetaProtection('fresh')).toBe('increment')

      expect(ws.incrementMeta('frac', 0.1)).toBe('0.1')
      expect(ws.incrementMeta('frac', 0.2)).toBe('0.3')      // not 0.30000000000000004
    } finally {
      ws.close?.()
      cleanup()
    }
  })

  it('refuses a non-numeric stored value instead of corrupting it', async () => {
    const ws = realWorkspace()
    try {
      ws.setMeta('note', 'hello')
      expect(ws.incrementMeta('note', 5)).toBeNull()
      expect(ws.getMeta('note')).toBe('hello')
      ws.setMeta('blank', '')
      expect(ws.incrementMeta('blank', 5)).toBeNull()        // Number('') is 0 — not a counter
    } finally {
      ws.close?.()
      cleanup()
    }
  })
})

// ── Tool surface ──

function metaWorkspace(protection: 'readonly' | 'increment' | null, current = '100') {
  const calls: Array<{ op: string; key: string; arg: unknown }> = []
  const logs: string[] = []
  let stored = current
  const ws = {
    getMetaProtection: () => protection,
    getMeta: () => stored,
    setMeta: (key: string, value: string) => { calls.push({ op: 'set', key, arg: value }); stored = value },
    incrementMeta: (key: string, delta: number) => {
      calls.push({ op: 'incr', key, arg: delta })
      const next = Number(stored) + delta
      if (!Number.isFinite(Number(stored))) return null
      stored = String(next)
      return stored
    },
    insertLog: (_l: string, _o: string, _e: string, _t: string, message: string) => { logs.push(message) },
  } as unknown as Ws
  return { ws, calls, logs }
}

function registryWith(ws: Ws) {
  const registry = new ToolRegistry()
  registry.register(new SysSetMetaTool())
  return (input: unknown) => registry.executeTool('sys_set_meta', input, ws)
}

describe('sys_set_meta delta', () => {
  it('a positive delta on an increment key just works — no denial, no prompt', async () => {
    const { ws, calls } = metaWorkspace('increment', '32834193')
    const r = await registryWith(ws)({ key: 'llm_tokens_total', delta: 500 })
    expect(r.isError).toBe(false)
    expect(r.content).toContain('32834693')
    expect(calls).toEqual([{ op: 'incr', key: 'llm_tokens_total', arg: 500 }])
  })

  it('a non-positive delta on an increment key is refused with a structured protection', async () => {
    const { ws, calls } = metaWorkspace('increment')
    const r = await registryWith(ws)({ key: 'counter', delta: -5 })
    expect(r.isError).toBe(true)
    expect(r.protection).toMatchObject({ kind: 'meta_protection', target: 'counter', level: 'increment' })
    expect(calls).toEqual([]) // nothing written
  })

  it('a readonly key refuses a delta', async () => {
    const { ws, calls } = metaWorkspace('readonly')
    const r = await registryWith(ws)({ key: 'adf_did', delta: 1 })
    expect(r.isError).toBe(true)
    expect(r.protection).toMatchObject({ level: 'readonly' })
    expect(calls).toEqual([])
  })

  it('an approved override applies the delta and leaves an audit trail', async () => {
    const { ws, calls, logs } = metaWorkspace('increment')
    const r = await registryWith(ws)({ key: 'counter', delta: -5, _protection_override: true })
    expect(r.isError).toBe(false)
    expect(r.content).toContain('protection override')
    expect(calls).toEqual([{ op: 'incr', key: 'counter', arg: -5 }])
    expect(logs.join(' ')).toContain('human-approved override')
  })

  it('a non-numeric stored value is a plain error, not an overridable protection', async () => {
    const { ws } = metaWorkspace(null, 'not-a-number')
    const r = await registryWith(ws)({ key: 'note', delta: 1 })
    expect(r.isError).toBe(true)
    expect(r.protection).toBeUndefined()
  })

  it('value and delta are mutually exclusive', async () => {
    const { ws } = metaWorkspace(null)
    const both = await registryWith(ws)({ key: 'k', value: '1', delta: 1 })
    expect(both.isError).toBe(true)
    expect(both.content).toContain('exactly one')
    const neither = await registryWith(ws)({ key: 'k' })
    expect(neither.isError).toBe(true)
  })

  it('the absolute-value path is unchanged', async () => {
    const { ws, calls } = metaWorkspace(null)
    const r = await registryWith(ws)({ key: 'status', value: 'shipped' })
    expect(r.isError).toBe(false)
    expect(r.content).toBe('OK')
    expect(calls).toEqual([{ op: 'set', key: 'status', arg: 'shipped' }])
  })
})

describe('meta incr (shell)', () => {
  const metaHandler = metaHandlers[0]

  function ctxFor(args: string[]) {
    const dispatched: Array<{ tool: string; input: any }> = []
    const ctx = {
      stdin: '', args, flags: {}, rawArgs: args,
      config: { name: 'agent-1' },
      workspace: {},
      toolRegistry: {
        executeTool: async (tool: string, input: any) => {
          dispatched.push({ tool, input })
          return { isError: false, content: 'OK: tokens = 1500' }
        },
      },
      env: { listAll: () => [], resolve: () => '' },
    } as any
    return { ctx, dispatched }
  }

  it('dispatches a numeric delta', async () => {
    const { ctx, dispatched } = ctxFor(['incr', 'tokens', '500'])
    const r = await metaHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(dispatched).toEqual([{ tool: 'sys_set_meta', input: { key: 'tokens', delta: 500 } }])
  })

  it('refuses a non-numeric delta without calling the tool', async () => {
    const { ctx, dispatched } = ctxFor(['incr', 'tokens', 'lots'])
    const r = await metaHandler.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('must be a number')
    expect(dispatched).toEqual([])
  })
})
