import { describe, expect, it } from 'vitest'
import {
  RESERVED_SEED_FILE_PATHS,
  TEMPLATE_EXTRA_FILE_MAX_BYTES,
  validateTemplateFilePath,
} from '../src/shared/utils/agent-template'

describe('validateTemplateFilePath', () => {
  it('accepts plain relative paths', () => {
    expect(validateTemplateFilePath('notes.txt')).toBeNull()
    expect(validateTemplateFilePath('docs/guide.pdf')).toBeNull()
    expect(validateTemplateFilePath('a/b/c.bin')).toBeNull()
    expect(validateTemplateFilePath('.env.example')).toBeNull()
    expect(validateTemplateFilePath('  spaced.md  ')).toBeNull()
  })

  it('rejects empty paths', () => {
    expect(validateTemplateFilePath('')).toMatch(/required/i)
    expect(validateTemplateFilePath('   ')).toMatch(/required/i)
  })

  it('rejects absolute paths and drive letters', () => {
    expect(validateTemplateFilePath('/etc/passwd')).toMatch(/relative/i)
    expect(validateTemplateFilePath('C:/x.txt')).toMatch(/relative/i)
    expect(validateTemplateFilePath('c:x.txt')).toMatch(/relative/i)
  })

  it('rejects backslashes', () => {
    expect(validateTemplateFilePath('docs\\guide.pdf')).toMatch(/forward slashes/i)
  })

  it('rejects traversal, dot and empty segments, and trailing slashes', () => {
    expect(validateTemplateFilePath('../x.txt')).toMatch(/segments/i)
    expect(validateTemplateFilePath('a/../x.txt')).toMatch(/segments/i)
    expect(validateTemplateFilePath('./x.txt')).toMatch(/segments/i)
    expect(validateTemplateFilePath('a//x.txt')).toMatch(/segments/i)
    expect(validateTemplateFilePath('dir/')).toMatch(/name a file/i)
  })

  it('rejects control characters', () => {
    expect(validateTemplateFilePath('a\u0000b.txt')).toMatch(/control/i)
    expect(validateTemplateFilePath('a\nb.txt')).toMatch(/control/i)
  })

  it('rejects the reserved seed files, case-insensitively', () => {
    expect([...RESERVED_SEED_FILE_PATHS]).toEqual(['README.md', 'mind.md', 'mind/log.md', 'soul.md'])
    for (const reserved of RESERVED_SEED_FILE_PATHS) {
      expect(validateTemplateFilePath(reserved)).toMatch(/created by the agent/i)
      expect(validateTemplateFilePath(reserved.toUpperCase())).toMatch(/created by the agent/i)
    }
    // Same names in a subdirectory are fine.
    expect(validateTemplateFilePath('docs/README.md')).toBeNull()
    expect(validateTemplateFilePath('mind/notes.md')).toBeNull()
  })

  it('rejects collisions with other template files, case-insensitively and trimmed', () => {
    expect(validateTemplateFilePath('a.txt', ['b.txt'])).toBeNull()
    expect(validateTemplateFilePath('a.txt', ['A.TXT'])).toMatch(/already uses/i)
    expect(validateTemplateFilePath('a.txt', [' a.txt '])).toMatch(/already uses/i)
  })

  it('exposes a 25 MB single-file cap', () => {
    expect(TEMPLATE_EXTRA_FILE_MAX_BYTES).toBe(25 * 1024 * 1024)
  })
})
