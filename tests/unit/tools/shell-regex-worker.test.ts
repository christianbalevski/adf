import { describe, it, expect, vi } from 'vitest'
import { mayBacktrack, OFFLOAD_MIN_BYTES } from '../../../src/main/tools/shell/commands/regex-worker'

/**
 * grep/sed compile AGENT-SUPPLIED patterns into JS RegExp. Matching is
 * synchronous and unbounded, so `(a+)+$` against a long non-matching line used
 * to freeze the whole process — past the shell's execution_timeout_ms, which
 * cannot fire while the event loop is held. Matching now runs in a worker with
 * a hard kill whenever the pattern can backtrack or the input is large.
 */

async function getHandler(mod: string, name: string) {
  const handlers = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = handlers[Object.keys(handlers).find(k => k.endsWith('Handlers'))!]
  return list.find((h: any) => h.name === name)!
}

function ctxOf(o: { args?: string[]; flags?: any; stdin?: string; timeoutMs?: number }) {
  return {
    stdin: o.stdin ?? '', args: o.args ?? [], flags: o.flags ?? {}, rawArgs: o.args ?? [],
    config: o.timeoutMs ? { limits: { execution_timeout_ms: o.timeoutMs } } : {},
    workspace: { listFiles: () => [] },
    toolRegistry: { executeTool: vi.fn(async () => ({ content: '{}', isError: false })) },
    env: {},
  } as any
}

/** Max event-loop stall observed while `fn` runs. The tail gap matters most:
 *  an awaited promise resumes in a microtask, before the timer phase. */
async function loopDelay(fn: () => Promise<unknown>): Promise<{ max: number; result: unknown }> {
  let max = 0
  let last = Date.now()
  const t = setInterval(() => {
    const now = Date.now()
    max = Math.max(max, now - last - 10)
    last = now
  }, 10)
  const result = await fn()
  clearInterval(t)
  return { max: Math.max(max, Date.now() - last - 10), result }
}

const EVIL = '(a+)+$'
const EVIL_INPUT = 'a'.repeat(40) + '!'

describe('mayBacktrack', () => {
  it('flags nested quantifiers and backreferences', () => {
    expect(mayBacktrack('(a+)+$')).toBe(true)
    expect(mayBacktrack('(a|aa)*b')).toBe(true)
    expect(mayBacktrack('(?:\\d+|x)+')).toBe(true)
    expect(mayBacktrack('(\\w)\\1')).toBe(true)
  })

  it('leaves ordinary patterns inline', () => {
    expect(mayBacktrack('[0-9]+')).toBe(false)
    expect(mayBacktrack('^foo.*bar$')).toBe(false)
    expect(mayBacktrack('(cat|dog)s?')).toBe(false)
    expect(mayBacktrack('[(+*]+')).toBe(false) // quantifiers inside a class
  })
})

describe('grep ReDoS containment', () => {
  it('times out instead of freezing the process', async () => {
    const grep = await getHandler('text', 'grep')
    const start = Date.now()
    const { max, result } = await loopDelay(() =>
      grep.execute(ctxOf({ args: [EVIL], stdin: EVIL_INPUT + '\n', timeoutMs: 1000 }))
    )
    const elapsed = Date.now() - start
    const r = result as { exit_code: number; stderr: string }
    expect(r.exit_code).toBe(124)
    expect(r.stderr).toContain('timed out')
    expect(elapsed).toBeLessThan(6000)
    // The whole point: the main thread stayed responsive throughout.
    expect(max).toBeLessThan(500)
  }, 20000)

  it('aborts when the shell is cancelled', async () => {
    const grep = await getHandler('text', 'grep')
    const ac = new AbortController()
    const ctx = ctxOf({ args: [EVIL], stdin: EVIL_INPUT + '\n', timeoutMs: 60_000 })
    ctx.signal = ac.signal
    setTimeout(() => ac.abort(), 200)
    const r = await grep.execute(ctx)
    expect(r.exit_code).toBe(130)
    expect(r.stderr).toContain('aborted')
  }, 20000)
})

describe('sed ReDoS containment', () => {
  it('times out instead of freezing the process', async () => {
    const sed = await getHandler('text', 'sed')
    const { max, result } = await loopDelay(() =>
      sed.execute(ctxOf({ args: [`s/${EVIL}/x/`], stdin: EVIL_INPUT, timeoutMs: 1000 }))
    )
    const r = result as { exit_code: number; stderr: string }
    expect(r.exit_code).toBe(124)
    expect(r.stderr).toContain('timed out')
    expect(max).toBeLessThan(500)
  }, 20000)
})

describe('off-thread parity', () => {
  it('grep matches identically through the worker (risky pattern)', async () => {
    const grep = await getHandler('text', 'grep')
    // Risky by structure but linear on this input → routed off-thread, fast.
    const r = await grep.execute(ctxOf({ args: ['(ab+)+'], flags: { n: true }, stdin: 'x\nabb\nzz\nab\n' }))
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('2:abb\n4:ab')
  })

  it('grep -o pieces survive the worker hop', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['(ab+)+'], flags: { o: true }, stdin: 'zabbzabz\n' }))
    expect(r.stdout).toBe('abb\nab')
  })

  it('grep -v/-c/-m behave the same off-thread', async () => {
    const grep = await getHandler('text', 'grep')
    const inv = await grep.execute(ctxOf({ args: ['(ab+)+'], flags: { v: true }, stdin: 'x\nabb\nzz\n' }))
    expect(inv.stdout).toBe('x\nzz')
    const cnt = await grep.execute(ctxOf({ args: ['(ab+)+'], flags: { c: true }, stdin: 'abb\nab\nzz\n' }))
    expect(cnt.stdout).toBe('2')
    const max = await grep.execute(ctxOf({ args: ['(ab+)+'], flags: { m: '1' }, stdin: 'abb\nab\n' }))
    expect(max.stdout).toBe('abb')
  })

  it('large inputs go off-thread and still match', async () => {
    const grep = await getHandler('text', 'grep')
    const filler = ('nope\n').repeat(Math.ceil(OFFLOAD_MIN_BYTES / 5))
    const r = await grep.execute(ctxOf({ args: ['needle'], stdin: filler + 'a needle here\n' }))
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('a needle here')
  })

  it('sed substitutes identically through the worker (backrefs, &, g)', async () => {
    const sed = await getHandler('text', 'sed')
    const inline = await sed.execute(ctxOf({ args: ['s/(a+)+(b)/[&:\\2]/g'], stdin: 'xaabyaab' }))
    expect(inline.stdout).toBe('x[aab:b]y[aab:b]')
  })

  it('sed handles a zero-width global match like String.replace', async () => {
    const sed = await getHandler('text', 'sed')
    // (x*)* is risky → off-thread; empty matches must advance, not loop.
    const r = await sed.execute(ctxOf({ args: ['s/(x*)*/-/g'], stdin: 'ab' }))
    const expected = 'ab'.replace(/(x*)*/g, '-')
    expect(r.stdout).toBe(expected)
  })
})
