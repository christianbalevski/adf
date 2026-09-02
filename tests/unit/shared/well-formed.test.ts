import { describe, expect, it } from 'vitest'
import { hasLoneSurrogate, repairStringsDeep, sliceWellFormed, toWellFormed } from '../../../src/shared/utils/well-formed'

const ROCKET = '🚀' // U+1F680 — two UTF-16 code units
const HIGH = ROCKET[0]
const LOW = ROCKET[1]

describe('well-formed', () => {
  it('detects lone surrogates', () => {
    expect(hasLoneSurrogate('plain ' + ROCKET)).toBe(false)
    expect(hasLoneSurrogate('cut ' + HIGH)).toBe(true)
    expect(hasLoneSurrogate(LOW + ' cut')).toBe(true)
  })

  it('toWellFormed replaces lone surrogates and keeps pairs', () => {
    expect(toWellFormed('a' + HIGH + 'b')).toBe('a�b')
    expect(toWellFormed(ROCKET)).toBe(ROCKET)
  })

  it('sliceWellFormed never splits a pair at either edge', () => {
    const s = 'ab' + ROCKET + 'cd'
    // head cut lands between the two halves of the rocket
    expect(sliceWellFormed(s, 0, 3)).toBe('ab')
    // tail cut starts on the low surrogate
    expect(sliceWellFormed(s, 3)).toBe('cd')
    // clean cuts pass through unchanged
    expect(sliceWellFormed(s, 0, 4)).toBe('ab' + ROCKET)
    expect(sliceWellFormed('', 0, 5)).toBe('')
  })

  it('repairStringsDeep fixes nested strings in place and counts them', () => {
    const body = {
      instructions: 'ok ' + ROCKET,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' + HIGH }] }],
      n: 1,
      nested: { deep: LOW },
    }
    expect(repairStringsDeep(body)).toBe(2)
    expect(body.instructions).toBe('ok ' + ROCKET)
    expect(body.input[0].content[0].text).toBe('x�')
    expect(body.nested.deep).toBe('�')
  })
})
