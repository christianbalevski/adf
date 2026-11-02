// The Gmail catalog server's built-in Desktop OAuth client: build-time
// parsing, the host write-if-absent fallback, the registry availability flag
// and the Add MCP Server checklist. Synthetic client only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GMAIL_BUNDLED_CLIENT_NPM_PACKAGE,
  GMAIL_BUNDLED_CLIENT_PATH,
  parseGmailOAuthClientJson,
} from '../../../src/shared/utils/gmail-oauth-client'
import { bundledClientApplies, bundledCredentialFiles, compiledGmailOAuthClient, writeBundledClientIfAbsent } from '../../../src/main/services/gmail-bundled-client'
import { materializeCredentialFiles, type CredentialStore } from '../../../src/main/services/mcp-credential-files'
import { McpRegistryFetchService } from '../../../src/main/services/mcp-registry-fetch.service'
import { MCP_REGISTRY, registrationFromRegistryEntry } from '../../../src/shared/constants/mcp-registry'
import { bundledFilePaths, setupChecklist } from '../../../src/renderer/components/mcp/McpAddServerModal'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const SECRET = 'synthetic-desktop-secret-123'
const CLIENT = {
  installed: {
    client_id: '000000000000-synthetic.apps.googleusercontent.com',
    project_id: 'synthetic-project',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    client_secret: SECRET,
    redirect_uris: ['http://localhost'],
  },
}
const CLIENT_JSON = parseGmailOAuthClientJson(JSON.stringify(CLIENT))!
const KEYS_REL = '.gmail-mcp/gcp-oauth.keys.json'
const TOKENS_REL = '.gmail-mcp/credentials.json'

function gmailServer(): McpServerConfig {
  return {
    name: 'gmail',
    transport: 'stdio',
    npm_package: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE,
    credential_files: [{ path: GMAIL_BUNDLED_CLIENT_PATH, required: true }, { path: '~/.gmail-mcp/credentials.json' }],
  }
}
const emptyStore: CredentialStore = { getDecrypted: () => null, hasRow: () => false }

describe('parseGmailOAuthClientJson (build-time ADF_GMAIL_OAUTH_CLIENT_JSON)', () => {
  it('unset or blank: no built-in client, the manual flow stays', () => {
    expect(parseGmailOAuthClientJson(undefined)).toBeUndefined()
    expect(parseGmailOAuthClientJson('')).toBeUndefined()
    expect(parseGmailOAuthClientJson('  \n')).toBeUndefined()
  })

  it('a Desktop ("installed") client is kept as {"installed": ...} only', () => {
    expect(JSON.parse(parseGmailOAuthClientJson(JSON.stringify({ ...CLIENT, extra: 1 }))!)).toEqual(CLIENT)
  })

  it('rejects malformed or non-Desktop input without echoing it', () => {
    const cases: [string, RegExp][] = [
      [`{"installed": {"client_secret": "${SECRET}"`, /not valid JSON/],
      ['[1,2]', /expected a JSON object/],
      [JSON.stringify({ web: CLIENT.installed }), /Web application client/],
      [JSON.stringify({ other: CLIENT.installed }), /no "installed" client/],
      [JSON.stringify({ installed: { ...CLIENT.installed, client_id: `${SECRET}.example.com` } }), /client_id/],
      [JSON.stringify({ installed: { ...CLIENT.installed, client_secret: '' } }), /client_secret is missing/],
      [JSON.stringify({ installed: { ...CLIENT.installed, refresh_token: SECRET } }), /carries tokens/],
      [JSON.stringify({ ...CLIENT, access_token: SECRET }), /carries tokens/],
    ]
    for (const [raw, why] of cases) {
      let message = ''
      try { parseGmailOAuthClientJson(raw) } catch (err) { message = (err as Error).message }
      expect(message).toMatch(/^ADF_GMAIL_OAUTH_CLIENT_JSON is not a Google Desktop OAuth client JSON: /)
      expect(message).toMatch(why)
      expect(message).not.toContain(SECRET)
      expect(message).not.toContain('synthetic')
    }
  })
})

describe('built-in client availability', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('builds without the define (tests, npm CLI) have none', () => {
    expect(compiledGmailOAuthClient()).toBeUndefined()
    expect(bundledCredentialFiles()).toEqual([])
    expect(bundledClientApplies(GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH)).toBe(false)
  })

  it('reads the compiled constant and applies only to the Gmail package and its client path', () => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', CLIENT_JSON)
    expect(compiledGmailOAuthClient()).toBe(CLIENT_JSON)
    expect(bundledCredentialFiles()).toEqual([{ npmPackage: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, path: GMAIL_BUNDLED_CLIENT_PATH }])
    expect(bundledClientApplies(GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH)).toBe(true)
    expect(bundledClientApplies(GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, '~/.gmail-mcp/credentials.json')).toBe(false)
    expect(bundledClientApplies('@other/gmail-mcp', GMAIL_BUNDLED_CLIENT_PATH)).toBe(false)
    expect(bundledClientApplies(undefined, GMAIL_BUNDLED_CLIENT_PATH)).toBe(false)
  })
})

describe('host fallback', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'adf-gmail-bundled-')) })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it('writeBundledClientIfAbsent writes 0600 once and never replaces an existing file', () => {
    const dest = join(home, KEYS_REL)
    expect(writeBundledClientIfAbsent(GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH, dest, CLIENT_JSON)).toBe(true)
    expect(JSON.parse(readFileSync(dest, 'utf-8'))).toEqual(CLIENT)
    if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o600)
    writeFileSync(dest, 'user-client')
    expect(writeBundledClientIfAbsent(GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH, dest, CLIENT_JSON)).toBe(false)
    expect(readFileSync(dest, 'utf-8')).toBe('user-client')
  })

  it('writes nothing without a client or for another package/path', () => {
    const dest = join(home, KEYS_REL)
    expect(writeBundledClientIfAbsent(GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH, dest, undefined)).toBe(false)
    expect(writeBundledClientIfAbsent('@other/pkg', GMAIL_BUNDLED_CLIENT_PATH, dest, CLIENT_JSON)).toBe(false)
    expect(writeBundledClientIfAbsent(GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, '~/.gmail-mcp/credentials.json', join(home, TOKENS_REL), CLIENT_JSON)).toBe(false)
    expect(existsSync(join(home, '.gmail-mcp'))).toBe(false)
  })

  it('materializeCredentialFiles (attach/restart): fills the missing client on the host, leaves tokens alone', async () => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', CLIENT_JSON)
    await materializeCredentialFiles(emptyStore, gmailServer(), { kind: 'host', home })
    expect(JSON.parse(readFileSync(join(home, KEYS_REL), 'utf-8'))).toEqual(CLIENT)
    expect(existsSync(join(home, TOKENS_REL))).toBe(false)
  })

  it('materializeCredentialFiles keeps an existing host client and token file byte-for-byte', async () => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', CLIENT_JSON)
    mkdirSync(join(home, '.gmail-mcp'))
    writeFileSync(join(home, KEYS_REL), 'own-client')
    writeFileSync(join(home, TOKENS_REL), 'own-tokens')
    await materializeCredentialFiles(emptyStore, gmailServer(), { kind: 'host', home })
    expect(readFileSync(join(home, KEYS_REL), 'utf-8')).toBe('own-client')
    expect(readFileSync(join(home, TOKENS_REL), 'utf-8')).toBe('own-tokens')
  })

  it('without a built-in client the missing required file still fails plainly', async () => {
    await expect(materializeCredentialFiles(emptyStore, gmailServer(), { kind: 'host', home })).rejects.toThrow(/Required credential file "~\/.gmail-mcp\/gcp-oauth.keys.json"/)
    expect(existsSync(join(home, KEYS_REL))).toBe(false)
  })

  it('a locked keystore row is not papered over by the built-in client', async () => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', CLIENT_JSON)
    const locked: CredentialStore = { getDecrypted: () => null, hasRow: (p) => p.endsWith(GMAIL_BUNDLED_CLIENT_PATH) }
    await expect(materializeCredentialFiles(locked, gmailServer(), { kind: 'host', home })).rejects.toThrow(/locked/)
    expect(existsSync(join(home, KEYS_REL))).toBe(false)
  })
})

describe('MCP_REGISTRY_GET bundledCredentialFiles', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adf-mcp-registry-bundled-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const files = [{ npmPackage: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, path: GMAIL_BUNDLED_CLIENT_PATH }]

  it('comes from the build, whichever tier served the entries; a remote document cannot set it', async () => {
    const remoteDoc = { schemaVersion: 1, updatedAt: '2027-01-01', bundledCredentialFiles: [{ npmPackage: '@evil/pkg', path: '~/.ssh/x' }], entries: MCP_REGISTRY }
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(remoteDoc), { status: 200 })) as unknown as typeof fetch
    const withClient = await new McpRegistryFetchService({ userDataDir: dir, fetchFn, bundledFiles: () => files }).getRegistry()
    expect(withClient.source).toBe('remote')
    expect(withClient.bundledCredentialFiles).toEqual(files)
    const svc = new McpRegistryFetchService({ userDataDir: dir, fetchFn, bundledFiles: () => [] })
    expect((await svc.getRegistry()).bundledCredentialFiles).toBeUndefined()
    // Memoized result: still not from the document.
    expect((await svc.getRegistry()).bundledCredentialFiles).toBeUndefined()
    const offline = await new McpRegistryFetchService({ userDataDir: dir, isRemoteEnabled: () => false, bundledFiles: () => files }).getRegistry()
    expect(offline.bundledCredentialFiles).toEqual(files)
  })

  it('the public mcp-registry.json carries no client', () => {
    const doc = readFileSync(join(__dirname, '../../../mcp-registry.json'), 'utf-8')
    expect(doc).not.toMatch(/client_secret|apps\.googleusercontent\.com|"installed"|bundledCredentialFiles/)
  })
})

describe('Add MCP Server: Gmail with a built-in client', () => {
  const gmail = MCP_REGISTRY.find((e) => e.npmPackage === GMAIL_BUNDLED_CLIENT_NPM_PACKAGE)!
  const draft = registrationFromRegistryEntry(gmail, 'mcp:gmail')
  const files = [{ npmPackage: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, path: GMAIL_BUNDLED_CLIENT_PATH }]

  it('bundledFilePaths matches the draft package, declared path and host location only', () => {
    expect(draft.runLocation).toBe('host')
    expect([...bundledFilePaths(draft, files, true)]).toEqual([GMAIL_BUNDLED_CLIENT_PATH])
    expect(bundledFilePaths(draft, undefined, true).size).toBe(0)
    expect(bundledFilePaths({ ...draft, npmPackage: '@other/gmail' }, files, true).size).toBe(0)
    expect(bundledFilePaths({ ...draft, credentialFiles: [{ path: '~/.other/keys.json', required: true }] }, files, true).size).toBe(0)
    expect(bundledFilePaths({ ...draft, runLocation: 'shared' }, files, true).size).toBe(0)
  })

  it('a host draft with Host access off runs in the container, so the client file stays required', () => {
    for (const hostAccess of [false, undefined]) {
      const bundled = bundledFilePaths(draft, files, hostAccess)
      expect(bundled.size).toBe(0)
      const result = setupChecklist(draft, gmail, {}, bundled)
      expect(result.requiredFiles).toEqual([GMAIL_BUNDLED_CLIENT_PATH])
      expect(result.inputsDone).toBe(false)
    }
  })

  it('the client file no longer holds the setup open; choosing one still works', () => {
    const bundled = bundledFilePaths(draft, files, true)
    const result = setupChecklist(draft, gmail, {}, bundled)
    expect(result.requiredFiles).toEqual([])
    expect(result.inputsDone).toBe(true)
    const own = { fileName: 'keys.json', size: 100, contentB64: 'AAAA' }
    expect(setupChecklist(draft, gmail, { [GMAIL_BUNDLED_CLIENT_PATH]: own }, bundled).inputsDone).toBe(true)
  })

  it('without a built-in client the file is required as before', () => {
    const result = setupChecklist(draft, gmail, {}, bundledFilePaths(draft, undefined, true))
    expect(result.requiredFiles).toEqual([GMAIL_BUNDLED_CLIENT_PATH])
    expect(result.inputsDone).toBe(false)
  })
})

describe('mcp-registry store: bundledCredentialFiles follows the runtime', () => {
  it('takes the flag from each result and clears it when the next runtime reports none', async () => {
    const { useMcpRegistryStore } = await import('../../../src/renderer/stores/mcp-registry.store')
    const files = [{ npmPackage: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, path: GMAIL_BUNDLED_CLIENT_PATH }]
    const withClient = { getMcpRegistry: async () => ({ entries: MCP_REGISTRY, source: 'remote' as const, bundledCredentialFiles: files }) }
    const without = { getMcpRegistry: async () => ({ entries: MCP_REGISTRY, source: 'remote' as const }) }
    await useMcpRegistryStore.getState().refresh(withClient)
    expect(useMcpRegistryStore.getState().bundledCredentialFiles).toEqual(files)
    await useMcpRegistryStore.getState().refresh(without)
    expect(useMcpRegistryStore.getState().bundledCredentialFiles).toBeUndefined()
  })
})

describe('electron.vite.config.ts define', () => {
  const saved = process.env.ADF_GMAIL_OAUTH_CLIENT_JSON
  afterEach(() => {
    if (saved === undefined) delete process.env.ADF_GMAIL_OAUTH_CLIENT_JSON
    else process.env.ADF_GMAIL_OAUTH_CLIENT_JSON = saved
    vi.resetModules()
  })

  type ConfigFn = (env: { mode: string; command: string }) => { main?: { define?: Record<string, string> }; renderer?: { define?: Record<string, string> }; preload?: { define?: Record<string, string> } }
  const load = async (): Promise<ConfigFn> => {
    vi.resetModules()
    return (await import('../../../electron.vite.config')).default as unknown as ConfigFn
  }

  it('Studio main and the daemon both get the same client; renderer and preload get none', async () => {
    process.env.ADF_GMAIL_OAUTH_CLIENT_JSON = JSON.stringify(CLIENT)
    const config = await load()
    const studio = config({ mode: 'production', command: 'build' })
    const daemon = config({ mode: 'adf-daemon', command: 'build' })
    expect(studio.main?.define?.__ADF_GMAIL_OAUTH_CLIENT__).toBe(JSON.stringify(CLIENT_JSON))
    expect(daemon.main?.define?.__ADF_GMAIL_OAUTH_CLIENT__).toBe(JSON.stringify(CLIENT_JSON))
    expect(daemon.main?.define?.__ADF_VERSION__).toBeDefined()
    expect(JSON.stringify(studio.renderer ?? {})).not.toContain(SECRET)
    expect(JSON.stringify(studio.preload ?? {})).not.toContain(SECRET)
  })

  it('without the secret both builds define it as undefined', async () => {
    delete process.env.ADF_GMAIL_OAUTH_CLIENT_JSON
    const config = await load()
    expect(config({ mode: 'production', command: 'build' }).main?.define?.__ADF_GMAIL_OAUTH_CLIENT__).toBe('undefined')
    expect(config({ mode: 'adf-daemon', command: 'build' }).main?.define?.__ADF_GMAIL_OAUTH_CLIENT__).toBe('undefined')
  })

  it('a malformed secret fails the build without printing it', async () => {
    process.env.ADF_GMAIL_OAUTH_CLIENT_JSON = `{"web": {"client_secret": "${SECRET}"}}`
    const err = await load().then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/ADF_GMAIL_OAUTH_CLIENT_JSON is not a Google Desktop OAuth client JSON/)
    expect(err?.message).not.toContain(SECRET)
  })
})
