import { describe, it, expect } from 'vitest'
import { formatUsd } from '../../../src/renderer/utils/format-usd'

describe('formatUsd', () => {
  it('never floors a real cost to "$0.0000"', () => {
    expect(formatUsd(0.00003)).toBe('<$0.0001')
    expect(formatUsd(0.00009999)).toBe('<$0.0001')
  })

  it('keeps four decimals below a cent, two from a cent up', () => {
    expect(formatUsd(0.0001)).toBe('$0.0001')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(0.0099)).toBe('$0.0099')
    expect(formatUsd(0.01)).toBe('$0.01')
    expect(formatUsd(0.42)).toBe('$0.42')
    expect(formatUsd(12.5)).toBe('$12.50')
  })

  it('prints zero and garbage as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(NaN)).toBe('$0.00')
    expect(formatUsd(-1)).toBe('$0.00')
  })
})
