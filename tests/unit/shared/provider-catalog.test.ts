import { describe, it, expect } from 'vitest'
import {
  PROVIDER_CATALOG,
  PROVIDER_CATALOG_GROUPS,
  catalogEntryForProvider,
  findCatalogEntry,
  nextProviderName,
} from '../../../src/shared/constants/provider-catalog'
import { PROVIDER_TYPES } from '../../../src/shared/constants/adf-defaults'

describe('provider catalog', () => {
  it('has unique keys and only known runtime types', () => {
    const keys = PROVIDER_CATALOG.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
    const types = new Set(PROVIDER_TYPES.map((t) => t.type))
    for (const e of PROVIDER_CATALOG) expect(types.has(e.type)).toBe(true)
  })

  it('every runtime type has a catalog entry keyed by its own name (legacy rows resolve)', () => {
    for (const t of PROVIDER_TYPES) {
      expect(findCatalogEntry(t.type)?.type).toBe(t.type)
    }
  })

  it('openai-compatible entries other than the generic tile carry a base URL', () => {
    for (const e of PROVIDER_CATALOG) {
      if (e.type === 'openai-compatible' && e.key !== 'openai-compatible') {
        expect(e.baseUrl, e.key).toMatch(/^https?:\/\//)
      }
    }
  })

  it('every entry belongs to a listed group', () => {
    const groups = new Set(PROVIDER_CATALOG_GROUPS.map((g) => g.id))
    for (const e of PROVIDER_CATALOG) expect(groups.has(e.group)).toBe(true)
  })

  it('resolves a saved provider by preset first, then by type', () => {
    expect(catalogEntryForProvider({ type: 'openai-compatible', preset: 'groq' })?.label).toBe('Groq')
    expect(catalogEntryForProvider({ type: 'openai-compatible' })?.label).toBe('OpenAI-compatible')
    expect(catalogEntryForProvider({ type: 'anthropic', preset: 'does-not-exist' })?.label).toBe('Anthropic')
  })

  it('numbers duplicate names case-insensitively', () => {
    expect(nextProviderName('Groq', [])).toBe('Groq')
    expect(nextProviderName('Groq', [{ name: 'groq' }])).toBe('Groq 2')
    expect(nextProviderName('Groq', [{ name: 'Groq' }, { name: 'Groq 2' }])).toBe('Groq 3')
    expect(nextProviderName('Groq', [{ name: 'Groq 2' }])).toBe('Groq')
  })
})
