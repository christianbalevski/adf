// The daemon's local proof file is readable by the current user only
// (local-access.ts mintLocalProof): mode 0600 on POSIX, an explicit ACL on
// Windows, where the folder's inherited ACL depends on where the settings
// live (ADF_USER_DATA_DIR, a custom settings path).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mintLocalProof, readLocalProof, restrictToCurrentUserWindows } from '../src/main/daemon/local-access'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'adf-local-proof-')); dirs.push(d); return d }

describe('local proof file permissions', () => {
  it('asks icacls for the current user only, with inheritance removed', () => {
    const calls: Array<{ file: string; args: string[] }> = []
    restrictToCurrentUserWindows('C:\\x\\daemon-local-proof', (file, args) => { calls.push({ file, args }) })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('icacls')
    expect(calls[0].args.slice(0, 3)).toEqual(['C:\\x\\daemon-local-proof', '/inheritance:r', '/grant:r'])
    expect(calls[0].args[3]).toMatch(/:F$/)
  })

  it.runIf(process.platform === 'win32')('Windows: the written proof carries an explicit ACL granting only the current user', () => {
    const dir = tempDir()
    const { proof, path } = mintLocalProof(dir, 47999)
    expect(readLocalProof(dir, 47999)).toBe(proof)
    const acl = execFileSync('icacls', [path], { encoding: 'utf-8', windowsHide: true })
    // One entry per line after the path; none inherited ("(I)"), only this user, full control.
    const entries = acl.replace(path, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Successfully processed/i.test(l))
    expect(entries.length).toBe(1)
    expect(entries[0]).not.toContain('(I)')
    expect(entries[0].toLowerCase()).toContain(userInfo().username.toLowerCase())
    expect(entries[0]).toContain('(F)')
    // A second mint (the next daemon run) rewrites it under the same ACL.
    const again = mintLocalProof(dir, 47999)
    expect(readFileSync(again.path, 'utf-8').trim()).toBe(again.proof)
  })

  it.runIf(process.platform !== 'win32')('POSIX: mode 0600', () => {
    const { path } = mintLocalProof(tempDir(), 47999)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
