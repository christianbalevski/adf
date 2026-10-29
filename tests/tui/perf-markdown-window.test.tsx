// Actual Ink cold mounts and warmed streaming updates, with exact terminal
// output and mounted-node gates. Opt in with ADF_BENCH=1; timings are reported,
// not asserted against a machine-dependent absolute or speedup threshold.
import { describe, expect, it } from 'vitest'
import { displayWidth } from '../../src/main/tui/ui/text'
import { mountMarkdown, prose } from './fixtures/markdown-window'

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

describe.skipIf(!process.env.ADF_BENCH)('measured Markdown render cost', () => {
  for (const paragraphs of [2, 200]) it(`renders complete ${paragraphs}-paragraph answers with bounded visible nodes`, async () => {
    let text = prose(paragraphs)
    const started = performance.now()
    const full = mountMarkdown({ text }, false)
    const fullInitial = await full.ready()
    const fullColdMs = performance.now() - started
    const windowStart = performance.now()
    const windowed = mountMarkdown({ text }, true)
    const windowInitial = await windowed.ready()
    const windowColdMs = performance.now() - windowStart
    try {
      expect(fullInitial).not.toContain('ERROR')
      expect(windowInitial).toBe(fullInitial)
      expect(fullInitial).toContain(`Paragraph ${paragraphs - 1}:`)
      const fullNodes = full.nodes()
      const windowNodes = windowed.nodes()
      if (paragraphs === 200) expect(windowNodes).toBeLessThan(fullNodes / 4)
      const fullMs: number[] = []
      const windowMs: number[] = []
      for (let i = 0; i < 30; i++) {
        text += ` streamed-${i}`
        let fullFrame = ''
        let windowFrame = ''
        const measureFull = async () => {
          const start = performance.now()
          fullFrame = await full.update({ text })
          fullMs.push(performance.now() - start)
        }
        const measureWindow = async () => {
          const start = performance.now()
          windowFrame = await windowed.update({ text })
          windowMs.push(performance.now() - start)
        }
        // Both variants see the same text; alternate which warms Ink's shared
        // wrapping caches first. Flush timings include scheduler overhead.
        if (i % 2) { await measureWindow(); await measureFull() }
        else { await measureFull(); await measureWindow() }
        expect(windowFrame).toBe(fullFrame)
        expect(fullFrame).toContain(`streamed-${i}`)
      }
      process.stderr.write(`[tui markdown bench] ${JSON.stringify({ paragraphs, chars: text.length, updates: 30, fullNodes, windowNodes, fullColdMs, windowColdMs, fullWarmMedianMs: median(fullMs.slice(5)), windowWarmMedianMs: median(windowMs.slice(5)) })}\n`)
    } finally { full.unmount(); windowed.unmount() }
  })
})

const wide = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\uD83C-\uD83E][\uDC00-\uDFFF]/
/** Pre-optimization width path, retained only as the benchmark baseline. */
function legacyWidth(text: string): number {
  let cells = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    cells += wide.test(ch) ? 2 : 1
  }
  return cells
}

describe.skipIf(!process.env.ADF_BENCH)('ASCII width cost', () => {
  it('avoids the legacy per-codepoint scan for ordinary prose', () => {
    const text = prose(200)
    const mixed = text + '中文🙂e\u0301'
    expect(displayWidth(text)).toBe(legacyWidth(text))
    expect(displayWidth(mixed)).toBe(legacyWidth(mixed))
    const baseline: number[] = []
    const optimized: number[] = []
    const time = (fn: (text: string) => number, samples: number[]) => {
      const start = performance.now()
      let cells = 0
      for (let i = 0; i < 50; i++) cells += fn(text)
      samples.push((performance.now() - start) / 50)
      expect(cells).toBe(text.length * 50)
    }
    for (let i = 0; i < 8; i++) {
      if (i % 2) { time(displayWidth, optimized); time(legacyWidth, baseline) }
      else { time(legacyWidth, baseline); time(displayWidth, optimized) }
    }
    const legacyMedianMs = median(baseline.slice(1))
    const asciiMedianMs = median(optimized.slice(1))
    // The margin is deliberately loose: removing tens of thousands of regex
    // calls should remain visible even on a slow/shared CI runner.
    expect(asciiMedianMs).toBeLessThan(legacyMedianMs * 0.8)
    process.stderr.write(`[tui width bench] ${JSON.stringify({ chars: text.length, legacyMedianMs, asciiMedianMs })}\n`)
  })
})
