/**
 * Studio and adf both change cli-remotes.json (review item 10): every change
 * is a read-modify-write under one lockfile (updateRemotes), shared by the
 * CLI and Studio, so neither loses the other's change. A lock left by a
 * process that died is taken over after its stale time.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRemotes, RemotesLockedError, updateRemotes, type SavedRemote } from '../../src/main/cli/remotes'
import { runRemotes } from '../../src/main/cli/pair'
import { forgetConnection, remotesEnv, saveConnection } from '../../src/main/backend/connections'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function env(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'adf-remotes-lock-'))
  dirs.push(dir)
  const e = { ...remotesEnv(dir), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
  delete e.ADF_KEYCHAIN
  return e
}
const remote = (fingerprint: string): SavedRemote => ({ url: `http://100.64.0.${fingerprint.length}:7385`, fingerprint, deviceId: 'd', label: 'l', pairedAt: '' })

describe('updateRemotes: one lock for Studio and adf', () => {
  it('twenty concurrent changes all land', async () => {
    const e = env()
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateRemotes(e, (file) => { file.remotes[`r${i}`] = remote(`FP${i}`) })))
    expect(Object.keys(loadRemotes(e).remotes).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `r${i}`).sort())
  })

  it('a Studio pairing and an adf command at the same time: both changes are kept', async () => {
    const e = env()
    await updateRemotes(e, (file) => { file.remotes.desk = remote('DESK-2345') })
    const out: string[] = []
    await Promise.all([
      saveConnection(e, { url: 'http://100.101.102.103:7385', token: 'adfd_x', fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: 'd', label: 'l' }),
      runRemotes(['use', 'desk'], { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env: e }),
    ])
    const file = loadRemotes(e)
    expect(Object.keys(file.remotes).sort()).toEqual(['desk', 'rawl-hub'])
    expect(file.default).toBe('desk')
    await Promise.all([forgetConnection(e, 'rawl-hub'), runRemotes(['use', 'local'], { stdout: () => {}, stderr: () => {}, env: e })])
    expect(loadRemotes(e)).toMatchObject({ default: null, remotes: { desk: { fingerprint: 'DESK-2345' } } })
  })

  it('a lock held by another program waits, then says so; a stale one is taken over', async () => {
    const e = env()
    const lock = join(e.ADF_DAEMON_SETTINGS!, '..', 'cli-remotes.json.lock')
    writeFileSync(lock, '4242 now')
    await expect(updateRemotes(e, (file) => { file.default = null }, { waitMs: 100 })).rejects.toBeInstanceOf(RemotesLockedError)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    await updateRemotes(e, (file) => { file.remotes.desk = remote('DESK-2345') })
    expect(Object.keys(loadRemotes(e).remotes)).toEqual(['desk'])
  })

  it('Windows: EPERM while the lock is being recreated is retried with the same deadline, never a raw EPERM (re-review 1)', async () => {
    const e = env()
    const real = (await import('node:fs/promises')).open
    let calls = 0
    const eperm = () => Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' })
    const flaky = (async (path: string, flags: string) => { if (++calls <= 3) throw eperm(); return real(path, flags) }) as typeof real
    await updateRemotes(e, (file) => { file.remotes.desk = remote('DESK-2345') }, { platform: 'win32', openLock: flaky })
    expect(calls).toBe(4)
    expect(Object.keys(loadRemotes(e).remotes)).toEqual(['desk'])
    const always = (async () => { throw eperm() }) as unknown as typeof real
    await expect(updateRemotes(e, (file) => { file.default = null }, { platform: 'win32', openLock: always, waitMs: 150 })).rejects.toBeInstanceOf(RemotesLockedError)
    // Elsewhere EPERM is a real permission problem: said as it is.
    await expect(updateRemotes(e, (file) => { file.default = null }, { platform: 'linux', openLock: always, waitMs: 150 })).rejects.toMatchObject({ code: 'EPERM' })
  })

  it('a change that throws writes nothing and releases the lock', async () => {
    const e = env()
    await expect(updateRemotes(e, (file) => { file.remotes.x = remote('X'); throw new Error('no') })).rejects.toThrow('no')
    expect(loadRemotes(e).remotes).toEqual({})
    await updateRemotes(e, (file) => { file.remotes.y = remote('Y') })
    expect(Object.keys(loadRemotes(e).remotes)).toEqual(['y'])
  })
})
