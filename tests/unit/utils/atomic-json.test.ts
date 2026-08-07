import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ctl = vi.hoisted(() => ({
  /** Error codes consumed one per renameSync call; empty → real rename. */
  renameFailCodes: [] as string[],
  /** When set, every renameSync call fails with this code. */
  renameFailAlways: null as string | null,
  copyFail: false,
  renameCalls: 0,
}))

function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  err.code = code
  return err
}

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      ctl.renameCalls++
      const code = ctl.renameFailAlways ?? ctl.renameFailCodes.shift()
      if (code) throw errnoError(code)
      return real.renameSync(from, to)
    },
    copyFileSync: (from: string, to: string) => {
      if (ctl.copyFail) throw errnoError('EPERM')
      return real.copyFileSync(from, to)
    },
  }
})

import { writeJsonAtomic, readJsonOrQuarantine } from '../../../src/main/utils/atomic-json'

let dir: string
let file: string

function tmpFilesIn(directory: string): string[] {
  return readdirSync(directory).filter((n) => n.endsWith('.tmp'))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-atomic-json-'))
  file = join(dir, 'settings.json')
  ctl.renameFailCodes = []
  ctl.renameFailAlways = null
  ctl.copyFail = false
  ctl.renameCalls = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('round-trips JSON and leaves no temp files behind', () => {
    writeJsonAtomic(file, { a: 1, nested: { b: 'x' } })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ a: 1, nested: { b: 'x' } })
    expect(tmpFilesIn(dir)).toEqual([])
  })

  it('retries the rename on EPERM and succeeds without a fallback write', () => {
    writeFileSync(file, JSON.stringify({ old: true }), 'utf-8')
    ctl.renameFailCodes = ['EPERM', 'EPERM']
    writeJsonAtomic(file, { fresh: true })
    expect(ctl.renameCalls).toBe(3)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ fresh: true })
    expect(tmpFilesIn(dir)).toEqual([])
  })

  it('falls back to a direct write when the destination stays locked (Windows open-destination EPERM)', () => {
    writeFileSync(file, JSON.stringify({ old: true }), 'utf-8')
    ctl.renameFailAlways = 'EPERM'
    writeJsonAtomic(file, { fresh: true })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ fresh: true })
    expect(tmpFilesIn(dir)).toEqual([])
  })

  it('rethrows non-retryable rename errors and removes its temp file', () => {
    ctl.renameFailCodes = ['ENOSPC']
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow()
    expect(existsSync(file)).toBe(false)
    expect(tmpFilesIn(dir)).toEqual([])
  })

  it('uses a process-unique temp name, not the fixed `${path}.tmp`', () => {
    // A pre-existing fixed-name tmp (e.g. another process mid-write) must
    // never be touched as our write buffer.
    const fixedTmp = `${file}.tmp`
    writeFileSync(fixedTmp, 'someone elses half-written bytes', 'utf-8')
    writeJsonAtomic(file, { ok: 1 })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ ok: 1 })
    // Fresh foreign tmp is left alone (not stale yet)
    expect(readFileSync(fixedTmp, 'utf-8')).toBe('someone elses half-written bytes')
  })

  it('cleans up stale temp files older than an hour but keeps fresh ones', () => {
    const stale = `${file}.4242.dead0000.tmp`
    const fresh = `${file}.4343.live0000.tmp`
    writeFileSync(stale, '{}', 'utf-8')
    writeFileSync(fresh, '{}', 'utf-8')
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    utimesSync(stale, twoHoursAgo, twoHoursAgo)
    writeJsonAtomic(file, { ok: 1 })
    const remaining = tmpFilesIn(dir)
    expect(remaining).not.toContain(`settings.json.4242.dead0000.tmp`)
    expect(remaining).toContain(`settings.json.4343.live0000.tmp`)
  })

  it.skipIf(process.platform === 'win32')('creates new files with mode 0600 and preserves an existing mode', () => {
    writeJsonAtomic(file, { secret: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const open = join(dir, 'open.json')
    writeFileSync(open, '{}', { mode: 0o644 })
    writeJsonAtomic(open, { v: 2 })
    expect(statSync(open).mode & 0o777).toBe(0o644)
  })
})

describe('readJsonOrQuarantine', () => {
  it('returns parsed data for a valid file', () => {
    writeFileSync(file, JSON.stringify({ a: 1 }), 'utf-8')
    expect(readJsonOrQuarantine(file)).toEqual({ data: { a: 1 }, quarantinedTo: null, corruptUnpreserved: false })
  })

  it('moves a corrupt file aside and reports the quarantine path', () => {
    writeFileSync(file, 'not json {{', 'utf-8')
    const result = readJsonOrQuarantine(file)
    expect(result.data).toBeNull()
    expect(result.corruptUnpreserved).toBe(false)
    expect(result.quarantinedTo).toMatch(/corrupt-/)
    expect(existsSync(result.quarantinedTo!)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(result.quarantinedTo!, 'utf-8')).toBe('not json {{')
  })

  it('copies the corrupt file aside when the rename fails (file held open)', () => {
    writeFileSync(file, 'not json {{', 'utf-8')
    ctl.renameFailAlways = 'EPERM'
    const result = readJsonOrQuarantine(file)
    expect(result.data).toBeNull()
    expect(result.corruptUnpreserved).toBe(false)
    expect(result.quarantinedTo).toMatch(/corrupt-/)
    expect(readFileSync(result.quarantinedTo!, 'utf-8')).toBe('not json {{')
    // Original stays in place — but its bytes are preserved in the copy.
    expect(existsSync(file)).toBe(true)
  })

  it('flags corruptUnpreserved when the corrupt file can be neither moved nor copied', () => {
    writeFileSync(file, 'not json {{', 'utf-8')
    ctl.renameFailAlways = 'EPERM'
    ctl.copyFail = true
    const result = readJsonOrQuarantine(file)
    expect(result).toEqual({ data: null, quarantinedTo: null, corruptUnpreserved: true })
    expect(readFileSync(file, 'utf-8')).toBe('not json {{')
  })
})
