import { describe, expect, it } from 'vitest'
import { planPackageWrite, preparePackageWrite, slotOf, type PackageIo } from '../../../src/shared/utils/skill-install-plan'
import { FILE_BATCH_MAX_BYTES } from '../../../src/shared/utils/file-batch'

/**
 * The one read protocol and plan every host installs through (Studio and the
 * terminal app). Bounds are not here: the batch decides them
 * (workspace-write-files-atomic.test.ts pins the exact edges).
 */

const res = (path: string, size = 3) => ({ path, contentBase64: Buffer.alloc(size).toString('base64'), size })
const none = new Map()

describe('planPackageWrite', () => {
  it('a fresh install: every file must not exist, SKILL.md last, slot free', () => {
    const plan = planPackageWrite('alpha', 'M', [res('a.md'), res('b/c.png')], none, ['skills/alphabet/SKILL.md'])
    expect(plan).toEqual({
      ok: true, name: 'alpha', replaces: [], keeps: [], occupied: false,
      files: [
        { path: 'skills/alpha/a.md', contentBase64: res('a.md').contentBase64, mustNotExist: true },
        { path: 'skills/alpha/b/c.png', contentBase64: res('b/c.png').contentBase64, mustNotExist: true },
        { path: 'skills/alpha/SKILL.md', content: 'M', mustNotExist: true },
      ],
    })
  })

  it('a replacement goes over the revisions read; extra files are listed as kept; read-only and unread revisions refuse', () => {
    const existing = new Map([
      ['skills/alpha/SKILL.md', { protection: 'none' as const, revision: 7 }],
      ['skills/alpha/a.md', { protection: 'no_delete' as const, revision: 9 }],
    ])
    const plan = planPackageWrite('alpha', 'M', [res('a.md'), res('new.md')], existing, ['skills/alpha/SKILL.md', 'skills/alpha/a.md', 'skills/alpha/mine.md', 'skills/alphabet/x.md'])
    expect(plan).toMatchObject({ ok: true, replaces: ['skills/alpha/a.md', 'skills/alpha/SKILL.md'], keeps: ['skills/alpha/mine.md'], occupied: true })
    if (!plan.ok) throw new Error()
    expect(plan.files.map((f) => [f.path, f.baseRevision ?? null, f.mustNotExist ?? null])).toEqual([
      ['skills/alpha/a.md', 9, null], ['skills/alpha/new.md', null, true], ['skills/alpha/SKILL.md', 7, null],
    ])
    expect(planPackageWrite('alpha', 'M', [res('a.md')], new Map([['skills/alpha/a.md', { protection: 'read_only' as const }]]), [])).toEqual({ ok: false, error: 'skills/alpha/a.md is read-only. Nothing was written.' })
    expect(planPackageWrite('alpha', 'M', [res('a.md')], new Map([['skills/alpha/a.md', { protection: 'none' as const }]]), [])).toEqual({ ok: false, error: 'skills/alpha/a.md exists and its revision could not be read. Nothing was written.' })
  })

  it('a slot holding only files the package does not ship is occupied: nothing is replaced, but it is not a fresh install', () => {
    const plan = planPackageWrite('alpha', 'M', [res('ref.md')], none, ['skills/alpha/scripts/run.py'])
    expect(plan).toMatchObject({ ok: true, replaces: [], keeps: ['skills/alpha/scripts/run.py'], occupied: true })
  })
})

describe('preparePackageWrite: the read protocol', () => {
  function io(files: Record<string, { protection?: 'none' | 'read_only' | 'no_delete'; revision?: number }>, fetched: Record<string, string> = {}) {
    const reads: string[] = []
    const fetches: string[] = []
    const value: PackageIo = {
      fetchBytes: async (url) => { fetches.push(url); return url in fetched ? { ok: true, contentBase64: Buffer.from(fetched[url]).toString('base64'), size: fetched[url].length } : { ok: false, error: 'HTTP 404' } },
      listFiles: async () => Object.entries(files).map(([path, f]) => ({ path, protection: f.protection ?? 'none' })),
      readRevision: async (path) => { reads.push(path); return files[path]?.revision },
    }
    return { value, reads, fetches }
  }

  it('fetches every resource, lists, and reads revisions only of the package\'s own paths that exist (a read-only one is not read)', async () => {
    const { value, reads } = io({ 'skills/a/SKILL.md': { revision: 3 }, 'skills/a/x.md': { protection: 'read_only' }, 'skills/b/SKILL.md': { revision: 4 } }, { 'https://r/x': 'x', 'https://r/y': 'y' })
    const plan = await preparePackageWrite(value, 'a', 'M', [{ path: 'x.md', raw_url: 'https://r/x' }, { path: 'y.md', raw_url: 'https://r/y' }])
    expect(plan).toEqual({ ok: false, error: 'skills/a/x.md is read-only. Nothing was written.' })
    expect(reads).toEqual(['skills/a/SKILL.md'])
  })

  it('a resource that fails to fetch ends it before anything is listed', async () => {
    const { value, reads } = io({}, {})
    expect(await preparePackageWrite(value, 'a', 'M', [{ path: 'x.md', raw_url: 'https://r/x' }])).toEqual({ ok: false, error: 'x.md: HTTP 404. Nothing was written.' })
    expect(reads).toEqual([])
  })

  it('bytes already in hand (a local package) are used as they are, not fetched', async () => {
    const { value, fetches } = io({})
    const plan = await preparePackageWrite(value, 'a', 'M', [res('local.bin', 2)])
    expect(fetches).toEqual([])
    expect(plan).toMatchObject({ ok: true, files: [{ path: 'skills/a/local.bin', contentBase64: res('local.bin', 2).contentBase64, mustNotExist: true }, { path: 'skills/a/SKILL.md', content: 'M', mustNotExist: true }] })
  })

  it('a checkpoint that answers stops it after the next await, with that answer', async () => {
    const { value } = io({}, { 'https://r/x': 'x' })
    let gone = false
    value.checkpoint = () => (gone ? 'view changed' : null)
    const fetch = value.fetchBytes
    value.fetchBytes = async (url) => { const r = await fetch(url); gone = true; return r }
    expect(await preparePackageWrite(value, 'a', 'M', [{ path: 'x.md', raw_url: 'https://r/x' }])).toEqual({ ok: false, error: 'view changed' })
  })

  // BI-F2: a catalog entry has no sizes, so 255 resources of 1 MiB were all fetched before the batch refused.
  it('keeps a running total and stops fetching once the batch bound is passed', async () => {
    const fetches: string[] = []
    const MiB = 1024 * 1024
    const value: PackageIo = {
      fetchBytes: async (url) => { fetches.push(url); return { ok: true, contentBase64: '', size: MiB } },
      listFiles: async () => { throw new Error('listed') },
      readRevision: async () => undefined,
    }
    const resources = Array.from({ length: 255 }, (_, i) => ({ path: `r${i}.bin`, raw_url: `https://r/${i}` }))
    expect(await preparePackageWrite(value, 'a', 'M', resources)).toEqual({ ok: false, error: `The package is past what one install writes: ${8 * MiB + 1} bytes in all (at most ${FILE_BATCH_MAX_BYTES}). Nothing was written.` })
    expect(fetches).toHaveLength(8)
  })
})

describe('slotOf: the one occupancy rule (plan, Studio badge, terminal label)', () => {
  it('any file under skills/<name>/ is in slot <name>; nothing else is', () => {
    expect(['skills/a/SKILL.md', 'skills/a/deep/x.bin', 'skills/a', 'skills-registry.json', 'notes/skills/a/x'].map(slotOf)).toEqual(['a', 'a', null, null, null])
  })
})
