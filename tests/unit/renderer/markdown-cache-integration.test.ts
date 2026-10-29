import { describe, expect, it, vi } from 'vitest'

const { codeToHtml, sanitize } = vi.hoisted(() => ({
  codeToHtml: vi.fn((source: string, options: { lang: string }) => `<pre class="shiki">${options.lang}:${source}</pre>`),
  sanitize: vi.fn((html: string) => html),
}))
vi.mock('dompurify', () => ({ default: { sanitize } }))
vi.mock('shiki/core', () => ({ createHighlighterCore: async () => ({ codeToHtml, loadLanguage: async () => {} }) }))
vi.mock('shiki/engine/javascript', () => ({ createJavaScriptRegexEngine: () => ({}) }))
import { renderMarkdownToSafeHtml } from '../../../src/renderer/utils/markdown'

async function loaded(source: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (renderMarkdownToSafeHtml(source).includes('class="shiki"')) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('grammar did not load')
}

describe('closed code cache integration', () => {
  it('reuses only trusted highlighted output while sanitizing every document', async () => {
    const block = '```ts\nconst value = 1\n```'
    await loaded(block)
    codeToHtml.mockClear()
    sanitize.mockClear()
    const first = renderMarkdownToSafeHtml(block)
    const second = renderMarkdownToSafeHtml(block)
    expect(second).toBe(first)
    expect(codeToHtml).not.toHaveBeenCalled()
    expect(sanitize).toHaveBeenCalledTimes(2)
    const raw = sanitize.mock.calls.map(([html]) => html)
    expect(raw[0]).not.toBe(raw[1]) // Each render has a fresh placeholder nonce.
    expect(raw.every((html) => !html.includes('class="shiki"'))).toBe(true)
    renderMarkdownToSafeHtml('```ts\nconst value = 2\n```')
    expect(codeToHtml).toHaveBeenCalledTimes(1)
  })

  it('invalidates when a grammar/highlight version changes and separates languages', async () => {
    const ts = '```ts\nconst value = 3\n```'
    const js = '```js\nconst value = 3\n```'
    await loaded(ts)
    await loaded(js) // Finishing a new grammar invalidates prior fallback versions.
    codeToHtml.mockClear()
    renderMarkdownToSafeHtml(ts)
    expect(codeToHtml).toHaveBeenCalledTimes(1)
    renderMarkdownToSafeHtml(ts)
    renderMarkdownToSafeHtml(js)
    expect(codeToHtml).toHaveBeenCalledTimes(1)
    expect(renderMarkdownToSafeHtml(ts)).not.toBe(renderMarkdownToSafeHtml(js))
  })
})
