import { describe, it, expect } from 'vitest'
import { parseLoopToDisplay, parseLoopWithToolPairs } from '../../../src/shared/utils/loop-parser'
import type { LoopEntry } from '../../../src/shared/types/adf-v02.types'

const IMG_URL = 'data:image/png;base64,aGVsbG8='

function userEntry(blocks: LoopEntry['content_json'], seq = 1): LoopEntry {
  return { seq, role: 'user', content_json: blocks, created_at: 1000 }
}

describe('loop-parser media restore', () => {
  it('carries image_url blocks through to user entry metadata', () => {
    const entries = [
      userEntry([
        { type: 'text', text: 'Please review the attached media.' },
        { type: 'image_url', image_url: { url: IMG_URL } }
      ])
    ]

    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const display = parse(entries)
      expect(display).toHaveLength(1)
      expect(display[0].type).toBe('user')
      expect(display[0].content).toBe('Please review the attached media.')
      expect(display[0].metadata?.imagePreviewUrls).toEqual([IMG_URL])
    }
  })

  it('collects multiple images alongside a typed message', () => {
    const entries = [
      userEntry([
        { type: 'text', text: 'compare these' },
        { type: 'image_url', image_url: { url: IMG_URL } },
        { type: 'image_url', image_url: { url: `${IMG_URL}2` } }
      ])
    ]
    const display = parseLoopToDisplay(entries)
    expect(display[0].metadata?.imagePreviewUrls).toEqual([IMG_URL, `${IMG_URL}2`])
  })

  it('omits imagePreviewUrls when there are no media blocks', () => {
    const display = parseLoopToDisplay([userEntry([{ type: 'text', text: 'hi' }])])
    expect(display[0].metadata).not.toHaveProperty('imagePreviewUrls')
  })

  it('does not attach media metadata to trigger entries', () => {
    const display = parseLoopToDisplay([
      userEntry([
        { type: 'text', text: 'Go.' },
        { type: 'image_url', image_url: { url: IMG_URL } }
      ])
    ])
    expect(display[0].type).toBe('trigger')
    expect(display[0].metadata).not.toHaveProperty('imagePreviewUrls')
  })
})
