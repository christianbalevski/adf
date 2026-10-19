/** Home suggestion chips drift a whole device pixel every k frames (SuggestionMarquee). */
import { describe, expect, it } from 'vitest'
import { frameLockedSpeed } from '../../../src/renderer/components/home/SuggestionMarquee'

describe('frameLockedSpeed', () => {
  it('a 60 Hz 1x monitor and a 120 Hz Retina display both drift at 15 px/s: a device pixel every 4 frames', () => {
    expect(frameLockedSpeed(60, 1)).toBe(15)
    expect(frameLockedSpeed(120, 2)).toBe(15)
  })

  it('a 144 Hz 1x monitor moves a pixel every 10 frames', () => {
    expect(frameLockedSpeed(144, 1)).toBeCloseTo(14.4)
  })

  it('a 60 Hz 2x display moves a device pixel every 2 frames', () => {
    expect(frameLockedSpeed(60, 2)).toBe(15)
  })
})
