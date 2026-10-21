/**
 * Discovery review 3: what other computers send is bounded, cleaned and
 * never printed raw (docs/design/remote-access.md §5.1, §5.2): the tailnet
 * hello, the CLI's listing and pairing output, and one fingerprint seen at
 * two addresses (shown both, flagged, never one silently replacing the other).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fetchHello } from '../../../src/main/services/remote-hello'
import { mergeDiscovered, type DiscoveredDaemon } from '../../../src/main/cli/daemon-discovery'
import { runPair } from '../../../src/main/cli/pair'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'adf-intake-')); dirs.push(d); return d }

const ESCAPES = '\u001b]0;pwned\u0007\u001b[2J\u001b[31m\u0008\u009b1m‮'
/** Any control character (newline aside), C1, bidi override or escape left in text meant for a terminal. */
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/

const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the tailnet hello: bounded, validated, the name cleaned', () => {
  it('drops a body over 4 KB, a bad fingerprint or version; cleans and bounds the name', async () => {
    const hello = (body: unknown) => (async () => json(200, body)) as unknown as typeof fetch
    expect(await fetchHello('http://100.1.1.1:7385', hello({ v: 1, name: 'x'.repeat(5_000), fingerprint: 'ABCD-EFGH', pairingOpen: false, clientApiVersion: 2 }))).toBeNull()
    expect(await fetchHello('http://100.1.1.1:7385', hello(JSON.stringify({ v: 1, name: 'ok', fingerprint: 'ABCD-EFGH', pairingOpen: false, clientApiVersion: 2, pad: 'p'.repeat(4_200) })))).toBeNull()
    expect(await fetchHello('http://100.1.1.1:7385', hello({ v: 1, name: 'ok', fingerprint: 'not-a-fp', pairingOpen: false, clientApiVersion: 2 }))).toBeNull()
    expect(await fetchHello('http://100.1.1.1:7385', hello({ v: 2, name: 'ok', fingerprint: 'ABCD-EFGH', pairingOpen: false, clientApiVersion: 2 }))).toBeNull()
    const cleaned = await fetchHello('http://100.1.1.1:7385', hello({ v: 1, name: `agent-1${ESCAPES} desk${'!'.repeat(200)}`, fingerprint: 'ABCD-EFGH', pairingOpen: 'yes', clientApiVersion: 2 }))
    expect(cleaned).not.toBeNull()
    expect(cleaned!.name).not.toMatch(UNSAFE)
    expect(cleaned!.name.startsWith('agent-1')).toBe(true)
    expect([...cleaned!.name].length).toBeLessThanOrEqual(63)
    expect(cleaned!.pairingOpen).toBe(false)
  })
})

describe('one fingerprint at two addresses: both shown, flagged', () => {
  it('the CLI list keeps both and flags the clash; a LAN and a tailnet address with one fingerprint are never merged on the fingerprint alone', () => {
    const d = (over: Partial<DiscoveredDaemon>): DiscoveredDaemon => ({ name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', url: 'http://192.168.1.20:7385', kind: 'lan', pairingOpen: false, ...over })
    const clash = mergeDiscovered([[d({}), d({ name: 'impostor', url: 'http://192.168.1.66:7385' })]])
    expect(clash.map((x) => [x.url, x.clash])).toEqual([['http://192.168.1.20:7385', 2], ['http://192.168.1.66:7385', 2]])
    const two = mergeDiscovered([[d({})], [d({ url: 'http://100.64.0.66:7385', kind: 'tailnet' })]])
    expect(two.map((x) => [x.url, x.clash])).toEqual([['http://100.64.0.66:7385', 2], ['http://192.168.1.20:7385', 2]])
    // The same address twice is one entry.
    expect(mergeDiscovered([[d({})], [d({ pairingOpen: true })]])).toEqual([d({ pairingOpen: true, clash: null })])
  })
})

describe('adf pair never prints raw peer text', () => {
  it('the discovery listing and the pairing messages strip control characters and escape sequences', async () => {
    const out: string[] = []
    const err: string[] = []
    const prompts: string[] = []
    const fetchImpl = (async (input: string | URL) => {
      const u = new URL(String(input))
      if (u.pathname === '/remote/hello') return json(200, { v: 1, name: `evil${ESCAPES}`, fingerprint: 'ABCD-EFGH', pairingOpen: true, clientApiVersion: 2, helloProof: 1 })
      if (u.pathname === '/pair/claim') return json(400, { error: `Bad${ESCAPES} code`, code: 'bad_request' })
      return json(404, {})
    }) as typeof fetch
    const exit = await runPair([], {
      fetch: fetchImpl,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      prompt: async (q) => { prompts.push(q); return /Code shown/.test(q) ? '123456' : /Which one|Pair with/.test(q) ? '1' : 'y' },
      discover: async () => [
        { name: `host${ESCAPES}`, fingerprint: 'ABCD-EFGH', url: 'http://192.168.1.20:7385', kind: 'lan', pairingOpen: true, clash: 2 },
        { name: 'impostor', fingerprint: 'ABCD-EFGH', url: 'http://192.168.1.66:7385', kind: 'lan', pairingOpen: true, clash: 2 },
      ],
      sleep: async () => {},
      env: { ADF_KEYCHAIN: '0', ADF_DAEMON_SETTINGS: join(tempDir(), 'adf-settings.json') },
    })
    expect(exit).toBe(1)
    const all = [...out, ...err, ...prompts].join('')
    expect(all).not.toMatch(UNSAFE)
    expect(all).not.toContain('fingerprint at')
    expect(err.join('')).toContain('Bad')
  })
})
