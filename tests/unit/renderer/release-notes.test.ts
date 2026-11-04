import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { bundledReleaseNotes, markReleaseNotesSeen, needsAction, seenReleaseNotesVersion } from '../../../src/renderer/utils/release-notes'

describe('bundled release notes', () => {
  it('finds a version\'s notes from docs/release-notes, and none for a version without a file', () => {
    expect(bundledReleaseNotes('0.8.3')).toBe(readFileSync('docs/release-notes/v0.8.3.md', 'utf8').trim())
    expect(bundledReleaseNotes('0.0.1')).toBeNull()
    // The version is matched whole: 0.8.3 never answers for 0.8.30 or 10.8.3.
    expect(bundledReleaseNotes('0.8.30')).toBeNull()
  })

  it('needsAction is the "## Action needed" heading, nothing looser', () => {
    expect(needsAction('Intro.\n\n## Action needed\n\n- Sign in again.')).toBe(true)
    expect(needsAction('Intro.\n\n## action needed\n')).toBe(true)
    expect(needsAction('No action needed this time.')).toBe(false)
    expect(needsAction('### Action needed')).toBe(false)
  })
})

describe('notes seen', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('remembers the last version opened', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
    expect(seenReleaseNotesVersion()).toBeNull()
    markReleaseNotesSeen('0.8.8')
    expect(seenReleaseNotesVersion()).toBe('0.8.8')
  })

  it('storage that throws reads as never seen and never breaks the caller', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(seenReleaseNotesVersion()).toBeNull()
    expect(() => markReleaseNotesSeen('0.8.8')).not.toThrow()
  })
})
