import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../..')
const skillDir = resolve(repoRoot, 'skills/agent-import')
const read = (path: string) => readFileSync(resolve(skillDir, path), 'utf8')
// The runtime's count: agent-executor.ts's 300-line preview guard shows only lines.slice(0, 50)
// of a text file whose content.split('\n').length is over 300.
const count = (text: string) => text.split('\n').length
// Counts stay split('\n'); matching strips \r so CRLF checkouts pass.
const lines = (text: string) => text.split('\n').map(line => line.replace(/\r$/, ''))
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(resolve(dir, e.name)) : [relative(skillDir, resolve(dir, e.name)).split('\\').join('/')])

describe('agent-import skill layout (fs_read preview guard)', () => {
  const skill = read('SKILL.md')
  const skillLines = lines(skill)

  it('keeps SKILL.md and every reference at 300 lines or fewer', () => {
    const files = ['SKILL.md', ...walk(skillDir).filter(p => /^references\/.*\.md$/.test(p))]
    for (const file of files) expect(count(read(file)), file).toBeLessThanOrEqual(300)
  })

  it('puts all of Hard rules and the scrub.js loader in the first 50 lines', () => {
    const start = skillLines.indexOf('## Hard rules')
    const next = skillLines.findIndex((line, i) => i > start && line.startsWith('#'))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(next, 'last Hard rules line (1-based)').toBeGreaterThan(start)
    expect(next, 'last Hard rules line (1-based)').toBeLessThanOrEqual(50)
    const loader = skillLines.indexOf("const S = await load('skills/agent-import/scripts/scrub.js');")
    const selftest = skillLines.findIndex(line => line.includes('The self-test is'))
    for (const [name, index] of [['loader', loader], ['self-test line', selftest]] as const) {
      expect(index, name).toBeGreaterThanOrEqual(0)
      expect(index + 1, name).toBeLessThanOrEqual(50)
    }
  })

  it('points at every reference by its installed path, and only at files that exist', () => {
    const refs = walk(skillDir).filter(p => /^references\/.*\.md$/.test(p))
    const mentions = [...skill.matchAll(/(\S*)references\/([\w.-]+\.md)/g)]
    for (const [mention, prefix] of mentions) expect(prefix, mention).toBe('skills/agent-import/') // fs_read does not resolve relative paths
    const pointers = new Set(mentions.map(m => `references/${m[2]}`))
    for (const ref of refs) expect(pointers.has(ref), ref).toBe(true)
    for (const path of pointers) expect(existsSync(resolve(skillDir, path)), path).toBe(true)
  })

  it('lists every package file in the catalog entry', () => {
    const catalog = JSON.parse(readFileSync(resolve(repoRoot, 'skills/registry.json'), 'utf8')) as {
      skills: Array<{ name: string; files?: Array<{ path: string; raw_url: string }> }>
    }
    const entry = catalog.skills.find(s => s.name === 'agent-import')
    const listed = new Set(['SKILL.md', ...(entry?.files ?? []).map(f => f.path)])
    expect(walk(skillDir).filter(p => !listed.has(p))).toEqual([])
    for (const f of entry?.files ?? []) {
      expect(existsSync(resolve(skillDir, f.path)), f.path).toBe(true)
      expect(f.raw_url.endsWith(`/skills/agent-import/${f.path}`), f.raw_url).toBe(true)
    }
  })
})
