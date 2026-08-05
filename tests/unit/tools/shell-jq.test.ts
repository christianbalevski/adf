import { describe, it, expect } from 'vitest'

/**
 * Golden tests for the jq command handler, asserting real jq 1.8 semantics.
 *
 * Written BEFORE swapping the hand-rolled evaluator (jq-evaluator.ts) for
 * jq-wasm (real jq compiled to WASM). Against the old evaluator the
 * "features the hand-rolled evaluator lacks" describe-block is expected to
 * fail (def, foreach, label/break, @base64/@uri/@sh, multi-document input,
 * -s/-c/-n flags, input). After the swap the whole suite must be green.
 *
 * Error assertions check exit codes only — error message text is
 * implementation-defined and changed by the swap.
 *
 * Pre-swap baseline (2026-08-05, hand-rolled evaluator): 20 pass / 12 fail.
 * Beyond the expected missing-features block, two CORE tests also failed —
 * old-evaluator bugs: @csv did not quote strings ("1,a"), and
 * `try error("x") catch .` yielded null instead of "x".
 */

async function getJqHandler() {
  const { structuredHandlers } = await import(
    '../../../src/main/tools/shell/commands/structured'
  )
  return structuredHandlers.find(h => h.name === 'jq')!
}

async function runJq(opts: {
  expr?: string
  stdin?: string
  flags?: Record<string, string | boolean | string[]>
}) {
  const handler = await getJqHandler()
  const ctx: any = {
    args: opts.expr !== undefined ? [opts.expr] : [],
    flags: opts.flags ?? {},
    stdin: opts.stdin ?? '',
    workspace: {},
    toolRegistry: {},
    config: {},
    env: {},
  }
  return handler.execute(ctx)
}

/** Parse a single-JSON-value stdout regardless of pretty/compact formatting */
function parsed(stdout: string): unknown {
  return JSON.parse(stdout)
}

// ── Core semantics (supported by both implementations) ──

describe('jq core filters', () => {
  it('identity pretty-prints with 2-space indent', async () => {
    const r = await runJq({ expr: '.', stdin: '{"a":1}' })
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('{\n  "a": 1\n}')
  })

  it('field access', async () => {
    const r = await runJq({ expr: '.a', stdin: '{"a":42}' })
    expect(r.stdout).toBe('42')
  })

  it('array index and iteration (multiple outputs newline-joined)', async () => {
    const r = await runJq({ expr: '.[0]', stdin: '[10,20]' })
    expect(r.stdout).toBe('10')
    const r2 = await runJq({ expr: '.[]', stdin: '[1,2,3]' })
    expect(r2.stdout).toBe('1\n2\n3')
  })

  it('pipes and comma', async () => {
    const r = await runJq({ expr: '.a | .b', stdin: '{"a":{"b":7}}' })
    expect(r.stdout).toBe('7')
    const r2 = await runJq({ expr: '.a, .b', stdin: '{"a":1,"b":2}' })
    expect(r2.stdout).toBe('1\n2')
  })

  it('object and array construction', async () => {
    const r = await runJq({ expr: '{x: .a}', stdin: '{"a":1}' })
    expect(parsed(r.stdout)).toEqual({ x: 1 })
    const r2 = await runJq({ expr: '[.a, .b]', stdin: '{"a":1,"b":2}' })
    expect(parsed(r2.stdout)).toEqual([1, 2])
  })

  it('alternative operator //', async () => {
    const r = await runJq({ expr: '.missing // "fallback"', stdin: '{}' })
    expect(parsed(r.stdout)).toBe('fallback')
  })

  it('arithmetic and comparison', async () => {
    const r = await runJq({ expr: '.a + 1 * 2', stdin: '{"a":1}' })
    expect(r.stdout).toBe('3')
    const r2 = await runJq({ expr: '.a > 1', stdin: '{"a":2}' })
    expect(r2.stdout).toBe('true')
  })

  it('select and map', async () => {
    const r = await runJq({ expr: '[.[] | select(. > 1)]', stdin: '[1,2,3]' })
    expect(parsed(r.stdout)).toEqual([2, 3])
    const r2 = await runJq({ expr: 'map(. * 2)', stdin: '[1,2]' })
    expect(parsed(r2.stdout)).toEqual([2, 4])
  })

  it('keys, length, has, del', async () => {
    expect(parsed((await runJq({ expr: 'keys', stdin: '{"b":1,"a":2}' })).stdout)).toEqual(['a', 'b'])
    expect((await runJq({ expr: 'length', stdin: '[1,2,3]' })).stdout).toBe('3')
    expect((await runJq({ expr: 'has("a")', stdin: '{"a":1}' })).stdout).toBe('true')
    expect(parsed((await runJq({ expr: 'del(.a)', stdin: '{"a":1,"b":2}' })).stdout)).toEqual({ b: 2 })
  })

  it('sort_by, group_by, unique_by', async () => {
    expect(parsed((await runJq({ expr: 'sort_by(.a) | map(.a)', stdin: '[{"a":2},{"a":1}]' })).stdout)).toEqual([1, 2])
    expect((await runJq({ expr: 'group_by(.k) | length', stdin: '[{"k":1},{"k":1},{"k":2}]' })).stdout).toBe('2')
    expect(parsed((await runJq({ expr: 'unique_by(.k) | map(.k)', stdin: '[{"k":1},{"k":1},{"k":2}]' })).stdout)).toEqual([1, 2])
  })

  it('to_entries / from_entries roundtrip', async () => {
    expect(parsed((await runJq({ expr: 'to_entries', stdin: '{"a":1}' })).stdout)).toEqual([{ key: 'a', value: 1 }])
    expect(parsed((await runJq({ expr: 'to_entries | from_entries', stdin: '{"a":1,"b":2}' })).stdout)).toEqual({ a: 1, b: 2 })
  })

  it('@csv and @tsv', async () => {
    const r = await runJq({ expr: '@csv', stdin: '[1,"a"]', flags: { r: true } })
    expect(r.stdout).toBe('1,"a"')
    const r2 = await runJq({ expr: '@tsv', stdin: '[1,2]', flags: { r: true } })
    expect(r2.stdout).toBe('1\t2')
  })

  it('if-then-else, try-catch, reduce', async () => {
    expect(parsed((await runJq({ expr: 'if . > 1 then "big" else "small" end', stdin: '2' })).stdout)).toBe('big')
    expect(parsed((await runJq({ expr: 'try error("x") catch .', stdin: 'null' })).stdout)).toBe('x')
    expect((await runJq({ expr: 'reduce .[] as $x (0; . + $x)', stdin: '[1,2,3]' })).stdout).toBe('6')
  })

  it('variable bindings and recursive descent', async () => {
    expect((await runJq({ expr: '. as $x | $x + 1', stdin: '5' })).stdout).toBe('6')
    const r = await runJq({ expr: '[.. | numbers]', stdin: '{"a":{"b":1},"c":2}' })
    expect(parsed(r.stdout)).toEqual([1, 2])
  })

  it('test, split, join, string functions', async () => {
    expect((await runJq({ expr: 'test("b")', stdin: '"abc"' })).stdout).toBe('true')
    expect(parsed((await runJq({ expr: 'split(",") | join("-")', stdin: '"a,b"' })).stdout)).toBe('a-b')
    expect((await runJq({ expr: 'startswith("ab")', stdin: '"abc"' })).stdout).toBe('true')
  })

  it('limit', async () => {
    const r = await runJq({ expr: '[limit(2; .[])]', stdin: '[1,2,3,4]' })
    expect(parsed(r.stdout)).toEqual([1, 2])
  })

  it('string output: quoted by default, raw with -r', async () => {
    expect((await runJq({ expr: '.s', stdin: '{"s":"hi"}' })).stdout).toBe('"hi"')
    expect((await runJq({ expr: '.s', stdin: '{"s":"hi"}', flags: { r: true } })).stdout).toBe('hi')
  })
})

// ── Errors (exit codes only, not message text) ──

describe('jq errors', () => {
  it('invalid JSON input → nonzero exit', async () => {
    const r = await runJq({ expr: '.', stdin: 'not json' })
    expect(r.exit_code).not.toBe(0)
  })

  it('invalid filter → nonzero exit', async () => {
    const r = await runJq({ expr: '(', stdin: '{}' })
    expect(r.exit_code).not.toBe(0)
  })

  it('missing expression → nonzero exit', async () => {
    const r = await runJq({ stdin: '{}' })
    expect(r.exit_code).not.toBe(0)
  })

  it('empty stdin without -n → nonzero exit', async () => {
    const r = await runJq({ expr: '.' })
    expect(r.exit_code).not.toBe(0)
  })
})

// ── Features the hand-rolled evaluator lacks (expected failures pre-swap) ──

describe('jq real-1.8 features (post-swap requirements)', () => {
  it('user-defined functions (def)', async () => {
    const r = await runJq({ expr: 'def f: . + 1; f', stdin: '3' })
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('4')
  })

  it('foreach', async () => {
    const r = await runJq({ expr: '[foreach .[] as $x (0; . + $x)]', stdin: '[1,2,3]' })
    expect(parsed(r.stdout)).toEqual([1, 3, 6])
  })

  it('label / break', async () => {
    const r = await runJq({ expr: '[label $out | 1, break $out, 2]', stdin: 'null' })
    expect(parsed(r.stdout)).toEqual([1])
  })

  it('@base64 / @base64d roundtrip', async () => {
    const r = await runJq({ expr: '@base64', stdin: '"hi"', flags: { r: true } })
    expect(r.stdout).toBe('aGk=')
    const r2 = await runJq({ expr: '@base64 | @base64d', stdin: '"hi"', flags: { r: true } })
    expect(r2.stdout).toBe('hi')
  })

  it('@uri and @sh', async () => {
    expect((await runJq({ expr: '@uri', stdin: '"a b"', flags: { r: true } })).stdout).toBe('a%20b')
    expect((await runJq({ expr: '@sh', stdin: '"a b"', flags: { r: true } })).stdout).toBe("'a b'")
  })

  it('multi-document (NDJSON) stdin', async () => {
    const r = await runJq({ expr: '.n', stdin: '{"n":1}\n{"n":2}\n' })
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('1\n2')
  })

  it('-s slurp', async () => {
    const r = await runJq({ expr: 'map(.n) | add', stdin: '{"n":1}\n{"n":2}\n', flags: { s: true } })
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('3')
  })

  it('-c compact output', async () => {
    const r = await runJq({ expr: '.', stdin: '{"a":[1,2]}', flags: { c: true } })
    expect(r.stdout).toBe('{"a":[1,2]}')
  })

  it('-n null input without stdin', async () => {
    const r = await runJq({ expr: '1 + 1', flags: { n: true } })
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('2')
  })

  it('input reads next document', async () => {
    const r = await runJq({ expr: '[., input]', stdin: '1\n2\n' })
    expect(r.exit_code).toBe(0)
    expect(parsed(r.stdout)).toEqual([1, 2])
  })

  it('-j joins output without newlines', async () => {
    const r = await runJq({ expr: '.[]', stdin: '["a","b"]', flags: { j: true } })
    expect(r.stdout).toBe('ab')
  })
})
