import { describe, it, expect } from 'vitest'
import { htmlToPlainText, sanitizeTelegramHtml } from '../../../src/main/adapters/shared/html-content'

describe('htmlToPlainText', () => {
  it('converts structural HTML to readable text', () => {
    const text = htmlToPlainText('<h1>Title</h1><p>Hello <b>world</b></p><ul><li>one</li><li>two</li></ul>')
    expect(text).toContain('Title')
    expect(text).toContain('Hello world')
    expect(text).toContain('one')
    expect(text).toContain('two')
    expect(text).not.toContain('<')
  })

  it('keeps link targets when they differ from the text', () => {
    const text = htmlToPlainText('<a href="https://example.com">docs</a>')
    expect(text).toContain('docs')
    expect(text).toContain('https://example.com')
  })
})

describe('sanitizeTelegramHtml', () => {
  it('keeps the Telegram-allowed inline subset and strips attributes', () => {
    const out = sanitizeTelegramHtml('<b class="x">bold</b> <i>it</i> <code>c()</code>')
    expect(out).toBe('<b>bold</b> <i>it</i> <code>c()</code>')
  })

  it('converts block structure to newlines, bullets, and bold headings', () => {
    const out = sanitizeTelegramHtml('<h2>Head</h2><p>para</p><ul><li>one</li><li>two</li></ul>')
    expect(out).toContain('<b>Head</b>')
    expect(out).toContain('• one')
    expect(out).toContain('• two')
    expect(out).not.toContain('<p>')
    expect(out).not.toContain('<li>')
  })

  it('preserves a[href] and drops anchors without a target', () => {
    const out = sanitizeTelegramHtml('<a href="https://example.com">go</a> <a>nope</a>')
    expect(out).toContain('<a href="https://example.com">go</a>')
    expect(out).not.toContain('<a>nope')
  })

  it('removes script/style subtrees and unknown tags entirely', () => {
    const out = sanitizeTelegramHtml('<style>.x{}</style><script>evil()</script><span>keep text</span>')
    expect(out).toBe('keep text')
  })
})
