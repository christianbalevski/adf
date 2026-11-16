import { describe, expect, it } from 'vitest'
import {
  browserResults,
  configuredBrowserSources,
  installSlot,
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

  it('a GitHub source listed first has its cards first, ahead of the next catalog', () => {
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

describe('configured browser sources', () => {
  it('keeps configured precedence when answers arrive out of order', () => {
    const first = 'https://first.test/c.json'
    const second = 'https://second.test/c.json'
    let list = configuredBrowserSources([first, second])
    expect(browserResults(list)).toEqual([])
    list = settleBrowserSource(list, second, { url: second, ok: true, entries: [entry('pdf')] })
    list = settleBrowserSource(list, first, { url: first, ok: true, entries: [entry('pdf')] })
    expect(buildCatalogCards(browserResults(list))[0].sourceUrl).toBe(first)
  })

  it('keeps a failed source separate from successful configured sources', () => {
    const url = 'https://github.com/o/r'
    const failure = toCatalogSourceResult(url, { ok: false, error: 'HTTP 404 Not Found' })
    const list = settleBrowserSource(configuredBrowserSources([url]), url, failure)
    expect(browserResults(list)).toEqual([failure])
    expect(buildCatalogCards(browserResults(list))).toEqual([])
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
