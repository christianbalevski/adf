import { describe, it, expect } from 'vitest'
import { runApplet } from '../../../src/main/tools/shell/commands/wasi-applet-adapter'

/**
 * #16 coreutils WASM runs in a worker thread: correctness parity, a real
 * timeout kill (the whole point — sync WASM on the main thread could not be
 * preempted), and abort-signal support.
 */

describe('runApplet worker execution', () => {
  it('produces correct output (parity with direct execution)', async () => {
    const r = await runApplet('sort', [], 'banana\napple\ncherry\n', {})
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('apple\nbanana\ncherry\n')
  })

  it('mounts file args from the in-memory FS', async () => {
    const r = await runApplet('wc', ['-c', 'b.bin'], '', { 'b.bin': new Uint8Array([0, 1, 2, 3, 4]) })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim().startsWith('5')).toBe(true)
  })

  it('times out and kills a runaway applet (exit 124)', async () => {
    // seq to a huge number would run far longer than the cap; the worker is
    // terminated instead of blocking indefinitely.
    const start = Date.now()
    const r = await runApplet('seq', ['1', '100000000'], '', {}, { timeoutMs: 500 })
    const elapsed = Date.now() - start
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('timed out')
    expect(elapsed).toBeLessThan(2000) // killed near the cap, not run to completion
  })

  it('honors an already-aborted signal (exit 130)', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runApplet('sort', [], 'x\n', {}, { signal: ac.signal })
    expect(r.exitCode).toBe(130)
    expect(r.stderr).toContain('aborted')
  })

  it('runs concurrent applets without cross-talk', async () => {
    const [a, b] = await Promise.all([
      runApplet('sort', [], 'c\na\nb\n', {}),
      runApplet('wc', ['-l'], 'x\ny\nz\n', {}),
    ])
    expect(a.stdout).toBe('a\nb\nc\n')
    expect(b.stdout.trim().startsWith('3')).toBe(true)
  })
})
