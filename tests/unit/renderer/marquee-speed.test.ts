/** Home suggestion chips drift a whole device pixel every k frames (SuggestionMarquee). */
import { describe, expect, it } from 'vitest'
import { frameLockedSpeed } from '../../../src/renderer/components/home/SuggestionMarquee'

describe('frameLockedSpeed', () => {
  it('a 60 Hz 1x monitor and a 120 Hz Retina display both drift at 60 px/s, one device pixel a frame', () => {
    expect(frameLockedSpeed(60, 1)).toBe(60)
    expect(frameLockedSpeed(120, 2)).toBe(60)
  })

  it('a fast 1x monitor moves a pixel every second frame instead of racing', () => {
    expect(frameLockedSpeed(144, 1)).toBe(72)
    expect(frameLockedSpeed(100, 1)).toBe(50)
  })

  it('a 60 Hz 2x display moves one device pixel a frame', () => {
    expect(frameLockedSpeed(60, 2)).toBe(30)
  })
})
