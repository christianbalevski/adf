import { describe, expect, it } from 'vitest'
import { servesHttp } from '../../../src/shared/utils/serving'

describe('servesHttp', () => {
  it('a public or shared page, or API routes', () => {
    expect(servesHttp(undefined)).toBe(false)
    expect(servesHttp({} as never)).toBe(false)
    expect(servesHttp({ public: { enabled: true } } as never)).toBe(true)
    expect(servesHttp({ public: { enabled: false }, shared: { enabled: true } } as never)).toBe(true)
    expect(servesHttp({ api: [{ method: 'GET', path: '/x' }] } as never)).toBe(true)
    expect(servesHttp({ public: { enabled: false }, api: [] } as never)).toBe(false)
  })
})
