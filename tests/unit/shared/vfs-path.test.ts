import { describe, expect, it } from 'vitest'
import { VFS_PATH_MAX_LENGTH, vfsPathProblem } from '../../../src/shared/utils/vfs-path'

describe('vfsPathProblem', () => {
  it('accepts relative forward-slash paths', () => {
    for (const path of ['a.md', 'skills/a/SKILL.md', 'x/.hidden/y', 'a..b/c', 'x'.repeat(VFS_PATH_MAX_LENGTH)]) {
      expect(vfsPathProblem(path)).toBeNull()
    }
  })

  it('refuses empty, overlong, absolute, backslash and control-character paths', () => {
    expect(vfsPathProblem('')).toBe('Path is required.')
    expect(vfsPathProblem('x'.repeat(VFS_PATH_MAX_LENGTH + 1))).toBe(`Path is longer than ${VFS_PATH_MAX_LENGTH} characters.`)
    expect(vfsPathProblem('/etc/passwd')).toBe('Path must be relative.')
    expect(vfsPathProblem('a\\b.md')).toBe('Use forward slashes.')
    expect(vfsPathProblem('a\nb.md')).toBe('Path contains control characters.')
    expect(vfsPathProblem('a\u0000b')).toBe('Path contains control characters.')
    expect(vfsPathProblem('a\u007Fb')).toBe('Path contains control characters.')
  })

  it('refuses empty, "." and ".." segments', () => {
    for (const path of ['a//b', 'a/', './a', 'a/./b', '../a', 'a/../b', 'a/..']) {
      expect(vfsPathProblem(path)).toBe('Path may not contain empty, "." or ".." segments.')
    }
  })
})
