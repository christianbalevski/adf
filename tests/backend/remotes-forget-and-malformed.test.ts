/**
 * `adf remotes forget` and a cli-remotes.json with one malformed entry.
 *
 * R2B-3: forget writes the list first, and deletes the token only when no
 * other saved name holds that computer (`adf pair <host> --as lab`). A list
 * that cannot be written (locked) keeps both the entry and its token.
 *
 * R2B-8: an entry that parses but is malformed is kept, byte for byte in
 * meaning, by every write of the list, and adf says which entry it is.
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { readRemoteToken, readRemotes, readRemotesAsync, remotesFilePath, storeRemoteToken, updateRemotes } from '../../src/main/cli/remotes'
import { runRemotes } from '../../src/main/cli/pair'
import { forgetConnection, remotesEnv, SavedConnectionsCache } from '../../src/main/backend/connections'
import { savedConnectionNames } from '../../src/main/backend/runtime-migration'

const FP = 'AGNT-2345'
const TOKEN = 'adfd_' + 't'.repeat(40)
const HOST_1 = { url: 'http://100.64.0.2:7385', fingerprint: FP, deviceId: 'dev-1', label: 'agent-1 laptop', pairedAt: '2026-10-01T00:00:00.000Z', hostName: 'host-1' }
const LAB = { ...HOST_1, url: 'https://host-1.tailnet.ts.net', deviceId: 'dev-2' }
/** Parses, but has no deviceId: not a usable entry. */
const MALFORMED = { url: 'http://100.64.0.3:7385', fingerprint: 'OTHR-6789', note: 'kept as written' }

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(remotes: Record<string, unknown>, def: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-remotes-forget-'))
  dirs.push(dir)
  // Never the real keychain: the user-only token file.
  const env: NodeJS.ProcessEnv = { ...remotesEnv(dir), ADF_KEYCHAIN: '0' }
  delete env.ADF_REMOTE
  const path = remotesFilePath(env)
  writeFileSync(path, JSON.stringify({ v: 1, default: def, remotes }, null, 2))
  return { env, path, json: () => JSON.parse(readFileSync(path, 'utf8')) as { default: string | null; remotes: Record<string, unknown> } }
}

function io(env: NodeJS.ProcessEnv) {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (t: string) => { out.push(t) }, stderr: (t: string) => { err.push(t) }, env } }
}

describe('adf remotes forget (R2B-3)', () => {
  it('another name for the same computer keeps the token; forgetting the last name removes it', async () => {
    const s = setup({ 'host-1': HOST_1, lab: LAB })
    await storeRemoteToken(FP, TOKEN, s.env, async () => true)
    const first = io(s.env)
    expect(await runRemotes(['forget', 'host-1'], first.io), first.err.join('')).toBe(0)
    expect(Object.keys(s.json().remotes)).toEqual(['lab'])
    expect(readRemoteToken(FP, s.env)).toBe(TOKEN)
    expect(first.out.join('')).toContain('"lab"')

    const last = io(s.env)
    expect(await runRemotes(['forget', 'lab'], last.io)).toBe(0)
    expect(s.json().remotes).toEqual({})
    expect(readRemoteToken(FP, s.env)).toBeNull()
  })

  it('a list that cannot be written keeps the entry and its token, and says so', { timeout: 15_000 }, async () => {
    const s = setup({ 'host-1': HOST_1 })
    await storeRemoteToken(FP, TOKEN, s.env, async () => true)
    // Another program holds the lock (fresh, not stale).
    const lock = `${s.path}.lock`
    writeFileSync(lock, '1 other\n')
    const now = new Date()
    utimesSync(lock, now, now)
    const c = io(s.env)
    expect(await runRemotes(['forget', 'host-1'], c.io)).toBe(1)
    expect(c.err.join('')).toContain('locked')
    expect(Object.keys(s.json().remotes)).toEqual(['host-1'])
    expect(readRemoteToken(FP, s.env)).toBe(TOKEN)
  })

  it('Studio Remove follows the same rule', async () => {
    const s = setup({ 'host-1': HOST_1, lab: LAB })
    await storeRemoteToken(FP, TOKEN, s.env, async () => true)
    expect(await forgetConnection(s.env, 'host-1')).toBe(true)
    expect(readRemoteToken(FP, s.env)).toBe(TOKEN)
  })
})

describe('a malformed entry (R2B-8)', () => {
  it('every write keeps it, in its place, and the default that names it', async () => {
    const s = setup({ 'agent-3': MALFORMED, 'host-1': HOST_1 }, 'agent-3')
    await updateRemotes(s.env, (file) => { file.remotes.lab = LAB })
    expect(s.json().remotes).toEqual({ 'agent-3': MALFORMED, 'host-1': HOST_1, lab: LAB })
    expect(Object.keys(s.json().remotes)).toEqual(['agent-3', 'host-1', 'lab'])
    expect(s.json().default).toBe('agent-3')
    // A forget of another name keeps it too, and Studio's names still hold it (its keys are kept).
    await forgetConnection(s.env, 'host-1')
    expect(s.json().remotes['agent-3']).toEqual(MALFORMED)
    expect(await savedConnectionNames(s.env)).toEqual(new Set(['agent-3', 'lab']))
  })

  it('is named by the reader, by adf remotes and by Studio', async () => {
    const s = setup({ 'agent-3': MALFORMED, 'host-1': HOST_1 })
    expect(readRemotes(s.env).malformed).toEqual(['agent-3'])
    expect((await readRemotesAsync(s.env)).malformed).toEqual(['agent-3'])
    const c = io(s.env)
    expect(await runRemotes(['list'], c.io)).toBe(0)
    expect(c.err.join('')).toContain('"agent-3"')
    const cache = new SavedConnectionsCache(s.env)
    await cache.refresh()
    expect(cache.malformed).toEqual(['agent-3'])
  })

  it('adf remotes forget removes it', async () => {
    const s = setup({ 'agent-3': MALFORMED, 'host-1': HOST_1 }, 'agent-3')
    const c = io(s.env)
    expect(await runRemotes(['forget', 'agent-3'], c.io), c.err.join('')).toBe(0)
    expect(s.json()).toMatchObject({ default: null, remotes: { 'host-1': HOST_1 } })
    expect(Object.keys(s.json().remotes)).toEqual(['host-1'])
  })

  it('a malformed entry with the same fingerprint keeps the token of a forgotten one', async () => {
    const s = setup({ 'agent-3': { url: HOST_1.url, fingerprint: FP }, 'host-1': HOST_1 })
    await storeRemoteToken(FP, TOKEN, s.env, async () => true)
    const c = io(s.env)
    expect(await runRemotes(['forget', 'host-1'], c.io)).toBe(0)
    expect(readRemoteToken(FP, s.env)).toBe(TOKEN)
  })
})
