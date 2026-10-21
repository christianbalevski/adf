/**
 * A cli-remotes.json that cannot be read or parsed is not "no saved remotes"
 * (G2): nothing writes over it, and adf says which file to fix instead of
 * acting on an empty list.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { readRemotes, readRemotesAsync, RemotesUnreadableError, remotesFilePath, selectedRemote, updateRemotes } from '../../src/main/cli/remotes'
import { runPair, runRemotes } from '../../src/main/cli/pair'
import { savedConnectionNames } from '../../src/main/backend/runtime-migration'
import { forgetConnection, remotesEnv, saveConnection } from '../../src/main/backend/connections'

const CORRUPT = '{"v": 1, "remotes": {"agent-1": {"url": "http://100.64.0.1:7385"'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-remotes-unreadable-'))
  dirs.push(dir)
  // Never the real keychain.
  const env: NodeJS.ProcessEnv = { ...remotesEnv(dir), ADF_KEYCHAIN: '0' }
  delete env[ 'ADF_REMOTE' ]
  const path = remotesFilePath(env)
  writeFileSync(path, text)
  return { env, path, bytes: () => readFileSync(path, 'utf8') }
}

function io(env: NodeJS.ProcessEnv) {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), env } }
}

const entry = { url: 'http://100.64.0.2:7385', fingerprint: 'AGNT-2345', deviceId: 'dev-1', label: 'agent-1 laptop', pairedAt: '2026-10-01T00:00:00.000Z' }

describe('an unreadable cli-remotes.json', () => {
  it('updateRemotes refuses to write over it, naming the file; its bytes stay', async () => {
    const s = setup(CORRUPT)
    const error = await updateRemotes(s.env, (file) => { file.remotes['agent-2'] = entry }).catch((e) => e)
    expect(error).toBeInstanceOf(RemotesUnreadableError)
    expect(String(error.message)).toContain(s.path)
    expect(s.bytes()).toBe(CORRUPT)
  })

  it('a file that is not a remotes file is refused the same way', async () => {
    const s = setup('{"v": 2, "remotes": []}')
    await expect(updateRemotes(s.env, (file) => { file.default = null })).rejects.toBeInstanceOf(RemotesUnreadableError)
    expect(s.bytes()).toBe('{"v": 2, "remotes": []}')
  })

  it('adf remotes, use and forget fail with the file named, and change nothing', async () => {
    const s = setup(CORRUPT)
    for (const args of [[], ['list'], ['use', 'local'], ['forget', 'agent-1']]) {
      const c = io(s.env)
      expect(await runRemotes(args, c.io), args.join(' ')).toBe(1)
      expect(c.err.join(''), args.join(' ')).toContain(s.path)
      expect(c.out.join(''), args.join(' ')).toBe('')
    }
    const json = io(s.env)
    expect(await runRemotes([], json.io, true)).toBe(1)
    expect(json.err.join('')).toContain(s.path)
    expect(s.bytes()).toBe(CORRUPT)
  })

  it('adf pair stops before it contacts any computer', async () => {
    const s = setup(CORRUPT)
    const fetchSpy = vi.fn(async () => new Response('{}'))
    const c = io(s.env)
    const exit = await runPair(['100.64.0.2'], { ...c.io, fetch: fetchSpy as unknown as typeof fetch, prompt: async () => null, sleep: async () => {} })
    expect(exit).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(c.err.join('')).toContain(s.path)
    expect(s.bytes()).toBe(CORRUPT)
  })

  it('choosing the remote for a command fails, naming the file, instead of using this computer', () => {
    const s = setup(CORRUPT)
    expect(() => selectedRemote(s.env)).toThrow(s.path)
    // ADF_REMOTE=local needs no list.
    expect(selectedRemote({ ...s.env, ADF_REMOTE: 'local' })).toBeNull()
  })

  it('adf and the terminal app say which file to fix (no usage text), and talk to no daemon', async () => {
    const s = setup(CORRUPT)
    const saved = { settings: process.env.ADF_DAEMON_SETTINGS, url: process.env.ADF_DAEMON_URL, remote: process.env.ADF_REMOTE }
    process.env.ADF_DAEMON_SETTINGS = s.env.ADF_DAEMON_SETTINGS
    delete process.env.ADF_DAEMON_URL
    delete process.env.ADF_REMOTE
    try {
      const { runCli } = await import('../../src/main/cli/index')
      const fetchSpy = vi.fn(async () => new Response('{}'))
      const launchTui = vi.fn(async () => 0)
      for (const argv of [['status'], []]) {
        const c = io(s.env)
        const exit = await runCli(argv, { ...c.io, fetch: fetchSpy as unknown as typeof fetch, launchTui, ensureDaemon: async () => null })
        expect(exit, argv.join(' ')).toBe(1)
        expect(c.err.join(''), argv.join(' ')).toContain(s.path)
        expect(c.err.join(''), argv.join(' ')).not.toMatch(/Usage/i)
      }
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(launchTui).not.toHaveBeenCalled()
    } finally {
      for (const [key, value] of [['ADF_DAEMON_SETTINGS', saved.settings], ['ADF_DAEMON_URL', saved.url], ['ADF_REMOTE', saved.remote]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(s.bytes()).toBe(CORRUPT)
  })

  it('Studio Add and Remove refuse the same way', async () => {
    const s = setup(CORRUPT)
    await expect(saveConnection(s.env, { url: entry.url, token: 'adfd_' + 'q'.repeat(40), fingerprint: entry.fingerprint, hostName: 'agent-2', deviceId: 'dev-1', label: 'agent-1 laptop' }, { confirmFile: async () => true })).rejects.toBeInstanceOf(RemotesUnreadableError)
    await expect(forgetConnection(s.env, 'agent-1')).rejects.toBeInstanceOf(RemotesUnreadableError)
    expect(s.bytes()).toBe(CORRUPT)
  })

  it('one reader: sync, async and the names agree on what is unreadable', async () => {
    const s = setup(CORRUPT)
    const sync = readRemotes(s.env)
    const async_ = await readRemotesAsync(s.env)
    expect(sync.unreadable).toContain(s.path)
    expect(async_.unreadable).toBe(sync.unreadable)
    expect(await savedConnectionNames(s.env)).toBeNull()
  })

  // F6 (review round 3): a default that names a malformed entry is not "no default".
  it('a default naming a malformed entry: adf refuses with its sentence instead of using this computer; adf remotes does not mark local', async () => {
    const text = JSON.stringify({ v: 1, default: 'lab', remotes: { lab: { url: 42 }, 'agent-1': entry } })
    const s = setup(text)
    const sentence = `"lab" in ${s.path} is malformed and is not used; fix it, or remove it with: adf remotes forget lab`
    expect(readRemotes(s.env)).toMatchObject({ malformed: ['lab'], malformedDefault: 'lab', file: { default: null } })
    expect(() => selectedRemote(s.env)).toThrow(sentence)
    expect(() => selectedRemote({ ...s.env, ADF_REMOTE: 'lab' })).toThrow(sentence)
    expect(selectedRemote({ ...s.env, ADF_REMOTE: 'agent-1' })?.remote.url).toBe(entry.url)
    expect(selectedRemote({ ...s.env, ADF_REMOTE: 'local' })).toBeNull()
    const { resolveDaemonUrl } = await import('../../src/main/cli/daemon-url')
    expect(() => resolveDaemonUrl(undefined, s.env)).toThrow(sentence)

    // The local row is named as in Studio: the runtime alias of the daemon's settings, `<name> (Local)`.
    writeFileSync(s.env.ADF_DAEMON_SETTINGS!, JSON.stringify({ runtimeAlias: 'host-0' }))
    const list = io(s.env)
    expect(await runRemotes([], list.io)).toBe(0)
    expect(list.out.join('')).toContain('  local  host-0 (Local)\n')
    expect(list.out.join('')).not.toContain('* local')
    expect(list.err.join('')).toBe(`* ${sentence}\n`)

    // adf and the terminal app: the sentence, no usage text, no daemon.
    const saved = { settings: process.env.ADF_DAEMON_SETTINGS, url: process.env.ADF_DAEMON_URL, remote: process.env.ADF_REMOTE }
    process.env.ADF_DAEMON_SETTINGS = s.env.ADF_DAEMON_SETTINGS
    delete process.env.ADF_DAEMON_URL
    delete process.env.ADF_REMOTE
    try {
      const { runCli } = await import('../../src/main/cli/index')
      const fetchSpy = vi.fn(async () => new Response('{}'))
      const launchTui = vi.fn(async () => 0)
      for (const argv of [['status'], []]) {
        const c = io(s.env)
        expect(await runCli(argv, { ...c.io, fetch: fetchSpy as unknown as typeof fetch, launchTui, ensureDaemon: async () => null }), argv.join(' ')).toBe(1)
        expect(c.err.join(''), argv.join(' ')).toBe(`${sentence}\n`)
      }
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(launchTui).not.toHaveBeenCalled()
    } finally {
      for (const [key, value] of [['ADF_DAEMON_SETTINGS', saved.settings], ['ADF_DAEMON_URL', saved.url], ['ADF_REMOTE', saved.remote]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    // Choosing another default (or local) clears it; nothing else in the file changes.
    expect(await runRemotes(['use', 'local'], io(s.env).io)).toBe(0)
    expect(readRemotes(s.env).malformedDefault).toBeNull()
    expect(JSON.parse(s.bytes()).remotes.lab).toEqual({ url: 42 })
  })

  it('a byte-order mark is read, by every reader', async () => {
    const s = setup(`${String.fromCharCode(0xfeff)}${JSON.stringify({ v: 1, default: null, remotes: { 'agent-1': entry } })}`)
    expect(readRemotes(s.env).unreadable).toBeNull()
    expect(Object.keys(readRemotes(s.env).file.remotes)).toEqual(['agent-1'])
    expect(Object.keys((await readRemotesAsync(s.env)).file.remotes)).toEqual(['agent-1'])
    expect(await savedConnectionNames(s.env)).toEqual(new Set(['agent-1']))
  })
})
