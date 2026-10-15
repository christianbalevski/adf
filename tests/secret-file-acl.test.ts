// Secret files are readable by the current user only on every write (W5-D1):
// the daemon token, runtime-enc-key, runtime-enc-key.revoked and
// credential.key. Mode 0600 on POSIX; on Windows an explicit ACL (icacls,
// inheritance removed), as the local proof file has had since W3-B.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDaemonToken } from '../src/main/daemon/daemon-token'
import { ensureDaemonEncKey, rotateDaemonEncKey } from '../src/main/daemon/daemon-enc-key'
import { getCredentialKey } from '../src/main/utils/credential-cipher'
import { protectSecretFile } from '../src/main/utils/secret-file'

const dirs: string[] = []
const savedUserData = process.env.ADF_USER_DATA_DIR
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  process.env.ADF_USER_DATA_DIR = savedUserData
})
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'adf-secret-file-')); dirs.push(d); return d }

/** The file grants only the current user (Windows: one explicit, non-inherited full-control entry; POSIX: 0600). */
function expectOwnerOnly(path: string): void {
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777, path).toBe(0o600)
    return
  }
  const acl = execFileSync('icacls', [path], { encoding: 'utf-8', windowsHide: true })
  const entries = acl.replace(path, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Successfully processed/i.test(l))
  expect(entries, path).toHaveLength(1)
  expect(entries[0]).not.toContain('(I)')
  expect(entries[0].toLowerCase()).toContain(userInfo().username.toLowerCase())
  expect(entries[0]).toContain('(F)')
}

describe('secret files: current user only on every write', () => {
  it('daemon-token, when minted and when a malformed one is replaced', () => {
    const dir = tempDir()
    const minted = ensureDaemonToken(dir)
    expect(minted.created).toBe(true)
    expectOwnerOnly(minted.path)
    writeFileSync(minted.path, 'not a token\n')
    const replaced = ensureDaemonToken(dir)
    expect(replaced.created).toBe(true)
    expectOwnerOnly(replaced.path)
  })

  it('runtime-enc-key when minted and rotated, and runtime-enc-key.revoked', () => {
    const dir = tempDir()
    const key = ensureDaemonEncKey(dir)
    expectOwnerOnly(key.keyPath)
    const { key: next } = rotateDaemonEncKey(dir)
    expectOwnerOnly(next.keyPath)
    expectOwnerOnly(join(dir, 'runtime-enc-key.revoked'))
  })

  it('credential.key (Studio and the daemon)', () => {
    const dir = tempDir()
    process.env.ADF_USER_DATA_DIR = dir
    getCredentialKey()
    expectOwnerOnly(join(dir, 'credential.key'))
  })

  it('a failed restriction is logged with the path and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = protectSecretFile('C:\\x\\daemon-token', { platform: 'win32', run: () => { throw new Error('icacls exited with code 5') } })
    expect(ok).toBe(false)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Could not restrict C:\\x\\daemon-token to the current user: icacls exited with code 5'))).toBe(true)
    warn.mockRestore()
  })
})
