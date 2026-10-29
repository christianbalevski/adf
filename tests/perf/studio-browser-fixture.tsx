import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MarkdownEntry } from '@studio/entry'
import { renderMarkdownToSafeHtml } from '@studio/markdown'
import '@studio/styles'

declare const STUDIO_BASELINE: boolean
const delay = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: values.length, totalMs: values.reduce((a, b) => a + b, 0), medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] }
}
function mount() {
  const host = document.createElement('div')
  host.style.cssText = 'width:720px;font:14px/20px Arial'
  document.body.append(host)
  const root = createRoot(host)
  const update = (content: string) => flushSync(() => root.render(<MarkdownEntry content={content} />))
  update('')
  return { host, update, content: () => host.firstElementChild as HTMLElement, close: () => { root.unmount(); host.remove() } }
}
function canonical(source: string): string {
  const div = document.createElement('div')
  div.innerHTML = renderMarkdownToSafeHtml(source)
  return div.innerHTML
}

async function correctness() {
  const fixtures = [
    '# Heading\n\nFirst **bold** paragraph.\n\n## More\n\nA [link](https://example.com) and `code`.',
    '- first\n\n- second\n  - nested\n\n    continuation\n\nAfter.',
    '- first\n\n  continuation\n\n  ```unknown\n  code\n  ```\n\n- second\n\nAfter.',
    '# Title\r\n\r\nText\r\n\r\nNext.',
    '| left | right |\n| --- | --- |\n| one | two |\n\nAfter.',
    '> quoted\n>\n> another **line**\n\nOutside.',
    'Intro\n\n```unknown\n<div>literal</div>\n\n``` not a close\n\nmore code\n```\n\nAfter.',
    'Intro\n\n<div>\n\none\n\ntwo\n</div>\n\nAfter.',
    'See [the docs][ref].\n\nOther paragraph.\n\n[ref]: https://example.com\n\nAfter.',
    'See [link][foo bar].\n\nOther.\n\n[foo\nbar]: https://example.com\n\nAfter.',
    'See [docs][ref].\n\n> [ref]: https://example.com\n\nAfter.',
    '<img width="16" height="16" src="x" onerror="alert(1)"><script>alert(1)</script>\n\n<style>body{display:none}</style>Safe.',
  ]
  let boundaries = 0
  for (const source of fixtures) {
    const view = mount()
    for (let end = 1; end <= source.length; end++) {
      view.update(source.slice(0, end))
      // Baseline preserves its historic transient behavior; the new path is
      // checked against a canonical parse at every single-character boundary.
      if (!STUDIO_BASELINE) check(view.content().innerHTML === canonical(source.slice(0, end)), `stream mismatch: ${JSON.stringify(source.slice(0, end))}`)
      boundaries++
    }
    await delay(240)
    check(view.content().innerHTML === canonical(source), 'canonical settle mismatch')
    check(!view.content().querySelector('script,style,[onerror]'), 'unsafe Markdown survived sanitization')
    // Exact direct-child structure keeps :first-child/:last-child and margin
    // collapse behavior, not merely the same visible text inside wrappers.
    const reference = document.createElement('div')
    reference.className = view.content().className
    reference.style.width = '720px'
    reference.innerHTML = canonical(source)
    view.host.append(reference)
    check(Math.abs(reference.getBoundingClientRect().height - view.content().getBoundingClientRect().height) < 1, `Markdown CSS layout changed (${reference.getBoundingClientRect().height} vs ${view.content().getBoundingClientRect().height}): ${JSON.stringify(source)}`)
    reference.remove()
    view.close()
  }

  const view = mount()
  view.update('Stable paragraph.\n\nGrowing')
  view.update('Stable paragraph.\n\nGrowing tail')
  const first = view.content().firstChild!
  const range = document.createRange()
  range.selectNodeContents(first)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  for (const suffix of [' one', ' one two', ' one two three']) view.update('Stable paragraph.\n\nGrowing tail' + suffix)
  if (!STUDIO_BASELINE) {
    check(view.content().firstChild === first, 'settled prefix DOM was replaced')
    check(selection.toString() === 'Stable paragraph.', 'selection in settled prefix was lost')
  }
  await delay(240)
  if (!STUDIO_BASELINE) check(view.content().firstChild === first && selection.toString() === 'Stable paragraph.', 'canonical settle replaced unchanged selected nodes')
  selection.removeAllRanges()
  view.update('Replacement')
  await delay(240)
  check(view.content().innerHTML === canonical('Replacement'), 'rewrite did not replace old content')
  view.update('Replacement\n\nAfter pause')
  await delay(240)
  check(view.content().innerHTML === canonical('Replacement\n\nAfter pause'), 'append after settle failed')
  view.close()

  // Loading a previously unseen grammar triggers the component's real hook.
  const highlighted = mount()
  const python = '```python\ndef new_value():\n    return 12\n```'
  highlighted.update(python)
  for (let attempt = 0; attempt < 200 && !highlighted.content().querySelector('.shiki'); attempt++) await delay(10)
  check(highlighted.content().querySelector('.shiki'), 'grammar load did not refresh mounted Markdown')
  check(highlighted.content().innerHTML === canonical(python), 'highlight-version refresh differs from canonical output')
  highlighted.close()
  return { streamedBoundaries: boundaries, fixtures: fixtures.length, selectionAndCss: !STUDIO_BASELINE, grammarRefresh: true }
}

function documentOfSize(bytes: number) {
  const paragraph = '## Review section\n\nA paragraph with **bold text**, a [safe link](https://example.com), and `inline code` that explains the next step.\n\n'
  return paragraph.repeat(Math.ceil(bytes / paragraph.length)).slice(0, bytes)
}
async function stream(bytes: number) {
  const view = mount()
  const source = documentOfSize(bytes)
  const samples: number[] = []
  for (let end = 100; end <= source.length; end += 100) {
    const start = performance.now()
    view.update(source.slice(0, end))
    void view.content().offsetHeight
    samples.push(performance.now() - start)
  }
  await delay(240)
  check(view.content().innerHTML === canonical(source), 'stream final output mismatch')
  view.close()
  return { bytes, deltaBytes: 100, ...stats(samples) }
}
async function highlighting(bytes: number) {
  const line = 'export function selectValue(input: Record<string, unknown>): string { return JSON.stringify(input.value ?? "empty") }\n'
  const source = '```typescript\n' + line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes) + '\n```'
  for (let i = 0; i < 200; i++) {
    if (renderMarkdownToSafeHtml(source).includes('class="shiki')) break
    await delay(10)
  }
  const expected = renderMarkdownToSafeHtml(source)
  check(expected.includes('class="shiki'), 'TypeScript grammar never loaded')
  for (let i = 0; i < 5; i++) renderMarkdownToSafeHtml(source)
  const samples: number[] = []
  for (let i = 0; i < 20; i++) {
    const start = performance.now()
    const actual = renderMarkdownToSafeHtml(source)
    samples.push(performance.now() - start)
    check(actual === expected, 'cached highlight changed output')
  }
  return { bytes, ...stats(samples) }
}

Object.assign(window, { runStudioBench: async () => {
  const checks = await correctness()
  await stream(2000)
  const streams = []
  for (const bytes of [2000, 20000, 100000]) for (let trial = 0; trial < 3; trial++) streams.push({ trial, ...await stream(bytes) })
  const code = []
  for (const bytes of [5000, 20000, 39000]) code.push(await highlighting(bytes))
  // The stable-node/selection assertions are the primary regression gates.
  // A generous warm-cache ceiling additionally catches accidental re-highlighting
  // without relying on sub-millisecond timers or desktop-specific speed ratios.
  if (!STUDIO_BASELINE) check(code[2].medianMs < 20, 'warm 39KB highlight cache regressed (>20ms median)')
  return { baseline: STUDIO_BASELINE, correctness: checks, streaming: streams, highlighting: code,
    methodology: 'Real production React MarkdownEntry, Chromium DOM, app Markdown CSS. Synchronous100-character updates with forced layout; not user FPS. Three trials/size; grammar warmed before20 highlighting samples. Canonical settle checked outside timing. Profiler optional and disabled by default.' }
} })
