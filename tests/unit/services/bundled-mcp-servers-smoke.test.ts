// The bundling script's real output, run the way Studio runs it: the Electron
// binary from node_modules with ELECTRON_RUN_AS_NODE=1, dummy Gmail credential
// files under a throwaway HOME (never a real account). Skipped where the
// Electron binary was not downloaded.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const root = resolve(__dirname, '../../..')
const electronBin = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.platform === 'darwin'
    ? join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(root, 'node_modules', 'electron', 'dist', 'electron')

describe.skipIf(!existsSync(electronBin))('bundled Gmail server on Electron-as-Node', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-gmail-bundle-smoke-'))
    execFileSync(process.execPath, [join(root, 'scripts', 'bundle-mcp-servers.mjs'), '--out', join(dir, 'mcp-servers')], { stdio: 'pipe' })
  }, 120_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes one ESM entry and the third-party notices', () => {
    expect(existsSync(join(dir, 'mcp-servers', 'gmail', 'index.mjs'))).toBe(true)
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
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: '1', GMAIL_OAUTH_PATH: keys, GMAIL_CREDENTIALS_PATH: creds },
      stdio: ['pipe', 'pipe', 'pipe'],
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
})
