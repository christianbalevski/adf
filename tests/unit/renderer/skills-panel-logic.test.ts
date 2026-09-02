import { describe, it, expect } from 'vitest'
import { ADF_SKILLS_REGISTRY_URL } from '../../../src/shared/constants/adf-defaults'
import type { SkillCatalogEntry } from '../../../src/shared/schemas/skills-catalog.schema'
import {
  MAX_CATALOG_SOURCES,
  addCatalogSource,
  catalogSourceLabel,
  filterCatalogEntries,
  isCatalogUrl,
  mergeCatalogResults,
  mergeDisabledList,
  normalizeCatalogSources,
  parseSkillsRegistry,
  sanitizeDisplayText,
  type CatalogSourceResult
} from '../../../src/renderer/utils/skills-panel'

/**
 * The decisions the Skills panel depends on.
 *
 * LIVE BUG these cover: the panel rewrote skills-state.json as a whole document
 * (`{schema, disabled}`), so any other key in the file — a newer schema field,
 * an agent's own annotation — was destroyed by a human clicking a mute
 * checkbox.
 */

describe('mergeDisabledList', () => {
  it('preserves keys it does not understand', () => {
    const existing = JSON.stringify({ schema: 1, note: 'hand-written', disabled: ['alpha'], extra: { a: 1 } })
    const merged = JSON.parse(mergeDisabledList(existing, 'beta', false))
    expect(merged.note).toBe('hand-written')
    expect(merged.extra).toEqual({ a: 1 })
    expect(merged.disabled).toEqual(['alpha', 'beta'])
    expect(merged.schema).toBe(1)
  })

  it('unmuting removes only the named skill', () => {
    const existing = JSON.stringify({ schema: 1, disabled: ['alpha', 'beta'] })
    expect(JSON.parse(mergeDisabledList(existing, 'alpha', true)).disabled).toEqual(['beta'])
  })

  it('is idempotent and keeps the list sorted and deduplicated', () => {
    const once = mergeDisabledList(JSON.stringify({ schema: 1, disabled: ['zeta', 'alpha', 'alpha'] }), 'mid', false)
    expect(JSON.parse(once).disabled).toEqual(['alpha', 'mid', 'zeta'])
    expect(mergeDisabledList(once, 'mid', false)).toBe(once)
  })

  it('starts a fresh document when the state file is absent or corrupt', () => {
    expect(JSON.parse(mergeDisabledList(null, 'alpha', false))).toEqual({ schema: 1, disabled: ['alpha'] })
    expect(JSON.parse(mergeDisabledList('{ not json', 'alpha', false))).toEqual({ schema: 1, disabled: ['alpha'] })
    expect(JSON.parse(mergeDisabledList('[1,2,3]', 'alpha', false))).toEqual({ schema: 1, disabled: ['alpha'] })
  })

  it('drops non-string entries rather than writing them back', () => {
    const existing = JSON.stringify({ schema: 1, disabled: ['alpha', 7, null] })
    expect(JSON.parse(mergeDisabledList(existing, 'beta', false)).disabled).toEqual(['alpha', 'beta'])
  })

  it('writes a trailing newline, like every other generated file', () => {
    expect(mergeDisabledList(null, 'alpha', false).endsWith('\n')).toBe(true)
  })
})

describe('parseSkillsRegistry', () => {
  const registry = (extra: Record<string, unknown> = {}) => JSON.stringify({
    schema: 1,
    skills: {
      beta: { name: 'beta', description: 'second', path: 'skills/beta/SKILL.md', enabled: true },
      alpha: { name: 'alpha', path: 'skills/alpha/SKILL.md', enabled: false }
    },
    ...extra
  })

  it('sorts entries and treats a missing description as muted-or-undescribed', () => {
    const parsed = parseSkillsRegistry(registry())
    expect(parsed?.entries.map((e) => e.name)).toEqual(['alpha', 'beta'])
    expect(parsed?.entries[0]).toMatchObject({ enabled: false, description: undefined })
    expect(parsed?.rejected).toEqual([])
  })

  it('reads the indexer rejection list and derives the package name from the path', () => {
    const parsed = parseSkillsRegistry(registry({
      rejected: [
        { path: 'skills/Broken Name/SKILL.md', reason: 'invalid skill name' },
        { path: 'skills/huge/SKILL.md', reason: 'exceeds 262144 bytes' },
        { path: 'skills/nested/deep/SKILL.md', reason: 'not a package manifest' },
        { path: 'skills/bad/SKILL.md' },
        'nonsense'
      ]
    }))
    expect(parsed?.rejected).toEqual([
      { path: 'skills/Broken Name/SKILL.md', reason: 'invalid skill name', name: 'Broken Name' },
      { path: 'skills/huge/SKILL.md', reason: 'exceeds 262144 bytes', name: 'huge' },
      { path: 'skills/nested/deep/SKILL.md', reason: 'not a package manifest', name: null }
    ])
  })

  it('treats an unreadable or newer registry as absent', () => {
    expect(parseSkillsRegistry(null)).toBeNull()
    expect(parseSkillsRegistry('{ not json')).toBeNull()
    expect(parseSkillsRegistry(JSON.stringify({ schema: 2, skills: {} }))).toBeNull()
    expect(parseSkillsRegistry(JSON.stringify({ schema: 1 }))).toBeNull()
  })
})

describe('sanitizeDisplayText', () => {
  it('strips the bidi overrides that let a name lie about itself', () => {
    expect(sanitizeDisplayText('evil-\u202Egnp.dm')).toBe('evil- gnp.dm')
    expect(sanitizeDisplayText('a\u2066b\u2069c')).toBe('a b c')
  })

  it('collapses control characters and newlines into a single line', () => {
    expect(sanitizeDisplayText('one\r\ntwo\u0000three')).toBe('one two three')
  })

  it('passes ordinary text through untouched', () => {
    expect(sanitizeDisplayText('Draft a weekly report')).toBe('Draft a weekly report')
    expect(sanitizeDisplayText(undefined)).toBe('')
  })
})

describe('catalog URLs', () => {
  // Sources are named in Settings → Skills; guarded-fetch refuses everything
  // but https, so the field says so before the round trip rather than after it.
  it('accepts only https URLs', () => {
    expect(isCatalogUrl('https://example.com/registry.json')).toBe(true)
    expect(isCatalogUrl('http://example.com/registry.json')).toBe(false)
    expect(isCatalogUrl('file:///etc/passwd')).toBe(false)
    expect(isCatalogUrl('example.com')).toBe(false)
    expect(isCatalogUrl('   ')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Catalog sources — the app-level preference behind the browser              */
/* -------------------------------------------------------------------------- */

const OTHER = 'https://example.com/skills/registry.json'
const THIRD = 'https://third.example/registry.json'

describe('normalizeCatalogSources', () => {
  it('keeps usable https sources in the order they were stored', () => {
    expect(normalizeCatalogSources([OTHER, THIRD])).toEqual([OTHER, THIRD])
    // Merge precedence is list order, so the default sitting last is meaningful.
    expect(normalizeCatalogSources([OTHER, ADF_SKILLS_REGISTRY_URL]))
      .toEqual([OTHER, ADF_SKILLS_REGISTRY_URL])
  })

  it('ABSENT means never configured, and resolves to the first-party registry', () => {
    // The back-compat default: every settings file written before the list
    // became authoritative reads as "just the default", so no migration runs.
    expect(normalizeCatalogSources(undefined)).toEqual([ADF_SKILLS_REGISTRY_URL])
    expect(normalizeCatalogSources(null)).toEqual([ADF_SKILLS_REGISTRY_URL])
    expect(normalizeCatalogSources('https://example.com')).toEqual([ADF_SKILLS_REGISTRY_URL])
    expect(normalizeCatalogSources({ 0: OTHER })).toEqual([ADF_SKILLS_REGISTRY_URL])
  })

  it('an explicitly empty list stays empty — nobody is made to carry a registry', () => {
    expect(normalizeCatalogSources([])).toEqual([])
  })

  it('a list that omits the default omits it, rather than having it added back', () => {
    expect(normalizeCatalogSources([OTHER])).toEqual([OTHER])
  })

  it('drops non-strings and anything guarded-fetch would refuse', () => {
    expect(normalizeCatalogSources([OTHER, 7, null, 'http://insecure.example/r.json', 'nonsense', ''])).toEqual([OTHER])
  })

  it('trims, and collapses duplicates to the first occurrence', () => {
    expect(normalizeCatalogSources([`  ${OTHER}  `, OTHER, THIRD])).toEqual([OTHER, THIRD])
  })

  it('dedupes the default like any other row, keeping its first position', () => {
    expect(normalizeCatalogSources([ADF_SKILLS_REGISTRY_URL, OTHER, ADF_SKILLS_REGISTRY_URL]))
      .toEqual([ADF_SKILLS_REGISTRY_URL, OTHER])
  })

  it('truncates a hand-edited preference past the bound rather than trusting it', () => {
    const many = Array.from({ length: MAX_CATALOG_SOURCES + 4 }, (_, i) => `https://s${i}.example/r.json`)
    expect(normalizeCatalogSources(many)).toHaveLength(MAX_CATALOG_SOURCES)
  })
})

describe('addCatalogSource', () => {
  it('appends a valid https source', () => {
    expect(addCatalogSource([], OTHER)).toEqual({ ok: true, sources: [OTHER] })
    expect(addCatalogSource([OTHER], `  ${THIRD}  `)).toEqual({ ok: true, sources: [OTHER, THIRD] })
  })

  it('refuses an empty or non-https URL', () => {
    expect(addCatalogSource([], '  ')).toEqual({ ok: false, error: 'Enter a catalog URL.' })
    expect(addCatalogSource([], 'http://example.com/r.json'))
      .toEqual({ ok: false, error: 'A catalog source must be an https:// URL.' })
    expect(addCatalogSource([], 'example.com'))
      .toEqual({ ok: false, error: 'A catalog source must be an https:// URL.' })
    expect(addCatalogSource([], 'file:///etc/passwd'))
      .toEqual({ ok: false, error: 'A catalog source must be an https:// URL.' })
  })

  it('re-adds the default registry like any other source', () => {
    // What "Add default registry" in Settings does after someone removed it.
    expect(addCatalogSource([OTHER], ADF_SKILLS_REGISTRY_URL))
      .toEqual({ ok: true, sources: [OTHER, ADF_SKILLS_REGISTRY_URL] })
    expect(addCatalogSource([], ADF_SKILLS_REGISTRY_URL))
      .toEqual({ ok: true, sources: [ADF_SKILLS_REGISTRY_URL] })
  })

  it('refuses a duplicate, the default included', () => {
    expect(addCatalogSource([OTHER], OTHER)).toEqual({ ok: false, error: 'That source is already listed.' })
    expect(addCatalogSource([ADF_SKILLS_REGISTRY_URL], ADF_SKILLS_REGISTRY_URL))
      .toEqual({ ok: false, error: 'That source is already listed.' })
  })

  it('refuses to grow past the bound — every source is a fetch on every open', () => {
    const full = Array.from({ length: MAX_CATALOG_SOURCES }, (_, i) => `https://s${i}.example/r.json`)
    expect(addCatalogSource(full, OTHER))
      .toEqual({ ok: false, error: `At most ${MAX_CATALOG_SOURCES} catalog sources.` })
  })

  it('never mutates the list it was given', () => {
    const sources = [OTHER]
    addCatalogSource(sources, THIRD)
    expect(sources).toEqual([OTHER])
  })
})

describe('catalogSourceLabel', () => {
  it('prefers the publisher the document declared', () => {
    expect(catalogSourceLabel(OTHER, 'Acme Skills')).toBe('Acme Skills')
  })

  it('falls back to the host when there is no publisher', () => {
    expect(catalogSourceLabel(OTHER)).toBe('example.com')
    expect(catalogSourceLabel(OTHER, '   ')).toBe('example.com')
  })

  it('sanitizes the publisher — it is remote text painted as an identity badge', () => {
    expect(catalogSourceLabel(OTHER, 'Acme‮ Skills')).toBe('Acme Skills')
    // A publisher made entirely of bidi overrides sanitizes to nothing, and
    // must not leave the badge blank — the host is the honest fallback.
    expect(catalogSourceLabel(OTHER, '‮⁦')).toBe('example.com')
  })

  it('falls back to the raw string when the URL will not parse', () => {
    expect(catalogSourceLabel('not a url')).toBe('not a url')
  })
})

describe('mergeCatalogResults', () => {
  const entry = (name: string, description = `${name} does things`): SkillCatalogEntry => ({
    name,
    description,
    raw_url: `https://example.com/${name}/SKILL.md`
  })

  const ok = (url: string, entries: SkillCatalogEntry[], publisher?: string): CatalogSourceResult =>
    ({ url, ok: true, entries, publisher })

  it('merges every source and sorts the result by name', () => {
    const merged = mergeCatalogResults([
      ok(ADF_SKILLS_REGISTRY_URL, [entry('zeta')]),
      ok(OTHER, [entry('alpha')])
    ])
    expect(merged.map((e) => e.name)).toEqual(['alpha', 'zeta'])
  })

  it('is first-wins on a duplicate name: an earlier source cannot be redefined', () => {
    const merged = mergeCatalogResults([
      ok(ADF_SKILLS_REGISTRY_URL, [entry('shared', 'the first-party one')]),
      ok(OTHER, [entry('shared', 'an impostor')])
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].description).toBe('the first-party one')
    expect(merged[0].sourceUrl).toBe(ADF_SKILLS_REGISTRY_URL)
  })

  it('precedence is LIST ORDER, not identity: the default listed second loses', () => {
    const merged = mergeCatalogResults([
      ok(OTHER, [entry('shared', 'listed first')]),
      ok(ADF_SKILLS_REGISTRY_URL, [entry('shared', 'the first-party one')])
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].description).toBe('listed first')
    expect(merged[0].sourceUrl).toBe(OTHER)
  })

  it('badges each surviving entry with the source it came from', () => {
    const merged = mergeCatalogResults([
      ok(ADF_SKILLS_REGISTRY_URL, [entry('alpha')], 'ADF'),
      ok(OTHER, [entry('beta')])
    ])
    expect(merged.map((e) => [e.name, e.sourceLabel, e.sourceUrl])).toEqual([
      ['alpha', 'ADF', ADF_SKILLS_REGISTRY_URL],
      ['beta', 'example.com', OTHER]
    ])
  })

  it('contributes nothing from a failed source and blocks nothing', () => {
    const merged = mergeCatalogResults([
      { url: ADF_SKILLS_REGISTRY_URL, ok: false, entries: [], error: 'Network unreachable' },
      ok(OTHER, [entry('alpha')])
    ])
    expect(merged.map((e) => e.name)).toEqual(['alpha'])
    // With the built-in source down, the next source legitimately owns the name.
    expect(merged[0].sourceUrl).toBe(OTHER)
  })

  it('collapses a duplicate within one source too', () => {
    const merged = mergeCatalogResults([ok(OTHER, [entry('alpha', 'first'), entry('alpha', 'second')])])
    expect(merged).toHaveLength(1)
    expect(merged[0].description).toBe('first')
  })

  it('handles no sources and all-failed sources without throwing', () => {
    expect(mergeCatalogResults([])).toEqual([])
    expect(mergeCatalogResults([{ url: OTHER, ok: false, entries: [], error: 'nope' }])).toEqual([])
  })

  it('does not mutate the entries it was handed', () => {
    const source = entry('alpha')
    mergeCatalogResults([ok(OTHER, [source])])
    expect(source).not.toHaveProperty('sourceUrl')
  })
})

describe('filterCatalogEntries', () => {
  // Deliberately ordered so a description-only match (archivist) sorts BEFORE
  // both name matches: ranking that did nothing would leave it first.
  const entries = [
    { name: 'archivist', description: 'files every note away' },
    { name: 'note-taker', description: 'writes things down' },
    { name: 'reporter', description: 'summarizes a note into a report' },
    { name: 'notebook', description: 'NOTEWORTHY behaviour' },
    { name: 'zeta', description: 'nothing relevant' }
  ]

  it('returns everything for an empty or whitespace query', () => {
    expect(filterCatalogEntries(entries, '')).toBe(entries)
    expect(filterCatalogEntries(entries, '   ')).toBe(entries)
  })

  it('ranks name matches above description-only matches', () => {
    expect(filterCatalogEntries(entries, 'note').map((e) => e.name))
      .toEqual(['note-taker', 'notebook', 'archivist', 'reporter'])
  })

  it('is case-insensitive on both fields', () => {
    expect(filterCatalogEntries(entries, 'NOTE').map((e) => e.name))
      .toEqual(['note-taker', 'notebook', 'archivist', 'reporter'])
    expect(filterCatalogEntries(entries, 'ZETA').map((e) => e.name)).toEqual(['zeta'])
  })

  it('counts an entry once, in its name group, when both fields match', () => {
    const both = [{ name: 'note', description: 'a note about notes' }]
    expect(filterCatalogEntries(both, 'note')).toHaveLength(1)
  })

  it('preserves the merge order within each rank group', () => {
    expect(filterCatalogEntries(entries, 'e').map((e) => e.name))
      .toEqual(['note-taker', 'reporter', 'notebook', 'zeta', 'archivist'])
  })

  it('returns nothing when the query matches nothing', () => {
    expect(filterCatalogEntries(entries, 'kubernetes')).toEqual([])
  })
})
