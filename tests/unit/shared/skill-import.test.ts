import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSkillRegistry, parseSkillFrontmatter } from '../../../src/main/adf/skill-indexer'
import { adfCompatLabel, importAs, importSkillManifest, readAdfCompat, shortenDescription } from '../../../src/shared/utils/skill-import'

const FIX = join(__dirname, '../../fixtures/skills-sources/manifests')
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8')
const SOURCE = 'https://raw.githubusercontent.com/o/r/0123456789abcdef0123456789abcdef01234567/skills/x/SKILL.md'
const run = (text: string) => importSkillManifest(text, SOURCE, parseSkillFrontmatter)
/** Everything after the frontmatter's closing line. */
const bodyOf = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '')
/** What the real indexer publishes for one installed manifest. */
const indexed = (name: string, content: string) => buildSkillRegistry([{ path: `skills/${name}/SKILL.md`, size: Buffer.byteLength(content), content }], null)

describe('importSkillManifest on real packages', () => {
  it('a package that indexes as published installs byte-for-byte', () => {
    const text = fixture('anthropics-canvas-design.SKILL.md')
    const result = run(text)
    expect(result).toMatchObject({ ok: true, name: 'canvas-design', changes: [], compat: { native: false, reason: 'absent' } })
    if (!result.ok) throw new Error()
    expect(result.manifest).toBe(text)
  })

  for (const [file, name, kind] of [
    ['anthropics-docx.SKILL.md', 'docx', 'shortened'],
    ['openai-twilio-conference-calls.SKILL.md', 'twilio-conference-calls', 'requoted'],
    ['openai-zoom-video-sdk-android.SKILL.md', 'zoom-video-sdk-android', 'folded'],
  ] as const) {
    it(`${name}: description ${kind}; indexed by the real indexer; body kept; original kept; notice; no adf added`, () => {
      const text = fixture(file)
      expect('error' in parseSkillFrontmatter(text)).toBe(true)
      const result = run(text)
      if (!result.ok) throw new Error(result.error)
      expect(result.name).toBe(name)
      expect(result.changes.join(' ')).toContain({ shortened: 'shortened', folded: 'folded onto one line', requoted: 'quoted single-line value' }[kind])
      // The real indexer publishes it, under its name, with the adjusted description.
      const registry = indexed(name, result.manifest)
      expect(registry.rejected).toEqual([])
      expect(registry.registry.skills[name]).toMatchObject({ name, description: result.description })
      expect(result.description.length).toBeLessThanOrEqual(500)
      // Every byte of the original body follows the inserted note, unchanged.
      expect(result.manifest.endsWith(bodyOf(text))).toBe(true)
      // The full original description is in the body.
      const original = result.originalDescription!.replace(/\n+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
      expect(bodyOf(result.manifest)).toContain(original)
      expect(result.manifest).toContain(`<!-- Adjusted on install by ADF Studio: ${result.changes.join('; ')}. Source: ${SOURCE} -->`)
      expect(result.manifest).not.toMatch(/^adf:/m)
      expect(readAdfCompat(result.manifest)).toEqual({ native: false, reason: 'absent' })
      // Every other frontmatter line is kept.
      const otherLines = (t: string) => t.split('\n---')[0].split('\n').filter((l) => /^[a-z-]+:/.test(l) && !l.startsWith('description:'))
      expect(otherLines(result.manifest)).toEqual(otherLines(text))
    })
  }

  it('docx is cut at a sentence end within 500 characters', () => {
    const result = run(fixture('anthropics-docx.SKILL.md'))
    if (!result.ok) throw new Error()
    expect(result.description).toMatch(/\.$/)
    expect(result.originalDescription!.replace(/\s+/g, ' ').startsWith(result.description)).toBe(true)
  })
})

describe('importSkillManifest refusals', () => {
  const doc = (front: string, body = '\n# Body\n') => `---\n${front}\n---\n${body}`
  it.each([
    ['duplicate description keys', doc('name: a\ndescription: one\ndescription: two'), /duplicate description; frontmatter is not valid YAML: duplicated mapping key/],
    ['duplicate name keys', doc('name: a\nname: b\ndescription: d'), /duplicate name; frontmatter is not valid YAML: duplicated mapping key/],
    ['an invalid name', doc('name: Not_Valid\ndescription: d'), /invalid skill name "Not_Valid"/],
    ['a missing name', doc('description: d'), /invalid skill name null/],
    ['a block description with a bidi override', doc('name: a\ndescription: |\n  safe \u202Eevil'), /control or bidirectional-override/],
    ['a quoted key the rewrite cannot address', doc('name: a\n"description": |\n  line one\n  line two'), /not a plain top-level key/],
    ['a description needing adaptation beside a duplicated unrelated key', doc('name: a\nlicense: MIT\nlicense: Apache-2.0\ndescription: |\n  one\n  two'), /not valid YAML: duplicated mapping key/],
    ['a description needing adaptation in YAML that does not parse', doc('name: a\ndescription: |\n  one\nbad: [unclosed'), /not valid YAML/],
    ['no frontmatter', '# just text', /missing YAML frontmatter/],
  ])('%s is refused with its reason', (_label, text, reason) => {
    const result = run(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(reason)
  })

  it('a manifest the note would push past the indexer bound is refused', () => {
    const long = 'word '.repeat(150)
    const text = `---\nname: a\ndescription: ${long}\n---\n${'x'.repeat(256 * 1024 - 900)}`
    expect(run(text)).toMatchObject({ ok: false, error: expect.stringMatching(/would exceed 262144 bytes/) })
  })

  it('CRLF documents keep CRLF and index', () => {
    const text = '---\r\nname: a\r\ndescription: |\r\n  one\r\n  two\r\nlicense: MIT\r\n---\r\n\r\n# Body\r\n'
    const result = run(text)
    if (!result.ok) throw new Error(result.error)
    expect(result.manifest.startsWith('---\r\nname: a\r\ndescription: "one two"\r\nlicense: MIT\r\n---\r\n<!-- Adjusted on install')).toBe(true)
    expect(result.manifest.endsWith('\r\n# Body\r\n')).toBe(true)
    expect(parseSkillFrontmatter(result.manifest)).toEqual({ name: 'a', description: 'one two' })
  })
})

describe('the index is the authority: a file it already reads installs byte-for-byte', () => {
  const doc = (front: string) => `---\n${front}\n---\n\n# Body with \`code\` and *stars*\n`
  // Each of these indexed and installed unchanged before this feature; strict YAML would refuse or
  // change them (a reviewer\'s live reproductions), so YAML is never consulted for them.
  it.each([
    ['a colon in the description', doc('name: demo\ndescription: Use when: the user asks for a demo.')],
    ['a description starting with a backtick', doc('name: demo\ndescription: `demo` makes demos.')],
    ['a description starting with *emphasis*', doc('name: demo\ndescription: *Fast* demos.')],
    ['a tab-indented unrelated key', doc('name: demo\ndescription: Demos.\nmetadata:\n\tauthor: x')],
    ['a duplicated unrelated key', doc('name: demo\nlicense: MIT\nlicense: Apache-2.0\ndescription: Demos.')],
    ['a hash YAML would read as a comment', doc('name: demo\ndescription: Handles C# projects #1 priority')],
    ['a value YAML would read as a number', doc('name: demo\ndescription: 42')],
    ['a bidi character the index accepts', doc('name: demo\ndescription: "safe \u202Eevil"')],
  ])('%s', (_label, text) => {
    const indexed = parseSkillFrontmatter(text)
    if ('error' in indexed) throw new Error(indexed.error)
    const result = run(text)
    if (!result.ok) throw new Error(result.error)
    expect(result.manifest).toBe(text)
    expect(result.changes).toEqual([])
    expect({ name: result.name, description: result.description }).toEqual(indexed)
  })

  it('beside an indexable file, adf is read as the index reads fields (not strict YAML); two adf lines are not native', () => {
    // F1 (r4): not strict YAML, but the index reads it: one top-level adf line is the declaration.
    expect(run(doc('name: demo\ndescription: Use when: x\nadf: ">=0.2"')).compat).toEqual({ native: true, range: '>=0.2' })
    expect(run(doc('name: demo\ndescription: Demos.\nadf: ">=0.2"\nadf: ">=0.3"')).compat).toMatchObject({ native: false, reason: 'unreadable' })
    expect(run(doc('name: demo\ndescription: Demos.\nadf: ">=0.2"')).compat).toEqual({ native: true, range: '>=0.2' })
  })
})

describe('shortenDescription', () => {
  it('keeps ≤ 500 as is; cuts at the last sentence end; else at a word with …', () => {
    expect(shortenDescription('a'.repeat(500))).toBe('a'.repeat(500))
    const sentences = `${'First sentence here. '.repeat(20)}`.trim() + ' ' + 'x'.repeat(100)
    const cut = shortenDescription(sentences)
    expect(cut.length).toBeLessThanOrEqual(500)
    expect(cut.endsWith('here.')).toBe(true)
    const words = 'word '.repeat(150).trim()
    const byWord = shortenDescription(words)
    expect(byWord.length).toBeLessThanOrEqual(500)
    expect(byWord.endsWith('word…')).toBe(true)
    expect(shortenDescription('x'.repeat(501))).toBe(`${'x'.repeat(499)}…`)
    expect(shortenDescription('Ends exactly. ' + 'y'.repeat(600)).startsWith('Ends exactly.')).toBe(true)
  })
})

describe('adf label', () => {
  const doc = (adf: string) => `---\nname: a\ndescription: d\n${adf}\n---\n`
  it.each([
    ['adf: ">=0.2"', { native: true, range: '>=0.2' }],
    ['adf: ">=0.8.1"', { native: true, range: '>=0.8.1' }],
    ['adf: "0.2"', { native: true, range: '0.2' }],
    ['adf: 0.2', { native: true, range: '0.2' }],
    ['adf: ">=0.2 <1.0"', { native: true, range: '>=0.2 <1.0' }],
    ['adf: latest', { native: false, reason: 'invalid', detail: 'adf must be a version such as ">=0.2"' }],
    ['adf: "yes"', { native: false, reason: 'invalid', detail: 'adf must be a version such as ">=0.2"' }],
    ['adf: ""', { native: false, reason: 'invalid', detail: 'adf must be a version such as ">=0.2"' }],
    ['adf: [0.2]', { native: false, reason: 'invalid', detail: 'adf must be a version such as ">=0.2"' }],
    ['adf: true', { native: false, reason: 'invalid', detail: 'adf must be a version such as ">=0.2"' }],
    ['license: MIT', { native: false, reason: 'absent' }],
    // Valid YAML supports comments and quoted keys; version components stay lexical.
    ['adf: ">=0.2" # pinned', { native: true, range: '>=0.2' }],
    ['"adf": ">=0.2"', { native: true, range: '>=0.2' }],
    ["'adf': 0.20 # minor version twenty", { native: true, range: '0.20' }],
    ['adf: >-\n  >=0.2\n  <1.0', { native: true, range: '>=0.2 <1.0' }],
    ['meta:\n  adf: ">=0.2"', { native: false, reason: 'absent' }],
  ])('%s', (line, expected) => {
    expect(readAdfCompat(doc(line))).toEqual(expected)
  })

  it('does not accept duplicate keys through the non-YAML fallback', () => {
    for (const description of ['d', 'Use when: needed']) {
      expect(readAdfCompat(`---\nname: a\ndescription: ${description}\nadf: ">=0.2"\n"adf": ">=0.3"\n---\n`)).toMatchObject({ native: false, reason: 'unreadable' })
    }
  })

  it('an unreadable manifest is not native, and the tooltip never claims trust or verification', () => {
    expect(readAdfCompat('no frontmatter')).toMatchObject({ native: false, reason: 'unreadable' })
    expect(readAdfCompat(`---\nname: a\nadf: ">=0.2"\nadf: ">=0.3"\n---\n`)).toMatchObject({ native: false, reason: 'unreadable' })
    const native = adfCompatLabel({ native: true, range: '>=0.2' })
    expect(native.title).toMatch(/not a review, a trust signal, or a check that it works/)
    const not = adfCompatLabel({ native: false, reason: 'absent' })
    expect(not).toMatchObject({ native: false, text: 'Not ADF-native' })
    expect(not.title).toMatch(/declares no adf version/)
    expect(not.title).toMatch(/does not declare ADF compatibility/)
    expect(not.title).not.toMatch(/written for another/)
    expect(adfCompatLabel({ native: false, reason: 'unreadable', detail: 'duplicate adf' }).title).toMatch(/could not be read \(duplicate adf\)\./)
  })

  it('every first-party skill declares a valid adf version (including the five markers added here)', () => {
    const root = join(__dirname, '../../../skills')
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'node_modules')
    const labels = dirs.flatMap((d) => {
      try { return [[d.name, readAdfCompat(readFileSync(join(root, d.name, 'SKILL.md'), 'utf8')).native] as const] } catch { return [] }
    })
    expect(labels.length).toBe(20)
    expect(labels.filter(([, native]) => !native)).toEqual([])
  })
})

describe('one import decision for every host', () => {
  // N-F5: the index bound and the not-text check were the terminal app's own (manifestProblem); now every source gets them here.
  it('refuses a SKILL.md past the index bound, or one that is not text', () => {
    expect(run(`---\nname: big\ndescription: d\n---\n${'x'.repeat(256 * 1024)}`)).toMatchObject({ ok: false, error: 'SKILL.md is over 256 KB, the ADF index reads at most that' })
    expect(run('---\nname: a\ndescription: d\n---\n\u0000')).toMatchObject({ ok: false, error: 'SKILL.md is not text' })
  })

  // BI-F6: a single-line description that only lost trailing whitespace was reported as "folded onto one line".
  it('a description whose only change is a trimmed edge is not reported as folded', () => {
    // A `>` block scalar: YAML already folded it; only the clipped final newline goes.
    const result = run('---\nname: hi\ndescription: >\n  Say hi.\n---\n')
    if (!result.ok) throw new Error(result.error)
    expect(result.changes.join(' ')).toMatch(/quoted single-line value/)
    expect(result.changes.join(' ')).not.toMatch(/folded/)
  })

  // NE-F3: one refusal text for a catalog name that its SKILL.md does not carry (Studio and the terminal app).
  it('importAs refuses a manifest named other than the catalog lists; otherwise it is the import unchanged', () => {
    const imp = run('---\nname: real\ndescription: d\n---\n')
    expect(importAs(imp, 'listed')).toMatchObject({ ok: false, error: 'The catalog lists "listed" but its SKILL.md is named "real".' })
    expect(importAs(imp, 'real')).toBe(imp)
    expect(importAs(imp)).toBe(imp)
  })
})
