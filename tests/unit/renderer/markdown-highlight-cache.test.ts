import { describe, expect, it } from 'vitest'
import { MarkdownHighlightCache } from '../../../src/renderer/utils/markdown-highlight-cache'

describe('highlight cache byte budget', () => {
  it('counts UTF-16 keys and values, including surrogate pairs', () => {
    const cache = new MarkdownHighlightCache(12)
    cache.set('a', '😀') // 6 bytes
    cache.set('b', '😀') // 6 bytes
    expect(cache.get('a')).toBe('😀')
    cache.set('c', '😀')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('😀')
    expect(cache.get('c')).toBe('😀')
  })

  it('does not retain a large output or evict useful entries for it', () => {
    const cache = new MarkdownHighlightCache(20)
    cache.set('small', 'ok')
    cache.set('large', 'x'.repeat(100))
    expect(cache.get('large')).toBeUndefined()
    expect(cache.get('small')).toBe('ok')
  })

  it('includes long keys in the budget', () => {
    const cache = new MarkdownHighlightCache(20)
    cache.set('x'.repeat(11), '')
    expect(cache.get('x'.repeat(11))).toBeUndefined()
  })

  it('accounts for replacement and invalidation without leaking its budget', () => {
    const cache = new MarkdownHighlightCache(12)
    cache.set('a', '12345')
    cache.set('a', '1')
    cache.set('b', '123')
    expect(cache.get('a')).toBe('1')
    expect(cache.get('b')).toBe('123')
    cache.clear()
    expect(cache.get('a')).toBeUndefined()
    cache.set('c', '12345')
    expect(cache.get('c')).toBe('12345')
  })
})
