/**
 * The saved connections in Studio main are a cache (review item 9): the
 * list and the "paired" marks read it without touching the disk; it
 * refreshes when cli-remotes.json changes (adf wrote it) or Studio wrote it,
 * with async reads.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { SavedConnectionsCache, remotesEnv } from '../../src/main/backend/connections'
import { createConnections } from '../../src/main/backend/connections-ipc'
import { createBackendSettingsStore, resolveBootBackend, type SecretCodec } from '../../src/main/backend/backend-config'
import { updateRemotes, type SavedRemote } from '../../src/main/cli/remotes'

const dirs: string[] = []
const caches: SavedConnectionsCache[] = []
afterEach(() => {
  for (const c of caches.splice(0)) c.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const quiet = { log: () => {}, warn: () => {} }
const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }
const entry = (fingerprint: string): SavedRemote => ({ url: 'https://hub.example.com', fingerprint, deviceId: 'd', label: 'l', pairedAt: '' })
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-saved-cache-'))
  dirs.push(dir)
  const env = { ...remotesEnv(dir), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
  delete env.ADF_KEYCHAIN
  return { dir, env }
}

describe('SavedConnectionsCache', () => {
  it('reads only on refresh: a change on disk is not seen by get() until then', async () => {
    const { env } = setup()
    const cache = new SavedConnectionsCache(env)
    caches.push(cache)
    expect(cache.get()).toEqual({})
    await updateRemotes(env, (f) => { f.remotes.hub = entry('ABCD-EFGH') })
    expect(cache.get()).toEqual({})
    await cache.refresh()
    expect(Object.keys(cache.get())).toEqual(['hub'])
    expect(cache.fingerprints()).toEqual(new Set(['ABCD-EFGH']))
  })

  it('a write by adf is picked up by the watch, and the list is pushed again', async () => {
    const { env } = setup()
    const changed = vi.fn()
    const cache = new SavedConnectionsCache(env, changed)
    caches.push(cache)
    await cache.refresh()
    cache.watch()
    await updateRemotes(env, (f) => { f.remotes.desk = entry('DESK-2345') })
    await until(() => Object.keys(cache.get()).includes('desk'))
    expect(changed).toHaveBeenCalled()
  })

  it('the Connection page reads the cache; an action refreshes it first', async () => {
    const { env, dir } = setup()
    const path = join(dir, 'studio-backend.json')
    const boot = resolveBootBackend(path, {}, quiet)
    const cache = new SavedConnectionsCache(env)
    caches.push(cache)
    const connections = createConnections({
      boot, backend: createBackendSettingsStore({ boot, codec, log: quiet }), env, saved: cache,
      daemonStatus: () => null, discovery: () => null, confirm: async () => true, push: () => {}, log: quiet,
    })
    await updateRemotes(env, (f) => { f.remotes.hub = entry('ABCD-EFGH') })
    expect(connections.view().rows.map((r) => r.id)).toEqual(['local'])
    // Remove refreshes first, so it finds the entry adf just wrote.
    expect(await connections.remove('remote:hub')).toMatchObject({ ok: true })
    expect(connections.view().rows.map((r) => r.id)).toEqual(['local'])
  })
})
