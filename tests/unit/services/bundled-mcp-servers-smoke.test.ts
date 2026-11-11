// The bundling script's real output, run the way Studio runs it: the Electron
// binary from node_modules with ELECTRON_RUN_AS_NODE=1, dummy Google credential
// files under a throwaway HOME (never a real account). Skipped where the
// Electron binary was not downloaded.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const root = resolve(__dirname, '../../..')
const electronBin = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.platform === 'darwin'
    ? join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(root, 'node_modules', 'electron', 'dist', 'electron')

describe.skipIf(!existsSync(electronBin))('bundled Gmail and Google Calendar servers on Electron-as-Node', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-gmail-bundle-smoke-'))
    execFileSync(process.execPath, [join(root, 'scripts', 'bundle-mcp-servers.mjs'), '--out', join(dir, 'mcp-servers')], { stdio: 'pipe', windowsHide: true })
  }, 120_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes one ESM entry and the third-party notices', () => {
    expect(existsSync(join(dir, 'mcp-servers', 'gmail', 'index.mjs'))).toBe(true)
    const code = readFileSync(join(dir, 'mcp-servers', 'gmail', 'index.mjs'), 'utf-8')
    expect(code.slice(0, 1000)).toContain('delete process.env.ELECTRON_RUN_AS_NODE;')
    expect(code).toContain('listen(3e3,process.argv[3]?void 0:"127.0.0.1")')
    const notices = readFileSync(join(dir, 'mcp-servers', 'gmail', 'THIRD_PARTY_NOTICES.txt'), 'utf-8')
    expect(notices).toContain('@gongrzhe/server-gmail-autoauth-mcp@1.1.11')
    expect(notices).toContain('googleapis@')
  })

  it('answers initialize and tools/list over stdio', async () => {
    const home = join(dir, 'home')
    const keys = join(dir, 'gcp-oauth.keys.json')
    const creds = join(dir, 'credentials.json')
    writeFileSync(keys, JSON.stringify({ installed: { client_id: '0-dummy.apps.googleusercontent.com', client_secret: 'dummy', redirect_uris: ['http://localhost'] } }))
    writeFileSync(creds, JSON.stringify({ access_token: 'dummy', refresh_token: 'dummy', token_type: 'Bearer', expiry_date: 1 }))
    const child = spawn(electronBin, [join(dir, 'mcp-servers', 'gmail', 'index.mjs')], {
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: '1', GMAIL_OAUTH_PATH: keys, GMAIL_CREDENTIALS_PATH: creds, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const replies = new Map<number, { result?: { serverInfo?: { name: string }; tools?: { name: string }[] }; error?: unknown }>()
    let buffer = ''
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.stdout.on('data', (c: Buffer) => {
      buffer += c.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (typeof msg.id === 'number') replies.set(msg.id, msg)
      }
    })
    const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    const waitFor = async (id: number) => {
      const deadline = Date.now() + 30_000
      while (!replies.has(id)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no reply ${id}; stderr: ${stderr}`)
        await new Promise((r) => setTimeout(r, 50))
      }
      return replies.get(id)!
    }
    try {
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adf-test', version: '0' } } })
      expect((await waitFor(1)).result?.serverInfo?.name).toBe('gmail')
      send({ method: 'notifications/initialized' })
      send({ id: 2, method: 'tools/list' })
      const tools = (await waitFor(2)).result?.tools?.map((t) => t.name) ?? []
      expect(tools).toContain('send_email')
      expect(tools).toContain('search_emails')
    } finally {
      child.kill()
    }
  }, 60_000)

  // `auth` starts the callback server on :3000 and opens the browser. Linux
  // only: elsewhere `open` would start a real browser (the opener is not
  // xdg-open there).
  describe.runIf(process.platform === 'linux')('auth', () => {
    const bin = () => join(dir, 'bin')
    const home = () => join(dir, 'auth-home')
    beforeAll(() => {
      mkdirSync(join(home(), '.gmail-mcp'), { recursive: true })
      writeFileSync(join(home(), '.gmail-mcp', 'gcp-oauth.keys.json'), JSON.stringify({ installed: { client_id: '0-dummy.apps.googleusercontent.com', client_secret: 'dummy', redirect_uris: ['http://localhost'] } }))
      mkdirSync(bin(), { recursive: true })
    })
    const startAuth = (): { child: ChildProcess; output: () => string } => {
      const child = spawn(electronBin, [join(dir, 'mcp-servers', 'gmail', 'index.mjs'), 'auth'], {
        env: { PATH: bin(), HOME: home(), ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let output = ''
      child.stdout!.on('data', (c: Buffer) => { output += c.toString() })
      child.stderr!.on('data', (c: Buffer) => { output += c.toString() })
      return { child, output: () => output }
    }
    const stop = async (child: ChildProcess) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r))
        child.kill()
        await exited
      }
    }
    const waitUntil = async (cond: () => boolean, what: string) => {
      const deadline = Date.now() + 15_000
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    const canConnect = (host: string) => new Promise<boolean>((done) => {
      const s = connect(3000, host)
      s.once('connect', () => { s.destroy(); done(true) })
      s.once('error', () => done(false))
    })

    it('survives a missing xdg-open and listens on 127.0.0.1 only', async () => {
      const { child, output } = startAuth()
      try {
        await waitUntil(() => /Could not open a browser/.test(output()) || child.exitCode !== null, 'the opener error')
        await new Promise((r) => setTimeout(r, 1500))
        expect(child.exitCode, output()).toBeNull()
        expect(output()).toContain('Please visit this URL to authenticate:')
        expect(await canConnect('127.0.0.1')).toBe(true)
        // Bound to loopback, not every interface: 127.0.0.1:3000 in LISTEN, no IPv6 wildcard.
        const v4 = readFileSync('/proc/net/tcp', 'utf-8').split('\n').filter((l) => / 0A /.test(l))
        expect(v4.some((l) => l.includes(' 0100007F:0BB8 '))).toBe(true)
        expect(v4.some((l) => l.includes(' 00000000:0BB8 '))).toBe(false)
        const v6 = existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf-8').split('\n').filter((l) => / 0A /.test(l)) : []
        expect(v6.some((l) => / [0-9A-F]{32}:0BB8 /.test(l))).toBe(false)
      } finally {
        await stop(child)
      }
    }, 30_000)

    it('the browser opener does not inherit ELECTRON_RUN_AS_NODE', async () => {
      const record = join(dir, 'opener-env.txt')
      writeFileSync(join(bin(), 'xdg-open'), `#!/bin/sh\necho "ELECTRON_RUN_AS_NODE=\${ELECTRON_RUN_AS_NODE-unset}" > '${record}'\n`)
      chmodSync(join(bin(), 'xdg-open'), 0o755)
      const { child, output } = startAuth()
      try {
        await waitUntil(() => existsSync(record) || child.exitCode !== null, 'the opener')
        expect(child.exitCode, output()).toBeNull()
        await waitUntil(() => readFileSync(record, 'utf-8').includes('\n'), 'the opener output')
        expect(readFileSync(record, 'utf-8').trim()).toBe('ELECTRON_RUN_AS_NODE=unset')
      } finally {
        await stop(child)
        rmSync(join(bin(), 'xdg-open'), { force: true })
      }
    }, 30_000)
  })

  describe('Google Calendar', () => {
    const calDir = () => join(dir, 'mcp-servers', 'google-calendar')
    const KEYS = JSON.stringify({ installed: { client_id: '0-dummy.apps.googleusercontent.com', client_secret: 'dummy', redirect_uris: ['http://localhost'] } })
    const home = () => join(dir, 'calendar-home')
    const keys = () => join(home(), '.config', 'google-calendar-mcp', 'gcp-oauth.keys.json')
    beforeAll(() => {
      mkdirSync(join(home(), '.config', 'google-calendar-mcp'), { recursive: true })
      writeFileSync(keys(), KEYS)
    })
    const run = (args: string[], env: Record<string, string>): { child: ChildProcess; output: () => string } => {
      const child = spawn(electronBin, [join(calDir(), 'index.mjs'), ...args], {
        env: { HOME: home(), ELECTRON_RUN_AS_NODE: '1', GOOGLE_OAUTH_CREDENTIALS: keys(), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let output = ''
      child.stdout!.on('data', (c: Buffer) => { output += c.toString() })
      child.stderr!.on('data', (c: Buffer) => { output += c.toString() })
      return { child, output: () => output }
    }
    const stop = async (child: ChildProcess) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r))
        child.kill()
        await exited
      }
    }
    const waitUntil = async (cond: () => boolean, what: string) => {
      const deadline = Date.now() + 20_000
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    it('writes the entry, the files it reads beside itself, and the notices', () => {
      const code = readFileSync(join(calDir(), 'index.mjs'), 'utf-8')
      expect(code.slice(0, 1000)).toContain('delete process.env.ELECTRON_RUN_AS_NODE;')
      // The three patches: callback bound to loopback unless a public
      // redirect base is set; both package.json reads beside the entry.
      expect(code).toContain('this.redirectBase?void 0:"127.0.0.1"')
      expect(code).not.toContain('"..","package.json"')
      expect(JSON.parse(readFileSync(join(calDir(), 'package.json'), 'utf-8')).version).toBe('2.8.1')
      for (const page of ['auth-landing.html', 'auth-success.html', 'auth-error.html', 'styles.css']) expect(existsSync(join(calDir(), 'web', page))).toBe(true)
      const notices = readFileSync(join(calDir(), 'THIRD_PARTY_NOTICES.txt'), 'utf-8')
      expect(notices).toContain('@cocal/google-calendar-mcp@2.8.1')
      expect(notices).toContain('googleapis@')
    })

    it('answers initialize and tools/list over stdio', async () => {
      const { child, output } = run([], { PATH: process.env.PATH ?? '' })
      const lines = () => output().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
      const send = (m: object) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
      try {
        send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adf-test', version: '0' } } })
        await waitUntil(() => lines().some((m) => m.id === 1) || child.exitCode !== null, 'initialize')
        expect(lines().find((m) => m.id === 1)?.result?.serverInfo, output()).toEqual({ name: 'google-calendar', version: '2.8.1' })
        send({ method: 'notifications/initialized' })
        send({ id: 2, method: 'tools/list' })
        await waitUntil(() => lines().some((m) => m.id === 2) || child.exitCode !== null, 'tools/list')
        const tools = (lines().find((m) => m.id === 2)?.result?.tools ?? []).map((t: { name: string }) => t.name)
        expect(tools).toContain('list-events')
        expect(tools).toContain('create-event')
      } finally {
        await stop(child)
      }
    }, 60_000)

    // Up to the browser: the URL is handed to xdg-open (a stub that records
    // it) and the callback server serves its pages on loopback only.
    it.runIf(process.platform === 'linux')('auth: opens the sign-in URL, serves its pages on 127.0.0.1 only', async () => {
      const bin = join(dir, 'calendar-bin')
      const record = join(dir, 'calendar-opener.txt')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'xdg-open'), `#!/bin/sh\necho "$1 ELECTRON_RUN_AS_NODE=\${ELECTRON_RUN_AS_NODE-unset}" > '${record}'\n`)
      chmodSync(join(bin, 'xdg-open'), 0o755)
      const { child, output } = run(['auth'], { PATH: bin })
      try {
        await waitUntil(() => (existsSync(record) && readFileSync(record, 'utf-8').includes('\n')) || child.exitCode !== null, 'the opener')
        expect(child.exitCode, output()).toBeNull()
        const [url, runAsNode] = readFileSync(record, 'utf-8').trim().split(' ')
        expect(runAsNode).toBe('ELECTRON_RUN_AS_NODE=unset')
        const auth = new URL(url)
        expect(auth.origin).toBe('https://accounts.google.com')
        expect(auth.searchParams.get('client_id')).toBe('0-dummy.apps.googleusercontent.com')
        expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:3500/oauth2callback')
        const landing = await fetch('http://127.0.0.1:3500/')
        expect(landing.status).toBe(200)
        expect(await landing.text()).toContain('accounts.google.com')
        const refused = await fetch('http://127.0.0.1:3500/oauth2callback?code=x&state=forged')
        expect(refused.status).toBe(403)
        expect(await refused.text()).toContain('Invalid state parameter')
        // 127.0.0.1:3500 (0DAC) in LISTEN, not every interface.
        const v4 = readFileSync('/proc/net/tcp', 'utf-8').split('\n').filter((l) => / 0A /.test(l))
        expect(v4.some((l) => l.includes(' 0100007F:0DAC '))).toBe(true)
        expect(v4.some((l) => l.includes(' 00000000:0DAC '))).toBe(false)
        const v6 = existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf-8').split('\n').filter((l) => / 0A /.test(l)) : []
        expect(v6.some((l) => / [0-9A-F]{32}:0DAC /.test(l))).toBe(false)
      } finally {
        await stop(child)
      }
    }, 60_000)
  })
})
