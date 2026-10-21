/**
 * The terminal app's connection to a saved remote (`adf pair`): its device
 * token goes only after the daemon at that address proved, by the
 * authenticated hello (docs/design/remote-access.md §5.2.1), that it is the
 * paired computer. Checked at the first connection and again after every
 * failed or dropped one, requests and the event stream alike: a re-dial may
 * reach another computer at that address (DHCP, a spoof), which then never
 * gets the token.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../../src/main/tui/api/client'
import { saveRemotes, storeRemoteToken } from '../../src/main/cli/remotes'
import { deviceToken, fingerprintFor, helloResponse, type FakeHelloHost } from '../helpers/hello-proof'

const URL_ = 'http://192.168.77.10:7385'
const TOKEN = deviceToken('agent-1-host')
const FP = fingerprintFor('agent-1-host')
const OTHER_FP = fingerprintFor('agent-2-host')

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function pairedEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'adf-tui-pin-'))
  dirs.push(dir)
  // A test keychain file (ADF_TEST_KEYCHAIN_FILE): never the real keychain.
  const env: NodeJS.ProcessEnv = { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json'), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
  await storeRemoteToken(FP, TOKEN, env)
  saveRemotes({ v: 1, default: 'agent-1-host', remotes: { 'agent-1-host': { url: URL_, fingerprint: FP, deviceId: 'd1', label: 'agent-1 laptop', pairedAt: '2026-10-20T10:00:00Z', hostName: 'agent-1-host' } } }, env)
  return env
}

/**
 * What answers at URL_: the paired host, or (`impostor`) another computer
 * that shows another fingerprint and holds no record of the token. `down`
 * makes every request fail as a network error. `/events` streams until
 * `endStream()`.
 */
function address() {
  const state = { impostor: false, down: false }
  const requests: string[] = []
  let endStream: (() => void) | null = null
  const host = (): FakeHelloHost => state.impostor
    ? { name: 'agent-2-host', fingerprint: OTHER_FP, tokens: [] }
    : { name: 'agent-1-host', fingerprint: FP, tokens: [TOKEN] }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get('authorization')
    requests.push(`${state.impostor ? 'impostor' : 'host'} ${url.pathname}${auth === `Bearer ${TOKEN}` ? ' +token' : auth ? ' +other' : ''}`)
    if (state.down) throw new TypeError('fetch failed')
    if (url.pathname === '/remote/hello') return helloResponse(url, host())
    if (auth !== `Bearer ${TOKEN}` || state.impostor) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    if (url.pathname === '/events') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': open\n\n'))
          endStream = () => controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { state, requests, fetch: fetchImpl, endStream: () => endStream?.() }
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('the terminal app and a saved remote (I-3)', () => {
  it('requests: the token goes after the hello proof; after a failed connection the proof is checked again', async () => {
    const env = await pairedEnv()
    const at = address()
    const client = new DaemonClient({ baseUrl: URL_, localToken: true, env, fetch: at.fetch })
    await client.agents()
    await client.agents()
    // Checked once while connected; the hello itself never carries the token.
    expect(at.requests).toEqual(['host /remote/hello', 'host /agents +token', 'host /agents +token'])

    // The address stops answering, then another computer answers there.
    at.state.down = true
    await expect(client.agents()).rejects.toMatchObject({ status: null })
    at.state.down = false
    at.state.impostor = true
    at.requests.length = 0
    await expect(client.agents()).rejects.toThrow(`The ADF daemon at ${URL_} is not "agent-1-host" (agent-1-host): it shows fingerprint ${OTHER_FP}, and ${FP} was saved when you paired. The saved token was not sent.`)
    expect(at.requests).toEqual(['impostor /remote/hello'])

    // The paired computer is back: proved again, then the token goes.
    at.state.impostor = false
    at.requests.length = 0
    await client.agents()
    expect(at.requests).toEqual(['host /remote/hello', 'host /agents +token'])
  })

  it('the event stream: each reconnect after a drop proves the pin before the token goes', async () => {
    const env = await pairedEnv()
    const at = address()
    const client = new DaemonClient({ baseUrl: URL_, localToken: true, env, fetch: at.fetch })
    const states: string[] = []
    const stream = client.events({ onEvent: () => {}, onState: (info) => states.push(`${info.state}${info.error ? `: ${info.error}` : ''}`), minBackoffMs: 1, maxBackoffMs: 5 }).start()
    try {
      await until(() => states.includes('open'), 'the stream opens')
      expect(at.requests).toEqual(['host /remote/hello', 'host /events +token'])

      // The stream drops, and another computer answers at the address.
      at.state.impostor = true
      at.requests.length = 0
      at.endStream()
      await until(() => at.requests.length >= 2, 'two reconnect attempts')
      expect(at.requests.every((r) => r === 'impostor /remote/hello')).toBe(true)
      expect(states.some((s) => s.includes(`is not "agent-1-host"`) && s.includes('The saved token was not sent.'))).toBe(true)

      // The paired computer is back: the next attempt proves the pin, then reopens with the token.
      at.state.impostor = false
      await until(() => at.requests.includes('host /events +token'), 'the stream reopens on the paired host')
      const back = at.requests.indexOf('host /events +token')
      expect(at.requests[back - 1]).toBe('host /remote/hello')
      expect(at.requests.filter((r) => r.includes('+token') && r.startsWith('impostor'))).toEqual([])
    } finally {
      stream.close()
    }
  })

  it('a token given with --token or ADF_DAEMON_TOKEN is the user\'s choice: no hello', async () => {
    const env = await pairedEnv()
    const at = address()
    await new DaemonClient({ baseUrl: URL_, token: TOKEN, localToken: true, env, fetch: at.fetch }).agents()
    await new DaemonClient({ baseUrl: URL_, localToken: true, env: { ...env, ADF_DAEMON_TOKEN: TOKEN }, fetch: at.fetch }).agents()
    expect(at.requests).toEqual(['host /agents +token', 'host /agents +token'])
  })
})
