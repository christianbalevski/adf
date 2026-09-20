import { describe, it, expect } from 'vitest'
import { runJq } from '../../../src/main/tools/shell/commands/jq-wasm-adapter'

/**
 * jq's wasm runs in a worker thread, not on the Electron main thread: filter
 * evaluation is synchronous CPU work, so a heavy filter used to block the
 * event loop — which is exactly what the shell's AbortController timeout needs
 * in order to fire. Parity, a real timeout kill, and abort support.
 */

describe('runJq worker execution', () => {
  it('produces correct output (parity with direct execution)', async () => {
    const r = await runJq('{"a":[1,2,3]}', '.a | add', [])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('6')
  })

  it('passes CLI flags through and preserves jq exit codes', async () => {
    const raw = await runJq('{"a":"x"}', '.a', ['-r'])
    expect(raw.stdout).toBe('x')
    // -e exits 1 when the last output is false/null, with output still present.
    const e = await runJq('{"a":null}', '.a', ['-e'])
    expect(e.exitCode).toBe(1)
    expect(e.stdout.trim()).toBe('null')
  })

  it('reports a filter error without throwing', async () => {
    const r = await runJq('{}', '.[', [])
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
  })

  it('times out and kills a runaway filter (exit 124)', async () => {
    const start = Date.now()
    const r = await runJq('null', '[range(0;100000000)] | add', ['-n'], { timeoutMs: 500 })
    const elapsed = Date.now() - start
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('timed out')
    expect(elapsed).toBeLessThan(5000) // killed near the cap, not run to completion
  }, 20000)

  it('honors an already-aborted signal (exit 130)', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runJq('{"a":1}', '.a', [], { signal: ac.signal })
    expect(r.exitCode).toBe(130)
    expect(r.stderr).toContain('aborted')
  })

  it('does not block the event loop while a heavy filter runs', async () => {
    let max = 0
    let last = Date.now()
    const t = setInterval(() => { const n = Date.now(); max = Math.max(max, n - last - 10); last = n }, 10)
    await runJq('null', '[range(0;1500000)] | map(.*3) | add', ['-n'])
    clearInterval(t)
    max = Math.max(max, Date.now() - last - 10)
    expect(max).toBeLessThan(500)
  }, 30000)

  it('runs concurrent filters without cross-talk', async () => {
    const [a, b] = await Promise.all([
      runJq('[3,1,2]', 'sort', ['-c']),
      runJq('{"k":"v"}', '.k', ['-r']),
    ])
    expect(a.stdout.trim()).toBe('[1,2,3]')
    expect(b.stdout).toBe('v')
  })
})
