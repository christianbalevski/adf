import { describe, it, expect } from 'vitest'
import { MCP_REGISTRY } from '../../../src/shared/constants/mcp-registry'
import { BRAND_ICON_KEYS, isKnownBrandIcon } from '../../../src/renderer/components/mcp/BrandIcon'

const CATEGORIES = new Set(['tools', 'data', 'dev', 'communication', 'web', 'search', 'productivity', 'infra', 'ai'])

describe('BrandIcon ↔ registry mapping', () => {
  it('every registry iconKey resolves to a known brand mark (no dangling keys)', () => {
    const dangling = MCP_REGISTRY
      .filter((e) => e.iconKey && !isKnownBrandIcon(e.iconKey))
      .map((e) => `${e.name} → ${e.iconKey}`)
    expect(dangling).toEqual([])
  })

  it('every brand key is a non-empty string and unique', () => {
    expect(BRAND_ICON_KEYS.length).toBeGreaterThan(0)
    expect(new Set(BRAND_ICON_KEYS).size).toBe(BRAND_ICON_KEYS.length)
    for (const k of BRAND_ICON_KEYS) expect(typeof k).toBe('string')
  })

  it('entries without a brand mark resolve to a valid category glyph', () => {
    for (const entry of MCP_REGISTRY) {
      if (!entry.iconKey) {
        expect(CATEGORIES.has(entry.category)).toBe(true)
      }
    }
  })

  it('isKnownBrandIcon is false for unknown / undefined keys', () => {
    expect(isKnownBrandIcon(undefined)).toBe(false)
    expect(isKnownBrandIcon('not-a-brand')).toBe(false)
  })
})
