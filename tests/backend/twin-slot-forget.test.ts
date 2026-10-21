/**
 * G1: a remote slot of studio-backend.json paired with a computer that is
 * also a saved connection is that connection (runtimeSlot hides it). After
 * `adf remotes forget` of the connection, the slot must not come back into
 * the runtime set with its token, at once or at the next launch: Studio
 * drops such a twin as soon as it sees both, so the CLI's forget forgets the
 * computer, as Studio's Remove does.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { createBackendSettingsStore, resolveBootBackend, type SecretCodec, type StudioBackendConfig } from '../../src/main/backend/backend-config'
import { clearTwinSlot, migratePairedSlot, remotesEnv, runtimeSlot, saveConnection, slotTwin } from '../../src/main/backend/connections'
import { loadRemotes, readRemoteToken } from '../../src/main/cli/remotes'
import { runRemotes } from '../../src/main/cli/pair'

const URL_ = 'http://100.101.102.103:7385'
const SLOT_TOKEN = 'adfd_' + 's'.repeat(40)
const CLI_TOKEN = 'adfd_' + 'c'.repeat(40)
const FP = 'AGNT-2345'
const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }
const quiet = { log: () => {}, warn: () => {} }
const paired = { fingerprint: FP, name: 'agent-1', deviceId: 'dev-1', label: 'agent-2 laptop' }
const slotConfig = (): StudioBackendConfig => ({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: URL_, token: codec.encrypt(SLOT_TOKEN), allowInsecureHttp: false, paired } })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** keychain false: no keychain at all (the token goes to the user-only file), so the launch cannot move the slot. */
function setup(keychain: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-twin-slot-'))
  dirs.push(dir)
  // Never the real keychain: a test file, or none.
  const env: NodeJS.ProcessEnv = keychain ? { ...remotesEnv(dir), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' } : { ...remotesEnv(dir), ADF_KEYCHAIN: '0' }
  if (keychain) delete env.ADF_KEYCHAIN
  const path = join(dir, 'studio-backend.json')
  writeFileSync(path, JSON.stringify(slotConfig()))
  const launch = () => resolveBootBackend(path, {}, quiet)
  return { env, path, launch }
}

/** `adf pair` of the same computer, as it saves it. */
const cliPair = (env: NodeJS.ProcessEnv) => saveConnection(env, { url: URL_, token: CLI_TOKEN, fingerprint: FP, hostName: 'agent-1', deviceId: 'dev-2', label: 'agent-2 laptop' }, { confirmFile: async () => true })

async function cliForget(env: NodeJS.ProcessEnv): Promise<void> {
  const out: string[] = []
  expect(await runRemotes(['forget', 'agent-1'], { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env }), out.join('')).toBe(0)
}

describe('adf remotes forget of a connection with a twin remote slot (G1)', () => {
  it('while Studio runs: the twin goes when Studio sees it, so forget leaves nothing to come back, now or at the next launch', async () => {
    const s = setup(true)
    const boot = s.launch()
    // The launch: nothing saved yet, so the slot moves into the list (it is its own computer).
    // Here it stays as Studio found it: a keychain refusal at that launch is the same case.
    const store = createBackendSettingsStore({ boot, codec, log: quiet })
    await cliPair(s.env)
    const saved = loadRemotes(s.env).remotes
    expect(slotTwin(store.config(), saved)).toBe('agent-1')
    expect(runtimeSlot(store.config(), saved)).toBeNull()
    // Studio's watcher saw cli-remotes.json change.
    expect(await clearTwinSlot(store, saved, quiet)).toBe('agent-1')
    expect(store.config().remote).toMatchObject({ url: null, token: null })
    expect(JSON.parse(readFileSync(s.path, 'utf8')).remote).toMatchObject({ url: null, token: null })
    // The saved connection keeps its own token.
    expect(readRemoteToken(FP, s.env)).toBe(CLI_TOKEN)

    await cliForget(s.env)
    expect(runtimeSlot(store.config(), loadRemotes(s.env).remotes)).toBeNull()
    // The next launch moves nothing back into the list.
    const next = s.launch()
    expect(await migratePairedSlot(next, codec, s.env, quiet)).toBeNull()
    expect(loadRemotes(s.env).remotes).toEqual({})
    expect(runtimeSlot(next.config, {})).toBeNull()
  })

  it('at launch, without a keychain: the twin goes instead of staying beside the connection; forget then forgets the computer', async () => {
    const s = setup(false)
    await cliPair(s.env)
    const boot = s.launch()
    expect(await migratePairedSlot(boot, codec, s.env, quiet)).toBe('agent-1')
    expect(boot.config.remote).toMatchObject({ url: null, token: null })
    // The connection's token is the one adf saved, not the slot's.
    expect(readRemoteToken(FP, s.env)).toBe(CLI_TOKEN)

    await cliForget(s.env)
    const next = s.launch()
    expect(await migratePairedSlot(next, codec, s.env, quiet)).toBeNull()
    expect(runtimeSlot(next.config, loadRemotes(s.env).remotes)).toBeNull()
    expect(loadRemotes(s.env).remotes).toEqual({})
  })

  it('at launch with a keychain: the twin goes without its older token replacing the connection\'s', async () => {
    const s = setup(true)
    await cliPair(s.env)
    const boot = s.launch()
    expect(await migratePairedSlot(boot, codec, s.env, quiet)).toBe('agent-1')
    expect(readRemoteToken(FP, s.env)).toBe(CLI_TOKEN)
    expect(loadRemotes(s.env).remotes['agent-1']).toMatchObject({ deviceId: 'dev-2' })
  })

  it('a slot of another computer, or a pasted token, is not a twin', async () => {
    const s = setup(true)
    const store = createBackendSettingsStore({ boot: s.launch(), codec, log: quiet })
    await saveConnection(s.env, { url: 'http://100.64.0.9:7385', token: CLI_TOKEN, fingerprint: 'OTHR-6789', hostName: 'agent-3', deviceId: 'dev-3', label: 'agent-2 laptop' })
    const saved = loadRemotes(s.env).remotes
    expect(slotTwin(store.config(), saved)).toBeNull()
    expect(await clearTwinSlot(store, saved, quiet)).toBeNull()
    expect(store.config().remote.url).toBe(URL_)
  })
})
