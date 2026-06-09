import { describe, it, expect } from 'vitest'
import {
  collectInjectedFiles,
  resolveInjectedFiles,
  MISSING_FILE_SENTINEL,
} from '../../../src/main/runtime/prompt-file-injection'
import { DEFAULT_BASE_PROMPT, MIND_PROMPT_SECTION } from '../../../src/shared/constants/adf-defaults'

// A fake adf_files-only reader.
function makeReader(files: Record<string, string>) {
  const calls: string[] = []
  const read = (p: string): string | null => {
    calls.push(p)
    return p in files ? files[p] : null
  }
  return { read, calls }
}

describe('prompt file injection', () => {
  it('resolves {{path}} to file content', () => {
    const { read } = makeReader({ 'README.md': '# Hello', 'mind.md': 'memory' })
    const snap = new Map<string, string>()
    const out = resolveInjectedFiles('Intro\n{{README.md}}\n---\n{{mind.md}}', read, snap)
    expect(out).toBe('Intro\n# Hello\n---\nmemory')
  })

  it('renders a visible marker for a missing file (not silent empty)', () => {
    const { read } = makeReader({})
    const out = resolveInjectedFiles('see {{notes.md}}', read, new Map())
    expect(out).toBe('see [missing file: notes.md]')
  })

  it('is single-pass — placeholders inside injected content are not expanded', () => {
    const { read } = makeReader({ 'a.md': 'A includes {{b.md}}', 'b.md': 'SECRET' })
    const out = resolveInjectedFiles('{{a.md}}', read, new Map())
    expect(out).toBe('A includes {{b.md}}')
    expect(out).not.toContain('SECRET')
  })

  it('trims whitespace inside the braces', () => {
    const { read } = makeReader({ 'mind.md': 'm' })
    expect(resolveInjectedFiles('{{  mind.md  }}', read, new Map())).toBe('m')
  })

  it('snapshots each file once and reuses across calls (session stability)', () => {
    const files = { 'mind.md': 'v1' }
    const { read, calls } = makeReader(files)
    const snap = new Map<string, string>()

    expect(resolveInjectedFiles('{{mind.md}}', read, snap)).toBe('v1')
    // Mutate the underlying file mid-session — snapshot must NOT change.
    files['mind.md'] = 'v2'
    expect(resolveInjectedFiles('{{mind.md}}', read, snap)).toBe('v1')
    // Read happened once; the second resolve served from the snapshot.
    expect(calls.filter((c) => c === 'mind.md').length).toBe(1)

    // A fresh snapshot (session reset) picks up the new content.
    expect(resolveInjectedFiles('{{mind.md}}', read, new Map())).toBe('v2')
  })

  it('collectInjectedFiles returns sorted unique paths and snapshots them', () => {
    const { read } = makeReader({ 'b.md': 'B', 'a.md': 'A' })
    const snap = new Map<string, string>()
    const refs = collectInjectedFiles('{{b.md}} {{a.md}} {{b.md}} {{x.md}}', read, snap)
    expect(refs).toEqual(['a.md', 'b.md', 'x.md'])
    expect(snap.get('a.md')).toBe('A')
    expect(snap.get('b.md')).toBe('B')
    expect(snap.get('x.md')).toBe(MISSING_FILE_SENTINEL)
  })

  it('the default base prompt injects mind via the {{mind.md}} placeholder', () => {
    expect(MIND_PROMPT_SECTION).toContain('{{mind.md}}')
    expect(DEFAULT_BASE_PROMPT).toContain('{{mind.md}}')
  })
})

// Mirrors the settings migration's backfill logic (settings.service.ts).
function backfillMind(prompt: string): string {
  if (prompt.includes('{{mind.md}}')) return prompt
  return prompt.trimEnd() + MIND_PROMPT_SECTION
}

describe('globalSystemPrompt mind backfill', () => {
  it('appends the mind section to a custom prompt lacking the token', () => {
    const out = backfillMind('My custom prompt.')
    expect(out).toContain('My custom prompt.')
    expect(out).toContain('{{mind.md}}')
  })

  it('is idempotent when the token is already present', () => {
    const already = 'Custom with {{mind.md}} inline.'
    expect(backfillMind(already)).toBe(already)
  })
})
