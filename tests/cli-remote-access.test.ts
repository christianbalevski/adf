/**
 * The terminal side of remote access (docs/design/remote-access.md §9.2):
 * `adf daemon remote|devices|pair` on the host and `adf pair` / `adf remotes`
 * on the other computer, against a real daemon HTTP API with a remote
 * listener (the private address bound on 127.0.0.1 through the test seam).
 * The client keeps its token in the user-only file (ADF_KEYCHAIN=0).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkInterfaceInfo } from 'node:os'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

/** This computer's host name as node:os reports it; a test sets one a CI runner could have. */
const os = vi.hoisted(() => ({ hostname: null as string | null }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const hostname = () => os.hostname ?? actual.hostname()
  return { ...actual, hostname, default: { ...actual, hostname } }
})
afterEach(() => { os.hostname = null })

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-cli-remote-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-cli-remote-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import type { FastifyInstance } from 'fastify'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { RemoteAccessService } from '../src/main/daemon/remote-access/service'
import { localProofPath } from '../src/main/daemon/local-access'
import { DAEMON_TOKEN_FILENAME } from '../src/main/daemon/daemon-token'
import { runHostRemoteCommand, type HostCliIo } from '../src/main/cli/remote-access-cli'
import { hostToUrl, runPair, runRemotes, transportOf } from '../src/main/cli/pair'
import { mergeDiscovered } from '../src/main/cli/daemon-discovery'
import { loadRemotes, readRemoteToken, REMOTE_TOKENS_FILENAME } from '../src/main/cli/remotes'
import { resolveDaemonToken, resolveDaemonUrl } from '../src/main/cli/daemon-url'
import { runCli } from '../src/main/cli/index'
import { lanNetworkId } from '../src/main/daemon/remote-access/network-key'

/** The test LAN (gateway 00:00:5e:00:01:01, 192.168.77.0/24). */
const HOME = lanNetworkId('00:00:5e:00:01:01', '192.168.77.0/24', null)

const TOKEN = 't'.repeat(43)
const PROOF = 'p'.repeat(43)
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'adf-cli-remote-'))
  dirs.push(d)
  return d
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

const running: Array<{ server: FastifyInstance; service: RemoteAccessService }> = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.service.shutdown()
    await r.server.close()
  }
})

/** `allowed` (default true): the user already allowed the test LAN. */
async function host(opts: { allowed?: boolean } = {}) {
  const dataDir = tempDir()
  if (opts.allowed !== false) {
    writeFileSync(join(dataDir, 'remote-access.json'), JSON.stringify({ v: 1, enabled: false, name: 'host-1', daemonId: null, allowedNetworks: [{ id: HOME, kind: 'lan', label: 'eth0 (192.168.77.0/24)', addedAt: '2026-10-18T00:00:00.000Z' }] }))
  }
  const remotePort = await freePort()
  const service = new RemoteAccessService({
    settingsDir: dataDir,
    port: remotePort,
    clientApiVersion: 2,
    platform: 'linux',
    hostName: () => 'host-1',
    interfaces: () => ({ eth0: [{ address: '192.168.77.10', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.168.77.10/24' } as NetworkInterfaceInfo] }),
    gateways: async (ifaces) => new Map(ifaces.map(i => [i, '192.168.77.1|00:00:5e:00:01:01'])),
    wifiNames: async () => new Map(),
    osCategories: async () => new Map(),
    tailscale: {
      self: async () => ({ state: 'absent', ips: [], dnsName: null }),
      serveStatus: async () => ({ serve: 'unknown', httpsUrl: null }),
      setServe: async () => { throw new Error('not installed') },
      serveCommand: (p, on) => (on ? ['serve', '--bg', String(p)] : ['serve', '--https=443', 'off']),
      whois: async () => null,
      command: null,
    },
    announcer: { announcing: false, problem: null, announce: async () => {}, stop: async () => {} },
    firewall: async () => ({ state: 'unknown', message: 'Linux does not ask.', commands: [] }),
    bindAddress: () => '127.0.0.1',
    wrongCodeDelayMs: 0,
    log: () => {},
  })
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
    routes: { remoteAccess: service },
    security: { token: TOKEN, localProof: PROOF },
  })
  await server.listen({ host: '127.0.0.1', port: 0 })
  await service.attach((req, res) => server.routing(req, res))
  running.push({ server, service })
  const port = (server.server.address() as { port: number }).port
  writeFileSync(join(dataDir, DAEMON_TOKEN_FILENAME), `${TOKEN}\n`)
  writeFileSync(localProofPath(dataDir, port), `${PROOF}\n`)
  const out: string[] = []
  const err: string[] = []
  const answers: string[] = []
  const io: HostCliIo = {
    fetch: globalThis.fetch.bind(globalThis),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    prompt: async (q) => { err.push(q); return answers.shift() ?? null },
    sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 30))),
  }
  const target = { url: `http://127.0.0.1:${port}`, port, dataDir }
  const run = (sub: 'remote' | 'devices' | 'pair', ...args: string[]) => runHostRemoteCommand(sub, args, io, target)
  return { run, out, err, answers, remoteUrl: `http://127.0.0.1:${remotePort}`, target }
}

describe('adf daemon remote allow-network / forget-network (owner decision 2026-10-18 b)', () => {
  it('status shows the network paused; allow-network opens it, forget-network closes it', async () => {
    const h = await host({ allowed: false })
    expect(await h.run('remote', 'on')).toBe(0)
    const paused = h.out.join('')
    expect(paused).toContain('Remote access: on\nPaused on eth0 (192.168.77.0/24).')
    expect(paused).toContain(`  eth0 (192.168.77.0/24)  paused (allow: adf daemon remote allow-network ${HOME}) Public network. The token is sent unencrypted.`)
    expect(paused).toContain('Allowed networks (0):')
    h.out.length = 0
    expect(await h.run('remote', 'allow-network')).toBe(0)
    expect(h.out.join('')).toContain('Listening on 192.168.77.10.')
    expect(h.out.join('')).toContain(`Allowed networks (1):\n  ${HOME}  eth0 (192.168.77.0/24)`)
    expect((await fetch(`${h.remoteUrl}/remote/hello`)).status).toBe(200)
    h.out.length = 0
    expect(await h.run('remote', 'forget-network', 'eth0 (192.168.77.0/24)')).toBe(0)
    expect(h.out.join('')).toContain('Paused on eth0 (192.168.77.0/24).')
    await expect(fetch(`${h.remoteUrl}/remote/hello`)).rejects.toThrow()
    h.err.length = 0
    expect(await h.run('remote', 'forget-network', 'nowhere')).toBe(1)
    expect(h.err.join('')).toContain('No allowed network "nowhere".')
    expect(await h.run('remote', 'forget-network')).toBe(2)
    expect(await h.run('remote', 'trust')).toBe(2)
  })
})

describe('adf daemon remote / devices (host)', () => {
  it('on, status, devices add (token alone on stdout), list, revoke by label, off', async () => {
    const h = await host()
    expect(await h.run('remote', 'status')).toBe(0)
    expect(h.out.join('')).toContain('Remote access: off')
    h.out.length = 0
    expect(await h.run('remote', 'on', '--name', 'agent-1 host')).toBe(0)
    expect(h.out.join('')).toMatch(/Remote access: on\nListening on 192\.168\.77\.10\./)
    expect(h.err.join('')).toContain('same power as your seed phrase')
    h.out.length = 0
    expect(await h.run('devices', 'add', 'agent-2', 'laptop')).toBe(0)
    expect(h.out).toHaveLength(1)
    const token = h.out[0].trim()
    expect(token).toMatch(/^adfd_[a-z2-7]{10}_[A-Za-z0-9_-]{43}$/)
    expect(h.err.join('')).toMatch(/shown once/)
    const ok = await fetch(`${h.remoteUrl}/version`, { headers: { authorization: `Bearer ${token}` } })
    expect(ok.status).toBe(200)
    h.out.length = 0
    expect(await h.run('devices')).toBe(0)
    expect(h.out.join('')).toMatch(/agent-2 laptop\s+token/)
    h.out.length = 0
    expect(await h.run('devices', 'revoke', 'agent-2', 'laptop')).toBe(0)
    expect(h.out.join('')).toMatch(/Removed "agent-2 laptop"/)
    expect((await fetch(`${h.remoteUrl}/version`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
    expect(await h.run('devices', 'revoke', 'nobody')).toBe(1)
    h.out.length = 0
    expect(await h.run('remote', 'off')).toBe(0)
    expect(h.out.join('')).toContain('Remote access: off')
  })

  it('pair refuses while remote access is off', async () => {
    const h = await host()
    expect(await h.run('pair')).toBe(1)
    expect(h.err.join('')).toContain('adf daemon remote on')
  })
})

describe('adf pair (client) + adf daemon pair (host)', () => {
  it('pairs with the code and the host\'s Allow, saves the token, and adf then talks to the remote by default', async () => {
    const h = await host()
    await h.run('remote', 'on')
    h.out.length = 0
    h.answers.push('y') // the host's Allow
    const hostDone = h.run('pair')

    const clientDir = tempDir()
    const env = { ADF_DAEMON_SETTINGS: join(clientDir, 'adf-settings.json'), ADF_KEYCHAIN: '0' }
    const cout: string[] = []
    const cerr: string[] = []
    const prompts: string[] = []
    const code = async (): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        const m = /Code: (\d{3}) (\d{3})/.exec(h.out.join(''))
        if (m) return `${m[1]}${m[2]}`
        await new Promise(r => setTimeout(r, 20))
      }
      throw new Error('the host never showed a code')
    }
    const exit = await runPair([h.remoteUrl.replace('http://', ''), '--name', 'agent-2 laptop'], {
      fetch: globalThis.fetch.bind(globalThis),
      stdout: (t) => cout.push(t),
      stderr: (t) => cerr.push(t),
      prompt: async (q) => {
        prompts.push(q)
        if (/^Code shown/.test(q)) return await code()
        if (/by default/.test(q)) return 'y'
        return null
      },
      sleep: async () => {},
      env,
    })
    expect(exit, cerr.join('')).toBe(0)
    expect(await hostDone).toBe(0)
    expect(h.out.join('')).toMatch(/Allowed: "agent-2 laptop"/)
    expect(h.err.join('')).toMatch(/Allow "agent-2 laptop" \(127\.0\.0\.1, this network\)/)
    expect(cout.join('')).toMatch(/Paired with "host-1" as "agent-2 laptop"\. Saved as remote "host-1" .*the default/)
    expect(cerr.join('')).toContain(REMOTE_TOKENS_FILENAME)

    const saved = loadRemotes(env)
    expect(saved.default).toBe('host-1')
    expect(saved.remotes['host-1']).toMatchObject({ url: h.remoteUrl, label: 'agent-2 laptop' })
    const url = resolveDaemonUrl(undefined, env)
    expect(url).toBe(h.remoteUrl)
    const token = resolveDaemonToken(undefined, env, url)
    expect(token).toMatch(/^adfd_/)
    expect((await fetch(`${url}/version`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    // Never sent to another origin.
    expect(resolveDaemonToken(undefined, env, 'http://192.168.1.99:7385')).toBeUndefined()
    // ADF_REMOTE=local forces this computer.
    expect(resolveDaemonUrl(undefined, { ...env, ADF_REMOTE: 'local' })).toBe('http://127.0.0.1:7385')

    const lines: string[] = []
    expect(await runRemotes([], { stdout: (t) => lines.push(t), stderr: () => {}, env })).toBe(0)
    expect(lines.join('')).toMatch(/\* host-1/)
    expect(await runRemotes(['use', 'local'], { stdout: () => {}, stderr: () => {}, env })).toBe(0)
    expect(resolveDaemonUrl(undefined, env)).toBe('http://127.0.0.1:7385')
    expect(await runRemotes(['forget', 'host-1'], { stdout: (t) => lines.push(t), stderr: () => {}, env })).toBe(0)
    expect(lines.join('')).toMatch(/adf daemon devices revoke [a-z2-7]{10}/)
    expect(readRemoteToken(saved.remotes['host-1'].fingerprint, env)).toBeNull()
  })

  it('a denied request saves nothing; a wrong code is retried with the attempts left', async () => {
    const h = await host()
    await h.run('remote', 'on')
    h.out.length = 0
    h.answers.push('n')
    const hostDone = h.run('pair')
    const clientDir = tempDir()
    const env = { ADF_DAEMON_SETTINGS: join(clientDir, 'adf-settings.json'), ADF_KEYCHAIN: '0' }
    const cerr: string[] = []
    let tries = 0
    const exit = await runPair([h.remoteUrl], {
      fetch: globalThis.fetch.bind(globalThis),
      stdout: () => {},
      stderr: (t) => cerr.push(t),
      prompt: async (q) => {
        if (!/^Code shown/.test(q)) return null
        for (let i = 0; i < 100 && !/Code: /.test(h.out.join('')); i++) await new Promise(r => setTimeout(r, 20))
        const m = /Code: (\d{3}) (\d{3})/.exec(h.out.join('')) as RegExpExecArray
        const right = `${m[1]}${m[2]}`
        tries++
        return tries === 1 ? String((Number(right) + 1) % 1_000_000).padStart(6, '0') : right
      },
      // Real waits: the host allows one claim per 2 s from an address.
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      env,
    })
    expect(exit).toBe(1)
    expect(await hostDone).toBe(1)
    expect(cerr.join('')).toMatch(/4 attempt\(s\) left/)
    expect(cerr.join('')).toMatch(/"host-1" did not allow this computer/)
    expect(loadRemotes(env).remotes).toEqual({})
  })

  it('an address that is not an ADF daemon with remote access on is refused before any code is asked', async () => {
    const h = await host()
    const cerr: string[] = []
    const exit = await runPair([h.remoteUrl], { fetch: globalThis.fetch.bind(globalThis), stdout: () => {}, stderr: (t) => cerr.push(t), prompt: async () => { throw new Error('no prompt expected') }, env: { ADF_KEYCHAIN: '0', ADF_DAEMON_SETTINGS: join(tempDir(), 's.json') } })
    expect(exit).toBe(1)
    expect(cerr.join('')).toMatch(/does not answer as an ADF daemon with remote access on/)
  })
})

describe('client helpers', () => {
  it('hostToUrl and transportOf', () => {
    expect(hostToUrl('host-1.local')).toBe('http://host-1.local:7385')
    expect(hostToUrl('192.168.1.20:7400')).toBe('http://192.168.1.20:7400')
    expect(hostToUrl('https://host-1.tail.ts.net/')).toBe('https://host-1.tail.ts.net')
    expect(hostToUrl('fd7a:115c:a1e0::1')).toBe('http://[fd7a:115c:a1e0::1]:7385')
    expect(transportOf('https://x.ts.net')).toBe('https')
    expect(transportOf('http://100.101.102.103:7385')).toBe('tailnet')
    expect(transportOf('http://127.0.0.1:7385')).toBe('loopback')
    expect(transportOf('http://192.168.1.20:7385')).toBe('plain')
  })

  it('discovery never merges two addresses on the fingerprint alone: both listed, flagged', () => {
    const merged = mergeDiscovered([
      [{ name: 'host-1', fingerprint: 'AAAA-BBBB', url: 'http://192.168.1.20:7385', kind: 'lan', pairingOpen: true }],
      [{ name: 'host-1', fingerprint: 'AAAA-BBBB', url: 'http://100.101.102.103:7385', kind: 'tailnet', pairingOpen: false }, { name: 'host-2', fingerprint: 'CCCC-DDDD', url: 'http://100.1.1.1:7385', kind: 'tailnet', pairingOpen: false }],
    ])
    expect(merged).toEqual([
      { name: 'host-1', fingerprint: 'AAAA-BBBB', url: 'http://192.168.1.20:7385', kind: 'lan', pairingOpen: true, clash: 2 },
      { name: 'host-1', fingerprint: 'AAAA-BBBB', url: 'http://100.101.102.103:7385', kind: 'tailnet', pairingOpen: false, clash: 2 },
      { name: 'host-2', fingerprint: 'CCCC-DDDD', url: 'http://100.1.1.1:7385', kind: 'tailnet', pairingOpen: false, clash: null },
    ])
  })
})

describe('security review item 7: the CLI pins the host it paired with', () => {
  const FP_A = 'AAAA-BBBB'
  const FP_B = 'CCCC-DDDD'
  const TOKEN_A = `adfd_aaaaaaaaaa_${'a'.repeat(43)}`

  /** A fake ADF host behind fetch: hello answers `helloFp` per origin; approval answers `approvalFp`. */
  function fakeHost(opts: { helloFp: Record<string, string>; approvalFp: string; urls?: Array<{ url: string; kind: string; encrypted: boolean }> }) {
    const authSeen: string[] = []
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (headers.get('authorization')) authSeen.push(`${u.origin} ${headers.get('authorization')}`)
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (u.pathname === '/remote/hello') {
        const fp = opts.helloFp[u.origin]
        return fp ? json(200, { v: 1, name: 'host-1', fingerprint: fp, pairingOpen: true, clientApiVersion: 2 }) : json(404, { error: 'off', code: 'remote_access_off' })
      }
      if (u.pathname === '/pair/claim') return json(202, { claimId: 'c1', expiresAt: new Date(Date.now() + 60_000).toISOString(), collectSecret: 's'.repeat(43) })
      if (u.pathname === '/pair/claims/c1') {
        return json(200, { state: 'approved', token: TOKEN_A, device: { id: 'abcdefghij', label: 'agent-2 laptop' }, daemon: { name: 'host-1', fingerprint: opts.approvalFp, urls: opts.urls ?? [] } })
      }
      return json(200, { ok: true })
    }) as typeof fetch
    return { fetchImpl, authSeen }
  }
  function client(fetchImpl: typeof fetch, answers: Record<string, string>, extra: Partial<Parameters<typeof runPair>[1]> = {}) {
    const env = { ADF_DAEMON_SETTINGS: join(tempDir(), 'adf-settings.json'), ADF_KEYCHAIN: '0' }
    const out: string[] = []
    const err: string[] = []
    const asked: string[] = []
    const io = {
      fetch: fetchImpl, env, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), sleep: async () => {},
      prompt: async (q: string) => { asked.push(q); const key = Object.keys(answers).find(k => q.includes(k)); return key ? answers[key] : null },
      ...extra,
    }
    return { io, env, out, err, asked }
  }
  const HOST = 'http://192.168.77.10:7385'

  it('any host name pairs: one that is too long or has control characters becomes a safe device name (no --name needed)', async () => {
    for (const [raw, sent] of [['m'.repeat(80), 'm'.repeat(64)], ['build\u0007box‮-7', 'buildbox-7'], ['', 'ADF computer']] as const) {
      os.hostname = raw
      const claims: unknown[] = []
      const host = fakeHost({ helloFp: { [HOST]: FP_A }, approvalFp: FP_A })
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname === '/pair/claim') claims.push(JSON.parse(String(init?.body)))
        return host.fetchImpl(input, init)
      }) as typeof fetch
      const c = client(fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y' })
      expect(await runPair([HOST], c.io)).toBe(0)
      expect(claims).toEqual([expect.objectContaining({ deviceName: sent })])
    }
  })

  it('refuses an approval from another fingerprint than the hello showed; nothing is saved', async () => {
    const host = fakeHost({ helloFp: { [HOST]: FP_A }, approvalFp: FP_B })
    const c = client(host.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y' })
    expect(await runPair([HOST], c.io)).toBe(1)
    expect(c.err.join('')).toMatch(/Refused: the approval came from a computer with fingerprint CCCC-DDDD, not AAAA-BBBB/)
    expect(loadRemotes(c.env).remotes).toEqual({})
  })

  it('a saved remote stays pinned: another fingerprint under its name is refused, its address and token are replaced only after asking', async () => {
    const host = fakeHost({ helloFp: { [HOST]: FP_A }, approvalFp: FP_A })
    const c = client(host.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y' })
    expect(await runPair([HOST], c.io)).toBe(0)
    const saved = loadRemotes(c.env).remotes['host-1']
    expect(saved).toMatchObject({ url: HOST, fingerprint: FP_A })

    // Another computer (fingerprint B) paired under the same name: refused, nothing changes.
    const other = fakeHost({ helloFp: { 'http://192.168.77.11:7385': FP_B }, approvalFp: FP_B })
    const c2 = { ...c, io: { ...c.io, fetch: other.fetchImpl } }
    expect(await runPair(['http://192.168.77.11:7385', '--as', 'host-1'], c2.io)).toBe(1)
    expect(c.err.join('')).toMatch(/the saved remote "host-1" is host-1 with fingerprint AAAA-BBBB, not this computer \(CCCC-DDDD\)/)
    expect(loadRemotes(c.env).remotes['host-1']).toEqual(saved)

    // The same computer at a new address: asked; "no" keeps the saved address and token.
    const moved = fakeHost({ helloFp: { 'http://192.168.77.12:7385': FP_A }, approvalFp: FP_A })
    const c3 = client(moved.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'already saved': 'n' })
    const c3io = { ...c3.io, env: c.env }
    expect(await runPair(['http://192.168.77.12:7385'], c3io)).toBe(1)
    expect(c3.asked.join('\n')).toMatch(/"host-1" \(host-1\) is already saved\. Replace its address \(http:\/\/192\.168\.77\.10:7385 → http:\/\/192\.168\.77\.12:7385\) and its token\?/)
    expect(loadRemotes(c.env).remotes['host-1'].url).toBe(HOST)
  })

  it('switches to a host-listed URL only for *.ts.net https or a confirmed tailnet peer, and only after asking', async () => {
    const urls = [
      { url: 'https://evil.example.com', kind: 'tailscale-https', encrypted: true },
      { url: 'http://192.168.99.99:7385', kind: 'tailnet', encrypted: true },
      { url: 'http://100.70.1.2:7385', kind: 'tailnet', encrypted: true },
      { url: 'https://host-1.tail1234.ts.net', kind: 'tailscale-https', encrypted: true },
    ]
    const everyone = { [HOST]: FP_A, 'https://evil.example.com': FP_A, 'http://192.168.99.99:7385': FP_A, 'http://100.70.1.2:7385': FP_A, 'https://host-1.tail1234.ts.net': FP_A }
    // 100.70.1.2 is not one of this computer's Tailscale peers: skipped; evil.example.com and the LAN address are never followed.
    const host = fakeHost({ helloFp: everyone, approvalFp: FP_A, urls })
    const c = client(host.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y', 'Save that address': 'n' }, { tailnetView: async () => ({ running: true, suffix: 'tail1234.ts.net', peerIps: new Set<string>([]), peerNames: new Set<string>() }) })
    expect(await runPair([HOST], c.io)).toBe(0)
    expect(c.asked.filter(q => /Save that address/.test(q))).toEqual([expect.stringContaining('https://host-1.tail1234.ts.net')])
    expect(loadRemotes(c.env).remotes['host-1'].url).toBe(HOST)
    // Said yes: the ts.net address is saved.
    const c2 = client(host.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y', 'Save that address': 'y' }, { tailnetView: async () => ({ running: true, suffix: 'tail1234.ts.net', peerIps: new Set<string>(["100.70.1.2"]), peerNames: new Set<string>() }) })
    expect(await runPair([HOST], c2.io)).toBe(0)
    expect(c2.asked.find(q => /Save that address/.test(q))).toContain('http://100.70.1.2:7385')
    expect(loadRemotes(c2.env).remotes['host-1'].url).toBe('http://100.70.1.2:7385')
  })

  it('re-review 3: a ts.net name must be this tailnet\'s or a peer\'s; --yes does not skip that; without Tailscale nothing switches', async () => {
    const urls = [
      { url: 'https://evil.ts.net', kind: 'tailscale-https', encrypted: true },
      { url: 'https://host-1.other9999.ts.net', kind: 'tailscale-https', encrypted: true },
      { url: 'http://100.70.1.2:7385', kind: 'tailnet', encrypted: true },
    ]
    const everyone = { [HOST]: FP_A, 'https://evil.ts.net': FP_A, 'https://host-1.other9999.ts.net': FP_A, 'http://100.70.1.2:7385': FP_A, 'https://host-1.tail1234.ts.net': FP_A }
    const host = fakeHost({ helloFp: everyone, approvalFp: FP_A, urls })
    const c = client(host.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y' }, { tailnetView: async () => ({ running: true, suffix: 'tail1234.ts.net', peerIps: new Set<string>([]), peerNames: new Set<string>() }) })
    expect(await runPair([HOST, '--yes'], c.io)).toBe(0)
    expect(loadRemotes(c.env).remotes['host-1'].url).toBe(HOST)
    // Without Tailscale: not even this tailnet's name or a listed peer address.
    const own = fakeHost({ helloFp: everyone, approvalFp: FP_A, urls: [{ url: 'https://host-1.tail1234.ts.net', kind: 'tailscale-https', encrypted: true }, ...urls] })
    const c2 = client(own.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y' }, { tailnetView: async () => ({ running: false, suffix: 'tail1234.ts.net', peerIps: new Set<string>(["100.70.1.2"]), peerNames: new Set<string>() }) })
    expect(await runPair([HOST, '--yes'], c2.io)).toBe(0)
    expect(loadRemotes(c2.env).remotes['host-1'].url).toBe(HOST)
    // This tailnet's own name qualifies (asked; --yes answers).
    const c3 = client(own.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y' }, { tailnetView: async () => ({ running: true, suffix: 'tail1234.ts.net', peerIps: new Set<string>([]), peerNames: new Set<string>() }) })
    expect(await runPair([HOST, '--yes'], c3.io)).toBe(0)
    expect(loadRemotes(c3.env).remotes['host-1'].url).toBe('https://host-1.tail1234.ts.net')
  })

  it('later commands refuse to send the saved token to a daemon with another fingerprint', async () => {
    const host = fakeHost({ helloFp: { [HOST]: FP_A }, approvalFp: FP_A })
    const c = client(host.fetchImpl, { 'Code shown': '123456', 'trust this network': 'y', 'by default': 'y' })
    expect(await runPair([HOST], c.io)).toBe(0)
    // The address now answers as another ADF computer (DHCP gave it away, or a spoof).
    const impostor = fakeHost({ helloFp: { [HOST]: FP_B }, approvalFp: FP_B })
    const err: string[] = []
    const code = await runCli(['--url', HOST, 'agents'], { fetch: impostor.fetchImpl, stdout: () => {}, stderr: (t) => err.push(t), env: c.env } as never)
    expect(code).toBe(1)
    expect(err.join('')).toMatch(/is not "host-1" .*fingerprint CCCC-DDDD, and AAAA-BBBB was saved .*The saved token was not sent/)
    expect(impostor.authSeen).toEqual([])
  })
})
