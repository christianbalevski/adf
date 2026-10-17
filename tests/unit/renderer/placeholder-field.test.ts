// A stored value shown as a placeholder (remote daemon) is replaced by what
// the user types, never edited into a piece of the placeholder (W3-C follow-up).
import { describe, expect, it } from 'vitest'
import { editPlaceholderField, STORED_VALUE_PLACEHOLDER as P } from '../../../src/renderer/utils/placeholder-field'

describe('editPlaceholderField', () => {
  it.each([
    ['typed at the end', `${P}k`, 'k'],
    ['typed at the start', `k${P}`, 'k'],
    ['typed in the middle', '__reda' + 'xyz' + 'cted__', 'xyz'],
    ['pasted over all of it', 'sk-live-123', 'sk-live-123'],
    ['backspaced', P.slice(0, -1), ''],
    ['cleared', '', ''],
    ['a selection replaced', '__re' + 'Q' + '__', 'Q'],
  ])('%s', (_label, next, expected) => {
    expect(editPlaceholderField(P, next)).toBe(expected)
  })

  it('leaves other fields and the untouched placeholder alone', () => {
    expect(editPlaceholderField(P, P)).toBe(P)
    expect(editPlaceholderField('abc', 'abcd')).toBe('abcd')
    expect(editPlaceholderField('', P)).toBe(P)
  })
})
