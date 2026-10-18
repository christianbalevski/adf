/**
 * Secret files are restricted before they hold anything (security review
 * item 9): remote-access.json, daemon-devices.json, the CLI's saved remotes
 * and tokens. When the restriction fails, nothing is written and the caller
 * is told; nobody reports "readable by you only" for a file that is not.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const acl = vi.hoisted(() => ({ fail: false, seenSizes: [] as number[] }))
vi.mock('../src/main/utils/secret-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/utils/secret-file')>()
  const { statSync: stat } = await import('node:fs')
  return {
    ...actual,
    restrictToCurrentUserWindows: (path: string) => {
      acl.seenSizes.push(stat(path).size)
      if (acl.fail) throw new Error('icacls refused')
    },
  }
})

import { SecretFileError, writeSecretFileAtomic } from '../src/main/utils/secret-write'
import { storeRemoteToken } from '../src/main/cli/remotes'
import { DeviceStore, DEVICES_FILENAME } from '../src/main/daemon/remote-access/device-store'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'adf-secret-write-'))
  dirs.push(d)
  return d
}
beforeEach(() => { acl.fail = false; acl.seenSizes = [] })

describe('writeSecretFileAtomic', () => {
  it('Windows: the ACL is set on the empty temp file, before any content', () => {
    const dir = tempDir()
    const path = join(dir, 'secret.json')
    writeSecretFileAtomic(path, '{"token":"adfd_x"}\n', 'win32')
    expect(acl.seenSizes).toEqual([0])
    expect(readFileSync(path, 'utf-8')).toBe('{"token":"adfd_x"}\n')
    expect(readdirSync(dir)).toEqual(['secret.json'])
  })

  it('a failed restriction writes nothing and says so', () => {
    const dir = tempDir()
    const path = join(dir, 'secret.json')
    acl.fail = true
    expect(() => writeSecretFileAtomic(path, 'secret', 'win32')).toThrow(SecretFileError)
    expect(() => writeSecretFileAtomic(path, 'secret', 'win32')).toThrow(/readable by the current user only: icacls refused/)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('POSIX: created with mode 0600', () => {
    const path = join(tempDir(), 'secret.json')
    writeSecretFileAtomic(path, 'secret')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe.runIf(process.platform === 'win32')('callers fail visibly (Windows)', () => {
  it('the CLI does not save a token it cannot restrict, and does not claim it did', () => {
    const dir = tempDir()
    const env = { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json'), ADF_KEYCHAIN: '0' }
    acl.fail = true
    expect(() => storeRemoteToken('ABCD-EFGH', `adfd_aaaaaaaaaa_${'b'.repeat(43)}`, env)).toThrow(SecretFileError)
    expect(readdirSync(dir)).toEqual([])
    acl.fail = false
    expect(storeRemoteToken('ABCD-EFGH', `adfd_aaaaaaaaaa_${'b'.repeat(43)}`, env)).toMatchObject({ where: 'file' })
    expect(acl.seenSizes.at(-1)).toBe(0)
  })

  it('the daemon issues no device token when its store cannot be restricted', () => {
    const dir = tempDir()
    const store = new DeviceStore(dir)
    acl.fail = true
    expect(() => store.create({ label: 'agent-2 laptop', origin: 'token', createdBy: 'cli' })).toThrow(SecretFileError)
    expect(store.list()).toEqual([])
    expect(existsSync(join(dir, DEVICES_FILENAME))).toBe(false)
  })
})
