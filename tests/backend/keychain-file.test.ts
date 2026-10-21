/**
 * A keychain that refuses a token, or none at all, never sends it silently
 * to the plaintext user-only file (review item 3): Studio shows "Keychain
 * unavailable" ("The token can be saved in a file only you can read.", Save
 * to file / Cancel) first, and saves nothing on Cancel. adf asks the same
 * (tests/cli-remote-access.test.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { KEYCHAIN_FILE_COPY, loadRemotes, readRemoteToken, REMOTE_TOKENS_FILENAME, TokenNotStoredError } from '../../src/main/cli/remotes'
import { remotesEnv, saveConnection } from '../../src/main/backend/connections'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const input = { url: 'http://100.101.102.103:7385', token: 'adfd_' + 'k'.repeat(40), fingerprint: 'ABCD-EFGH', hostName: 'box-1', deviceId: 'd', label: 'l' }

function noKeychain(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-keychain-file-'))
  dirs.push(dir)
  return { dir, env: { ...remotesEnv(dir), ADF_KEYCHAIN: '0' } }
}

describe('the user-only token file only after the user says so', () => {
  it('plain copy: a heading, one sentence, a short verb (re-review 3)', () => {
    expect(KEYCHAIN_FILE_COPY).toEqual({ title: 'Keychain unavailable', message: 'The token can be saved in a file only you can read.', ok: 'Save to file', cancel: 'Cancel', prompt: 'Save to file? [y/N] ' })
  })

  it('no keychain and nobody to ask: nothing is saved', async () => {
    const { env, dir } = noKeychain()
    await expect(saveConnection(env, input)).rejects.toBeInstanceOf(TokenNotStoredError)
    expect(existsSync(join(dir, REMOTE_TOKENS_FILENAME))).toBe(false)
    expect(loadRemotes(env).remotes).toEqual({})
  })

  it('No saves nothing; Yes saves to the file and the list, and the question gets the reason', async () => {
    const { env, dir } = noKeychain()
    const reasons: string[] = []
    await expect(saveConnection(env, input, { confirmFile: async (why) => { reasons.push(why); return false } })).rejects.toThrow(/The token was not saved/)
    expect(existsSync(join(dir, REMOTE_TOKENS_FILENAME))).toBe(false)
    expect(reasons).toEqual(['the OS keychain is turned off (ADF_KEYCHAIN=0)'])
    const saved = await saveConnection(env, input, { confirmFile: async () => true })
    expect(saved.store).toMatchObject({ where: 'file' })
    expect(readRemoteToken('ABCD-EFGH', env)).toBe(input.token)
    expect(Object.keys(loadRemotes(env).remotes)).toEqual(['box-1'])
  })

  it('a keychain that refuses the write: the reason names the refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-keychain-refuses-'))
    dirs.push(dir)
    // The test keychain file is a folder: every write throws.
    mkdirSync(join(dir, 'keychain.json'))
    const env = { ...remotesEnv(dir), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
    delete env.ADF_KEYCHAIN
    const reasons: string[] = []
    await expect(saveConnection(env, input, { confirmFile: async (why) => { reasons.push(why); return false } })).rejects.toBeInstanceOf(TokenNotStoredError)
    expect(reasons[0]).toMatch(/^the OS keychain refused it: /)
  })
})
