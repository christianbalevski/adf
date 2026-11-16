import { describe, expect, it } from 'vitest'
import {
  addBrowserSource,
  browserResults,
  configuredBrowserSources,
  installSlot,
  removeBrowserSource,
  settleBrowserSource,
  toCatalogSourceResult,
  buildCatalogCards,
  cardName,
  filterCatalogCards,
  type CatalogSourceResult,
  type LoadedManifestName,
} from '../../../src/shared/utils/skills-panel'
import type { DiscoveredSkillPackage, DiscoveredSkillSource } from '../../../src/shared/schemas/skills-catalog.schema'

const entry = (name: string) => ({ name, description: `${name} desc`, raw_url: `https://cat.test/${name}/SKILL.md` })
const pkg = (source: string, dir: string): DiscoveredSkillPackage => ({ id: `${source}#${dir}`, dir, raw_url: `https://raw.test/${dir}/SKILL.md`, totalBytes: 1, files: [] })
const github = (url: string, dirs: string[]): CatalogSourceResult => {
  const discovered: DiscoveredSkillSource = { kind: 'github', repository: 'o/r', sha: 'a'.repeat(40), ref: 'HEAD', scope: '', url, packages: dirs.map((d) => pkg(url, d)), problems: [] }
  return { url, ok: true, entries: [], discovered }
}

describe('catalog cards', () => {
  const json1: CatalogSourceResult = { url: 'https://one.test/c.json', ok: true, entries: [entry('pdf'), entry('docx')] }
  const json2: CatalogSourceResult = { url: 'https://two.test/c.json', ok: true, entries: [entry('pdf'), entry('xlsx')] }
  const gh = github('https://github.com/o/r', ['a/react', 'b/react', 'c/pdf'])

  it('cards follow the source list: each source\'s catalog entries (by name), then its packages; a name an earlier catalog lists is left out', () => {
    const cards = buildCatalogCards([json1, json2, gh])
    expect(cards.map((c) => c.key)).toEqual(['entry:docx', 'entry:pdf', 'entry:xlsx', 'https://github.com/o/r#a/react', 'https://github.com/o/r#b/react', 'https://github.com/o/r#c/pdf'])
    expect(cards.find((c) => c.key === 'entry:pdf')!.sourceUrl).toBe('https://one.test/c.json')
    // Unloaded packages have no name yet: nothing is merged or dropped on a folder name.
    expect(cards.filter((c) => c.kind === 'package').map((c) => cardName(c, null))).toEqual([null, null, null])
  })

  it('a source listed first (a pasted one) has its cards first, ahead of the configured catalog', () => {
    expect(buildCatalogCards([gh, json1]).map((c) => c.key)).toEqual(['https://github.com/o/r#a/react', 'https://github.com/o/r#b/react', 'https://github.com/o/r#c/pdf', 'entry:docx', 'entry:pdf'])
  })

  it('search: names first, then descriptions and paths; an unloaded package matches on its path only', () => {
    const loaded = new Map<string, LoadedManifestName>([['https://raw.test/a/react/SKILL.md', { name: 'react-perf', description: 'speed' }]])
    const get = (url: string) => loaded.get(url) ?? null
    const cards = buildCatalogCards([json1, gh])
    expect(filterCatalogCards(cards, 'react', get).map((c) => c.key)).toEqual(['https://github.com/o/r#a/react', 'https://github.com/o/r#b/react'])
    expect(filterCatalogCards(cards, 'speed', get).map((c) => c.key)).toEqual(['https://github.com/o/r#a/react'])
    expect(filterCatalogCards(cards, 'pdf', get).map((c) => c.key)).toEqual(['entry:pdf', 'https://github.com/o/r#c/pdf'])
  })
})

/** The catalog-entry cards, as the terminal app lists them (moved from mergeCatalogResults / filterCatalogEntries). */
describe('catalog entry cards: first-wins in source order, search ranks names first', () => {
  const ok = (url: string, entries: Array<ReturnType<typeof entry>>, publisher?: string): CatalogSourceResult => ({ url, ok: true, entries, publisher })
  const described = (name: string, description: string) => ({ ...entry(name), description })
  const entries = (results: CatalogSourceResult[], query = '') =>
    filterCatalogCards(buildCatalogCards(results), query, () => null).flatMap((c) => (c.kind === 'entry' ? [c.entry] : []))
  const A = 'https://a.test/c.json'
  const B = 'https://b.test/c.json'

  it('first-wins on a duplicate name, by LIST ORDER; badges say where each came from', () => {
    const merged = entries([ok(A, [described('shared', 'listed first'), described('alpha', 'first')], 'ADF'), ok(B, [described('shared', 'later'), entry('beta')])])
    expect(merged.map((e) => [e.name, e.description, e.sourceLabel, e.sourceUrl])).toEqual([
      ['alpha', 'first', 'ADF', A], ['shared', 'listed first', 'ADF', A], ['beta', 'beta desc', 'b.test', B],
    ])
  })

  it('a failed source contributes nothing and blocks nothing; no sources list nothing; inputs are not mutated', () => {
    const source = entry('alpha')
    expect(entries([{ url: A, ok: false, entries: [], error: 'down' }, ok(B, [source])]).map((e) => e.sourceUrl)).toEqual([B])
    expect(source).not.toHaveProperty('sourceUrl')
    expect(entries([])).toEqual([])
  })

  it('search: case-insensitive, name matches above description-only ones, each card once, nothing for no match', () => {
    const list = ok(A, [described('archivist', 'files every note away'), described('note-taker', 'writes'), described('reporter', 'a note into a report'), described('notebook', 'NOTEWORTHY'), described('zeta', 'nothing')])
    expect(entries([list], 'NOTE').map((e) => e.name)).toEqual(['note-taker', 'notebook', 'archivist', 'reporter'])
    expect(entries([ok(A, [described('note', 'a note about notes')])], 'note')).toHaveLength(1)
    expect(entries([list], '   ')).toHaveLength(5)
    expect(entries([list], 'kubernetes')).toEqual([])
  })
})

describe('one source list: pasted sources are transient rows ahead of the configured ones', () => {
  const ok = (url: string, names: string[]): CatalogSourceResult => ({ url, ok: true, entries: names.map((n) => ({ name: n, description: n, raw_url: `${url}/${n}` })) })
  let n = 0
  const next = () => ++n

  it('a pasted URL goes first, and its names take precedence (first-wins) over a configured source', () => {
    let list = configuredBrowserSources(['https://cfg.test/c.json'], next)
    list = settleBrowserSource(list, 'https://cfg.test/c.json', list[0].request, ok('https://cfg.test/c.json', ['pdf']))
    const r = next()
    list = addBrowserSource(list, 'https://paste.test/c.json', r)
    list = settleBrowserSource(list, 'https://paste.test/c.json', r, ok('https://paste.test/c.json', ['pdf', 'xlsx']))
    expect(list.map((s) => [s.url, s.transient])).toEqual([['https://paste.test/c.json', true], ['https://cfg.test/c.json', false]])
    const cards = buildCatalogCards(browserResults(list))
    expect(cards.find((c) => c.key === 'entry:pdf')!.sourceUrl).toBe('https://paste.test/c.json')
  })

  it('pasting a URL already listed (configured or pasted) adds no second row: it is fetched again in place', () => {
    let list = configuredBrowserSources(['https://cfg.test/c.json'], next)
    const r = next()
    list = addBrowserSource(list, 'https://cfg.test/c.json', r)
    expect(list).toEqual([{ url: 'https://cfg.test/c.json', transient: false, request: r, result: null }])
    const p1 = next()
    list = addBrowserSource(list, 'https://paste.test/c.json', p1)
    const p2 = next()
    list = addBrowserSource(list, 'https://paste.test/c.json', p2)
    expect(list.filter((s) => s.url === 'https://paste.test/c.json')).toEqual([{ url: 'https://paste.test/c.json', transient: true, request: p2, result: null }])
    // The answer to the superseded request is dropped; the current one lands.
    list = settleBrowserSource(list, 'https://paste.test/c.json', p1, ok('https://paste.test/c.json', ['old']))
    expect(list[0].result).toBeNull()
    list = settleBrowserSource(list, 'https://paste.test/c.json', p2, ok('https://paste.test/c.json', ['new']))
    expect(list[0].result?.entries.map((e) => e.name)).toEqual(['new'])
  })

  it('removing a pasted source drops it, a late answer for it is ignored, and configured rows cannot be removed here', () => {
    let list = configuredBrowserSources(['https://cfg.test/c.json'], next)
    const r = next()
    list = addBrowserSource(list, 'https://paste.test/c.json', r)
    list = removeBrowserSource(list, 'https://paste.test/c.json')
    list = settleBrowserSource(list, 'https://paste.test/c.json', r, ok('https://paste.test/c.json', ['late']))
    expect(list.map((s) => s.url)).toEqual(['https://cfg.test/c.json'])
    expect(removeBrowserSource(list, 'https://cfg.test/c.json')).toEqual(list)
  })

  it('a refused source is its own failed row; the others still list', () => {
    let list = configuredBrowserSources(['https://cfg.test/c.json'], next)
    list = settleBrowserSource(list, 'https://cfg.test/c.json', list[0].request, ok('https://cfg.test/c.json', ['pdf']))
    const r = next()
    list = addBrowserSource(list, 'https://github.com/o/r', r)
    list = settleBrowserSource(list, 'https://github.com/o/r', r, toCatalogSourceResult('https://github.com/o/r', { ok: false, error: 'HTTP 404 Not Found' }))
    expect(browserResults(list).map((x) => [x.url, x.ok, x.error ?? null])).toEqual([['https://github.com/o/r', false, 'HTTP 404 Not Found'], ['https://cfg.test/c.json', true, null]])
    expect(buildCatalogCards(browserResults(list)).map((c) => c.key)).toEqual(['entry:pdf'])
  })
})

describe('a name is a slot, not a provenance', () => {
  it('two different packages with the same name: neither is shown as installed; both say the name is in use', () => {
    const occupied = new Set(['react-best-practices'])
    const a = installSlot('react-best-practices', occupied)
    const b = installSlot('react-best-practices', occupied)
    for (const slot of [a, b]) {
      expect(slot).toMatchObject({ inUse: true, badge: 'Name in use', action: 'Replace existing files' })
      expect(JSON.stringify(slot)).not.toMatch(/Installed|Reinstall/)
    }
    expect(installSlot('other', occupied)).toEqual({ inUse: false, badge: null, action: 'Install', title: 'Write skills/other/' })
    expect(installSlot(null, occupied)).toMatchObject({ inUse: false, action: 'Install' })
  })
})
