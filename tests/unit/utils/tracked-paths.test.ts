import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as nodePath from 'path'
import { tmpdir } from 'os'
import {
  canonicalizePath,
  containsPath,
  isSameOrSubPath,
  dedupeTrackedDirectories
} from '../../../src/main/utils/tracked-paths'

const posix = { pathMod: nodePath.posix, caseInsensitive: false }
const posixCI = { pathMod: nodePath.posix, caseInsensitive: true }
const win32 = { pathMod: nodePath.win32, caseInsensitive: true }

describe('containsPath (posix)', () => {
  it('matches identical paths', () => {
    expect(containsPath('/home/x/agents', '/home/x/agents', posix)).toBe(true)
  })

  it('matches a direct child and a nested descendant', () => {
    expect(containsPath('/home/x/agents', '/home/x/agents/sub', posix)).toBe(true)
    expect(containsPath('/home/x/agents', '/home/x/agents/a/b/c.adf', posix)).toBe(true)
  })

  it('rejects siblings and parents', () => {
    expect(containsPath('/home/x/agents', '/home/x/other', posix)).toBe(false)
    expect(containsPath('/home/x/agents/sub', '/home/x/agents', posix)).toBe(false)
  })

  it('rejects a sibling whose name shares the prefix', () => {
    expect(containsPath('/home/x/agents', '/home/x/agents-backup', posix)).toBe(false)
  })

  it('handles a sibling directory starting with dots', () => {
    expect(containsPath('/a', '/a/..foo', posix)).toBe(true)
    expect(containsPath('/a', '/..foo', posix)).toBe(false)
  })

  it('is case-sensitive by default on posix, insensitive on macOS-like settings', () => {
    expect(containsPath('/home/x/Agents', '/home/x/agents/sub', posix)).toBe(false)
    expect(containsPath('/home/x/Agents', '/home/x/agents/sub', posixCI)).toBe(true)
  })
})

describe('containsPath (win32)', () => {
  it('matches subdirectories with backslash separators', () => {
    expect(containsPath('C:\\Users\\x\\agents', 'C:\\Users\\x\\agents\\sub', win32)).toBe(true)
  })

  it('matches across mixed separators', () => {
    expect(containsPath('C:\\Users\\x\\agents', 'C:/Users/x/agents/sub/a.adf', win32)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(containsPath('C:\\Users\\x\\Agents', 'c:\\users\\X\\agents\\sub', win32)).toBe(true)
  })

  it('rejects different drives and siblings', () => {
    expect(containsPath('C:\\agents', 'D:\\agents\\sub', win32)).toBe(false)
    expect(containsPath('C:\\Users\\x\\agents', 'C:\\Users\\x\\other', win32)).toBe(false)
  })
})

describe('canonicalizePath / isSameOrSubPath (real filesystem)', () => {
  const root = join(tmpdir(), `adf-tracked-paths-test-${process.pid}`)
  const realDir = join(root, 'real')
  const linkDir = join(root, 'link')
  let symlinksSupported = true

  beforeAll(() => {
    mkdirSync(join(realDir, 'sub'), { recursive: true })
    writeFileSync(join(realDir, 'sub', 'agent-1.adf'), '')
    try {
      symlinkSync(realDir, linkDir, 'junction')
    } catch {
      symlinksSupported = false
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('strips trailing separators via resolve', () => {
    expect(canonicalizePath(realDir + nodePath.sep)).toBe(canonicalizePath(realDir))
  })

  it('appends nonexistent segments to the canonicalized existing ancestor', () => {
    const ghost = join(root, 'does-not-exist', 'deep')
    expect(canonicalizePath(ghost)).toBe(join(canonicalizePath(root), 'does-not-exist', 'deep'))
  })

  it('treats a symlinked dir and its target as the same tree', () => {
    if (!symlinksSupported) return
    expect(isSameOrSubPath(linkDir, join(realDir, 'sub'))).toBe(true)
    expect(isSameOrSubPath(realDir, join(linkDir, 'sub', 'agent-1.adf'))).toBe(true)
  })

  it('detects containment for not-yet-existing children', () => {
    expect(isSameOrSubPath(realDir, join(realDir, 'new-sub', 'new.adf'))).toBe(true)
    expect(isSameOrSubPath(realDir, join(root, 'elsewhere', 'x.adf'))).toBe(false)
  })
})

describe('dedupeTrackedDirectories', () => {
  const root = join(tmpdir(), `adf-tracked-dedupe-test-${process.pid}`)
  const parent = join(root, 'agents')
  const sub = join(parent, 'team')
  const other = join(root, 'other')

  beforeAll(() => {
    mkdirSync(sub, { recursive: true })
    mkdirSync(other, { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('drops subdirectories of an earlier entry', () => {
    expect(dedupeTrackedDirectories([parent, sub, other])).toEqual([parent, other])
  })

  it('absorbs earlier entries when a parent appears later', () => {
    expect(dedupeTrackedDirectories([sub, other, parent])).toEqual([other, parent])
  })

  it('drops exact and trailing-separator duplicates', () => {
    expect(dedupeTrackedDirectories([parent, parent, parent + nodePath.sep])).toEqual([parent])
  })

  it('keeps unrelated directories', () => {
    expect(dedupeTrackedDirectories([parent, other])).toEqual([parent, other])
  })

  it('handles an empty list', () => {
    expect(dedupeTrackedDirectories([])).toEqual([])
  })
})
