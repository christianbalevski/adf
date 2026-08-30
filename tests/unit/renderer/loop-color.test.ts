import { describe, it, expect } from 'vitest'
import { loopColor, LOOP_PALETTE, MAIN_LOOP_COLOR } from '../../../src/renderer/utils/loop-color'

describe('loopColor', () => {
  it('is deterministic for the same name', () => {
    for (const name of ['research', 'watchdog', 'agent-1', 'a', 'x'.repeat(32)]) {
      expect(loopColor(name)).toBe(loopColor(name))
    }
  })

  it('depends on the name only — not on declaration order or neighbours', () => {
    const before = loopColor('watchdog')
    loopColor('research')
    loopColor('inbox_triage')
    expect(loopColor('watchdog')).toBe(before)
  })

  it('gives main (and the empty name) the neutral accent, never a palette hue', () => {
    expect(loopColor('main')).toBe(MAIN_LOOP_COLOR)
    expect(loopColor('')).toBe(MAIN_LOOP_COLOR)
    expect(LOOP_PALETTE).not.toContain(MAIN_LOOP_COLOR)
  })

  it('always lands inside the palette for non-main names', () => {
    for (let i = 0; i < 500; i++) {
      const color = loopColor(`loop-${i}`)
      expect(LOOP_PALETTE).toContain(color)
    }
  })

  it('spreads across the whole palette', () => {
    const seen = new Set(Array.from({ length: 500 }, (_, i) => loopColor(`loop-${i}`)))
    expect(seen.size).toBe(LOOP_PALETTE.length)
  })

  it('exposes ten distinct hues', () => {
    expect(LOOP_PALETTE).toHaveLength(10)
    expect(new Set(LOOP_PALETTE.map((c) => c.underline)).size).toBe(10)
  })

  // The state dot owns yellow/green/purple/red/neutral, and `main` owns the
  // app's accent blue. An identity colour must not be mistakable for either.
  it('avoids the state-dot hues and the app accent blue', () => {
    const forbidden = /\b(?:yellow|green|purple|red|neutral|blue)-/
    for (const color of LOOP_PALETTE) {
      for (const value of Object.values(color)) {
        expect(value).not.toMatch(forbidden)
      }
    }
  })

  it('ships light and dark class pairs for every slot', () => {
    for (const color of [...LOOP_PALETTE, MAIN_LOOP_COLOR]) {
      expect(Object.keys(color).sort()).toEqual(
        ['accent', 'badge', 'focus', 'label', 'rail', 'underline', 'underlineMuted']
      )
      expect(color.accent).toMatch(/dark:/)
      expect(color.rail).toMatch(/dark:/)
      expect(color.badge).toMatch(/dark:/)
    }
  })

  // The inactive tab underline is the SAME identity, dimmed — that is what
  // makes the strip a legend. A different hue (or a neutral) would break the
  // match between a sender-coloured loop_send card and its tab.
  it('mutes the identity underline to the same hue for inactive inner-loop tabs', () => {
    for (const color of LOOP_PALETTE) {
      expect(color.underlineMuted).toBe(
        color.underline.split(' ').map((cls) => `${cls}/40`).join(' ')
      )
      // Literal classes only — an interpolated opacity is invisible to Tailwind.
      expect(color.underlineMuted).not.toContain('${')
    }
  })

  it('leaves main out of the legend — its inactive tab stays bare', () => {
    expect(MAIN_LOOP_COLOR.underlineMuted).toBe('border-transparent')
  })
})
