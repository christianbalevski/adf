// A leading ~/ in an MCP server's env values is its HOME, at every spawn
// (host, container) and every auth preflight (host, container); and the
// Google catalog servers are told where their client file is without the
// user typing it (mcp-server-home.ts, google-oauth-client.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const userData = mkdtempSync(join(tmpdir(), 'adf-envhome-'))
vi.mock('../../../src/main/utils/user-data-path', () => ({ getUserDataPath: () => userData }))

const { expandHomeInEnv } = await import('../../../src/main/utils/child-env')
const { McpClientManager } = await import('../../../src/main/services/mcp-client-manager')
const { runMcpAuthPreflight } = await import('../../../src/main/services/mcp-auth-preflight')
const { PodmanStdioTransport } = await import('../../../src/main/services/podman-stdio-transport')
const { mcpClientFileEnv, mcpContainerHomeEnv, mcpHostHomeEnv, mcpOwnHostHome } = await import('../../../src/main/services/mcp-server-home')

const posixOnly = process.platform === 'win32' ? describe.skip : describe
const CALENDAR = '@cocal/google-calendar-mcp'
const CALENDAR_KEYS = '~/.config/google-calendar-mcp/gcp-oauth.keys.json'
const VALUES = { TILDE: '~/x/y.json', ABS: '/abs/y.json', REL: 'rel/y.json', OTHER_USER: '~bob/y.json', BARE: '~', INNER: 'a~/b' }
const calendarCfg = (env?: Record<string, string>): McpServerConfig => ({
  name: 'google-calendar', transport: 'stdio', npm_package: CALENDAR, ...(env ? { env } : {}),
  credential_files: [{ path: CALENDAR_KEYS, required: true }, { path: '~/.config/google-calendar-mcp/tokens.json' }],
})

describe('expandHomeInEnv', () => {
  it('expands only a leading ~/ against HOME; ~user, a bare ~ and other values are unchanged', () => {
    expect(expandHomeInEnv({ HOME: '/home/s', ...VALUES })).toEqual({
      HOME: '/home/s', TILDE: '/home/s/x/y.json', ABS: '/abs/y.json', REL: 'rel/y.json', OTHER_USER: '~bob/y.json', BARE: '~', INNER: 'a~/b',
    })
  })

  it('falls back to USERPROFILE; without either the env is unchanged', () => {
    expect(expandHomeInEnv({ USERPROFILE: 'C:\\Users\\s\\', TILDE: '~/x' }).TILDE).toBe('C:\\Users\\s\\/x')
    expect(expandHomeInEnv({ TILDE: '~/x' })).toEqual({ TILDE: '~/x' })
  })

  it('a HOME of / still expands (the home is joined as is, separators untrimmed)', () => {
    expect(expandHomeInEnv({ HOME: '/', TILDE: '~/x' }).TILDE).toBe('//x')
    expect(expandHomeInEnv({ HOME: '/home/s/', TILDE: '~/x' }).TILDE).toBe('/home/s//x')
  })
})

describe('at spawn (McpClientManager, host)', () => {
  // Names its one tool after nothing; the description is the env it got.
  const SERVER = `
    const rl = require('readline').createInterface({ input: process.stdin })
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
    const keys = ${JSON.stringify([...Object.keys(VALUES), 'GOOGLE_OAUTH_CREDENTIALS', 'HOME'])}
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'env', version: '1' } } })
      else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'env', description: JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))), inputSchema: { type: 'object' } }] } })
      else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
    })`
  let manager: InstanceType<typeof McpClientManager> | null = null
  afterEach(async () => { await manager?.disconnectAll(); manager = null })
  const spawnEnv = async (env: Record<string, string>) => {
    manager = new McpClientManager()
    const tools = await manager.connect({ name: 'env', transport: 'stdio', command: process.execPath, args: ['-e', SERVER], env })
    return JSON.parse(tools![0].description!) as Record<string, string | null>
  }

  it('the server gets ~/ values under its HOME; others as configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'adf-envhome-spawn-'))
    expect(await spawnEnv({ HOME: home, ...VALUES })).toMatchObject({
      TILDE: `${home}/x/y.json`, ABS: '/abs/y.json', REL: 'rel/y.json', OTHER_USER: '~bob/y.json', BARE: '~', INNER: 'a~/b',
    })
  }, 30_000)

  it('Google Calendar from the catalog: GOOGLE_OAUTH_CREDENTIALS is its own home\'s client file, typed by nobody', async () => {
    const cfg = calendarCfg()
    const env = { ...mcpHostHomeEnv(cfg, { kind: 'app' }, { HOME: '/real' }) }
    const got = await spawnEnv(env)
    const home = mcpOwnHostHome('google-calendar', { kind: 'app' })
    expect(got.HOME).toBe(home)
    expect(got.GOOGLE_OAUTH_CREDENTIALS).toBe(`${home}/.config/google-calendar-mcp/gcp-oauth.keys.json`)
  }, 30_000)
})

describe('the client-file default (mcpClientFileEnv, via mcpHostHomeEnv / mcpContainerHomeEnv)', () => {
  const gmail = { name: 'gmail', npm_package: '@gongrzhe/server-gmail-autoauth-mcp', credential_files: [{ path: '~/.gmail-mcp/gcp-oauth.keys.json' }] }

  it('Calendar is pointed at its declared client file, on the host and in a container', () => {
    expect(mcpClientFileEnv(calendarCfg())).toEqual({ GOOGLE_OAUTH_CREDENTIALS: CALENDAR_KEYS })
    expect(mcpHostHomeEnv(calendarCfg(), { kind: 'app' }).GOOGLE_OAUTH_CREDENTIALS).toBe(CALENDAR_KEYS)
    expect(mcpContainerHomeEnv(calendarCfg(), '/w/home').GOOGLE_OAUTH_CREDENTIALS).toBe(CALENDAR_KEYS)
  })

  it('the server\'s own config env wins; an inherited process env does not', () => {
    const own = calendarCfg({ GOOGLE_OAUTH_CREDENTIALS: '/own.json' })
    expect(mcpClientFileEnv(own)).toEqual({})
    expect(mcpHostHomeEnv(own, { kind: 'app' })).not.toHaveProperty('GOOGLE_OAUTH_CREDENTIALS')
    expect(mcpContainerHomeEnv(own, '/w/home')).not.toHaveProperty('GOOGLE_OAUTH_CREDENTIALS')
    // An empty value is unset to the server, so the default still applies.
    expect(mcpClientFileEnv(calendarCfg({ GOOGLE_OAUTH_CREDENTIALS: '' }))).toEqual({ GOOGLE_OAUTH_CREDENTIALS: CALENDAR_KEYS })
    const inherited = { GOOGLE_OAUTH_CREDENTIALS: '/inherited.json' }
    expect(mcpHostHomeEnv(calendarCfg(), { kind: 'app' }, inherited).GOOGLE_OAUTH_CREDENTIALS).toBe(CALENDAR_KEYS)
    expect(mcpContainerHomeEnv(calendarCfg(), '/w/home', inherited).GOOGLE_OAUTH_CREDENTIALS).toBe(CALENDAR_KEYS)
  })

  it('only a server with its own home; Gmail and other servers get nothing', () => {
    expect(mcpClientFileEnv({ npm_package: CALENDAR })).toEqual({})
    expect(mcpClientFileEnv(gmail)).toEqual({})
    expect(Object.keys(mcpHostHomeEnv(gmail, { kind: 'app' })).filter((k) => /OAUTH/.test(k))).toEqual([])
    const other = { name: 'drive', npm_package: '@piotr-agier/google-drive-mcp', credential_files: [{ path: '~/.config/google-drive-mcp/gcp-oauth.keys.json' }] }
    expect(mcpClientFileEnv(other)).toEqual({})
  })
})

describe('at auth preflight (host)', () => {
  it('the sign-in command gets ~/ values under its HOME; others as configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-envhome-preflight-'))
    const out = join(dir, 'env.json')
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); process.exit(0)`
    await runMcpAuthPreflight(
      { name: 'p', transport: 'stdio', command: process.execPath, args: ['-e', script], env: { HOME: dir, ...VALUES } },
      {},
      { openUrl: () => {}, log: () => {}, startupGraceMs: 15_000 },
    )
    expect(JSON.parse(readFileSync(out, 'utf-8'))).toMatchObject({
      TILDE: `${dir}/x/y.json`, ABS: '/abs/y.json', REL: 'rel/y.json', OTHER_USER: '~bob/y.json', BARE: '~', INNER: 'a~/b',
    })
  }, 30_000)
})

posixOnly('containers', () => {
  it('auth preflight: the --env-file has ~/ under the server\'s container home, and Calendar its client file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-envhome-container-'))
    const copy = join(dir, 'env.txt')
    const fakePodman = join(dir, 'podman')
    writeFileSync(fakePodman, `#!/bin/sh\nprev=""\nfor a in "$@"; do if [ "$prev" = "--env-file" ]; then cp "$a" "${copy}"; fi; prev="$a"; done\nexit 0\n`)
    chmodSync(fakePodman, 0o755)
    const home = '/workspace/a1/home/.mcp-home/google-calendar'
    await runMcpAuthPreflight(calendarCfg({ TILDE: '~/x', OTHER_USER: '~bob/x' }), {
      authArgs: ['auth'],
      container: { podmanBin: fakePodman, containerName: 'adf-mcp', command: 'npx', args: ['-y', CALENDAR], home },
    }, { openUrl: () => {}, log: () => {}, startupGraceMs: 15_000 })
    expect(readFileSync(copy, 'utf-8').split('\n').filter(Boolean).sort()).toEqual([
      `GOOGLE_OAUTH_CREDENTIALS=${home}/.config/google-calendar-mcp/gcp-oauth.keys.json`,
      `HOME=${home}`,
      'OTHER_USER=~bob/x',
      `TILDE=${home}/x`,
    ])
  }, 30_000)

  it('auth preflight: no client-file default for a config without credential files (same gate as spawn)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-envhome-container-'))
    const copy = join(dir, 'env.txt')
    const fakePodman = join(dir, 'podman')
    writeFileSync(fakePodman, `#!/bin/sh\nprev=""\nfor a in "$@"; do if [ "$prev" = "--env-file" ]; then cp "$a" "${copy}"; fi; prev="$a"; done\nexit 0\n`)
    chmodSync(fakePodman, 0o755)
    const { credential_files: _files, ...noFiles } = calendarCfg()
    expect(mcpContainerHomeEnv(noFiles, '/w/home')).toEqual({})
    await runMcpAuthPreflight(noFiles, {
      authArgs: ['auth'],
      container: { podmanBin: fakePodman, containerName: 'adf-mcp', command: 'npx', args: ['-y', CALENDAR], home: '/w/home' },
    }, { openUrl: () => {}, log: () => {}, startupGraceMs: 15_000 })
    expect(readFileSync(copy, 'utf-8').split('\n').filter(Boolean)).toEqual(['HOME=/w/home'])
  }, 30_000)

  it('spawn: PodmanStdioTransport writes ~/ values under the container HOME', () => {
    const t = new PodmanStdioTransport({ podmanBin: 'podman', containerName: 'adf-mcp', command: 'npx', args: [], env: { HOME: '/w/home', ...VALUES } })
    const file = (t as unknown as { ensureEnvFile(): string | null }).ensureEnvFile()!
    try {
      expect(readFileSync(file, 'utf-8').split('\n').filter(Boolean).sort()).toEqual([
        'ABS=/abs/y.json', 'BARE=~', 'HOME=/w/home', 'INNER=a~/b', 'OTHER_USER=~bob/y.json', 'REL=rel/y.json', 'TILDE=/w/home/x/y.json',
      ])
    } finally {
      (t as unknown as { cleanupEnvFile(): void }).cleanupEnvFile()
    }
  })
})
