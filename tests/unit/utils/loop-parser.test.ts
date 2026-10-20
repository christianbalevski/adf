import { describe, it, expect } from 'vitest'
import { formatTurnErrorRow, parseLoopToDisplay, parseLoopWithToolPairs, parseTurnErrorRow } from '../../../src/shared/utils/loop-parser'
import { persistedErrorDetails } from '../../../src/main/runtime/agent-executor'
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

describe('loop-parser turn error marker', () => {
  it('reads a persisted turn error back as an error display entry in both parsers', () => {
    const entries = [userEntry([{ type: 'text', text: '[Turn error] 400 Bad Request: model not supported' }], 7)]
    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const out = parse(entries)
      expect(out).toHaveLength(1)
      expect(out[0].type).toBe('error')
      expect(out[0].content).toBe('400 Bad Request: model not supported')
      expect(out[0].metadata?.seq).toBe(7)
    }
  })

  it('does not treat ordinary user text as a turn error', () => {
    const out = parseLoopToDisplay([userEntry([{ type: 'text', text: 'Turn error handling looks fine' }])])
    expect(out[0].type).toBe('user')
  })

  it('keeps the error details across a reload', () => {
    const details = JSON.stringify({ statusCode: 400, responseBody: '{"error":"bad"}' }, null, 2)
    const text = formatTurnErrorRow('400 Bad Request', details)
    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const out = parse([userEntry([{ type: 'text', text }], 9)])
      expect(out[0].type).toBe('error')
      expect(out[0].content).toBe('400 Bad Request')
      expect(out[0].metadata?.details).toBe(details)
    }
    expect(parseTurnErrorRow(formatTurnErrorRow('no details'))).toEqual({ message: 'no details' })
    expect(parseTurnErrorRow('plain text')).toBeNull()
  })
})

describe('persisted error details', () => {
  it('keeps status, code and a bounded body, and nothing else', () => {
    const error = Object.assign(new Error('boom'), { statusCode: 529, code: 'overloaded', responseBody: 'x'.repeat(5000), responseHeaders: { a: 'b' } })
    const parsed = JSON.parse(persistedErrorDetails(error)!)
    expect(parsed.statusCode).toBe(529)
    expect(parsed.code).toBe('overloaded')
    expect(parsed.responseBody.length).toBeLessThanOrEqual(1501)
    expect(parsed.responseHeaders).toBeUndefined()
    expect(parsed.stack).toBeUndefined()
    expect(persistedErrorDetails(new Error('plain'))).toBeUndefined()
    expect(persistedErrorDetails('string error')).toBeUndefined()
  })
})
