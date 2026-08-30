/**
 * Every "Docs ↗" link in the UI must land on a heading that actually exists.
 * Guides get renamed and sections get reworded, and a dead anchor is invisible
 * until a user clicks it — so check the whole map against the files on disk.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { DOCS, REPO_URL } from '../../../src/shared/constants/docs-links'

const GUIDES_DIR = join(__dirname, '../../../docs/guides')

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to dashes. */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-')
}

function anchorsFor(guide: string): Set<string> {
  const md = readFileSync(join(GUIDES_DIR, `${guide}.md`), 'utf8')
  const anchors = new Set<string>()
  for (const line of md.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*)$/)
    if (m) anchors.add(slugify(m[1].replace(/`/g, '')))
  }
  return anchors
}

const entries = Object.entries(DOCS)

describe('docs links', () => {
  it('maps every key to a guide URL under the repo', () => {
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, url] of entries) {
      expect(url, key).toMatch(new RegExp(`^${REPO_URL}/blob/main/docs/guides/[a-z0-9-]+\\.md(#[a-z0-9-]+)?$`))
    }
  })

  it('points at guide files that exist', () => {
    const missing: string[] = []
    for (const [key, url] of entries) {
      const guide = url.split('/guides/')[1].split('#')[0]
      if (!existsSync(join(GUIDES_DIR, guide))) missing.push(`${key} → ${guide}`)
    }
    expect(missing).toEqual([])
  })

  it('points at headings that exist', () => {
    const broken: string[] = []
    for (const [key, url] of entries) {
      const [file, anchor] = url.split('/guides/')[1].split('#')
      if (!anchor) continue
      const guide = file.replace(/\.md$/, '')
      if (!anchorsFor(guide).has(anchor)) broken.push(`${key} → ${file}#${anchor}`)
    }
    expect(broken).toEqual([])
  })

  it('keeps the guide catalog covered', () => {
    // Not every guide needs a link from the UI, but the index should stay
    // reachable so a reader can find the ones that have no dedicated control.
    const guides = readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.md'))
    expect(guides).toContain('index.md')
    expect(Object.values(DOCS)).toContain(`${REPO_URL}/blob/main/docs/guides/index.md`)
  })
})
