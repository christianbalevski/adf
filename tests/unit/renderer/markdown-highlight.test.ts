import { describe, it, expect, vi } from 'vitest'
import { renderMarkdownToSafeHtml, createIncrementalMarkdownRenderer } from '../../../src/renderer/utils/markdown'

/**
 * Shiki highlighting in the shared markdown renderer. Rendering is synchronous:
 * a block is plain until its grammar has loaded, then highlighted. No DOM here,
 * so DOMPurify is stubbed to pass markup through; the sanitizer is not under test.
 */
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }))

const TS_BLOCK = '```ts\nconst x: number = 1\n```\n'

async function untilHighlighted(source: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const html = renderMarkdownToSafeHtml(source)
    if (html.includes('class="shiki')) return html
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('grammar never loaded')
}

describe('markdown code highlighting', () => {
  it('renders plain first, then dual-theme Shiki markup once the grammar loads', async () => {
    const first = renderMarkdownToSafeHtml(TS_BLOCK)
    expect(first).toContain('<pre><code class="language-ts">')

    const html = await untilHighlighted(TS_BLOCK)
    expect(html).toContain('shiki-themes github-light github-dark-dimmed')
    expect(html).toContain('--shiki-light:')
    expect(html).toContain('--shiki-dark:')
    expect(html).not.toMatch(/adf-code-[0-9a-f]{32}/)
  })

  it('leaves an unclosed (still streaming) fence plain', async () => {
    await untilHighlighted(TS_BLOCK)
    const html = renderMarkdownToSafeHtml('```ts\nconst x = 1\n')
    expect(html).not.toContain('shiki')
  })

  it('leaves unknown languages plain', () => {
    expect(renderMarkdownToSafeHtml('```brainfuck\n+++\n```\n')).toContain('language-brainfuck')
  })

  it('does not splice into model text that looks like a placeholder', async () => {
    await untilHighlighted(TS_BLOCK)
    const forged = '<div>adf-code-00000000000000000000000000000000-0</div>\n\n' + TS_BLOCK
    const html = renderMarkdownToSafeHtml(forged)
    expect(html).toContain('adf-code-00000000000000000000000000000000-0')
    expect(html.match(/class="shiki/g)).toHaveLength(1)
  })

  it('incremental renderer matches the whole-document render', async () => {
    await untilHighlighted(TS_BLOCK)
    const doc = 'Intro paragraph.\n\n' + TS_BLOCK + '\nAfter.\n'
    const render = createIncrementalMarkdownRenderer()
    let out = ''
    for (let i = 1; i <= doc.length; i += 7) out = render(doc.slice(0, i))
    out = render(doc)
    expect(out).toBe(renderMarkdownToSafeHtml(doc))
  })
})
