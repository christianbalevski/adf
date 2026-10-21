/**
 * Studio and adf both change cli-remotes.json (review item 10): every change
 * is a read-modify-write under one lockfile (updateRemotes), shared by the
 * CLI and Studio, so neither loses the other's change. A lock left by a
 * process that died is taken over after its stale time.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
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
      saveConnection(e, { url: 'http://100.101.102.103:7385', token: 'adfd_x', fingerprint: 'ABCD-EFGH', hostName: 'box-1', deviceId: 'd', label: 'l' }),
      runRemotes(['use', 'desk'], { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env: e }),
    ])
    const file = loadRemotes(e)
    expect(Object.keys(file.remotes).sort()).toEqual(['box-1', 'desk'])
    expect(file.default).toBe('desk')
    await Promise.all([forgetConnection(e, 'box-1'), runRemotes(['use', 'local'], { stdout: () => {}, stderr: () => {}, env: e })])
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

  it('two waiters that both saw the stale lock: one takes it over, the other never deletes the new holder\'s lock (re-review 2)', async () => {
    const e = env()
    const lock = join(e.ADF_DAEMON_SETTINGS!, '..', 'cli-remotes.json.lock')
    writeFileSync(lock, '4242 dead')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const arrived: string[] = []
    const gates: Record<string, () => void> = {}
    const seen = (id: string) => () => new Promise<void>((r) => { arrived.push(id); gates[id] = r })
    let inside = 0
    let maxInside = 0
    let releaseA!: () => void
    const order: string[] = []
    const change = (id: string, hold?: Promise<void>) => async (file: { remotes: Record<string, SavedRemote> }) => {
      inside++
      maxInside = Math.max(maxInside, inside)
      order.push(`${id} in`)
      await hold
      file.remotes[id] = remote(id)
      order.push(`${id} out`)
      inside--
    }
    const holdA = new Promise<void>((r) => { releaseA = r })
    const a = updateRemotes(e, change('a', holdA), { onStaleSeen: seen('a') })
    const b = updateRemotes(e, change('b'), { onStaleSeen: seen('b') })
    const until = async (check: () => boolean) => { const end = Date.now() + 2_000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) } }
    await until(() => arrived.length === 2)
    gates.a()
    await until(() => order.includes('a in'))
    const heldByA = readFileSync(lock, 'utf8')
    gates.b()
    await new Promise((r) => setTimeout(r, 100))
    // b saw the stale lock too, but a's lock is still there and b waits.
    expect(readFileSync(lock, 'utf8')).toBe(heldByA)
    expect(order).toEqual(['a in'])
    releaseA()
    await Promise.all([a, b])
    expect(order).toEqual(['a in', 'a out', 'b in', 'b out'])
    expect(maxInside).toBe(1)
    expect(Object.keys(loadRemotes(e).remotes).sort()).toEqual(['a', 'b'])
    expect(existsSync(lock)).toBe(false)
  })

  it('five processes on a stale lock: one holder at a time, every change lands (re-review 2)', async () => {
    const e = env()
    const dir = join(e.ADF_DAEMON_SETTINGS!, '..')
    const lock = join(dir, 'cli-remotes.json.lock')
    writeFileSync(lock, '4242 dead')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const worker = join(__dirname, 'fixtures', 'remotes-lock-worker.ts')
    const run = (id: number) => new Promise<number>((resolve, reject) => {
      const child = spawn('node', ['--import', 'tsx', worker, dir, String(id), '8'], { cwd: join(__dirname, '../..'), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
      let err = ''
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`worker ${id} exited ${code}: ${err}`))))
    })
    await Promise.all([0, 1, 2, 3, 4].map(run))
    expect(existsSync(join(dir, 'violations')) ? readFileSync(join(dir, 'violations'), 'utf8') : '').toBe('')
    expect(Object.keys(loadRemotes(e).remotes)).toHaveLength(40)
    expect(existsSync(lock)).toBe(false)
  }, 120_000)

  it('a change that throws writes nothing and releases the lock', async () => {
    const e = env()
    await expect(updateRemotes(e, (file) => { file.remotes.x = remote('X'); throw new Error('no') })).rejects.toThrow('no')
    expect(loadRemotes(e).remotes).toEqual({})
    await updateRemotes(e, (file) => { file.remotes.y = remote('Y') })
    expect(Object.keys(loadRemotes(e).remotes)).toEqual(['y'])
  })
})
