import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { CodeSandboxService } from '../src/main/runtime/code-sandbox'
import { daemonGapRouteDeps } from '../src/main/daemon/routes/gap-deps'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  // The daemon never uses the OS trash: a call here would be a bug.
  shell: { openExternal: async () => {}, trashItem: async () => { throw new Error('OS trash used by the daemon') } },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

import { FileSettingsStore } from '../src/main/daemon/file-settings-store'
import { ensureDaemonEncKey } from '../src/main/daemon/daemon-enc-key'
import { DaemonIdentity } from '../src/main/daemon/daemon-identity'
import { DaemonAgentFactory } from '../src/main/daemon/daemon-agent-factory'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { AdfDatabase } from '../src/main/adf/adf-database'
import { KeychainSecretBackend } from '../src/main/services/owner-secret-store'

function fakeKeychain() {
  const store = new Map<string, string>()
  class Entry {
    constructor(private service: string, private account: string) {}
    getPassword() { return store.get(`${this.service}/${this.account}`) ?? null }
    setPassword(p: string) { store.set(`${this.service}/${this.account}`, p) }
    deleteCredential() { return store.delete(`${this.service}/${this.account}`) }
  }
  return new KeychainSecretBackend(Entry)
}

let root: string
const servers: Array<{ close: () => Promise<unknown> }> = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-daemon-oauth-wiring-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  process.env.ADF_USER_DATA_DIR = h.userDataDir
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  delete process.env.ADF_USER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

// MCP OAuth status and sign-out with the wiring daemon/index.ts uses: the
// owner identity's DaemonAppOAuthStore (ownerIdentity.mcpOAuth) passed as
// routes.gaps.mcpAppOAuthStore through daemonGapRouteDeps.
describe('MCP OAuth routes with the daemon wiring', () => {
  it('status reads the DaemonAppOAuthStore as a flag only; sign-out clears it', async () => {
    const settingsPath = join(h.userDataDir, 'adf-settings.json')
    const settings = new FileSettingsStore(settingsPath)
    const identity = new DaemonIdentity({ settings, settingsPath, encKey: ensureDaemonEncKey(h.userDataDir), backend: fakeKeychain() })
    const gaps = daemonGapRouteDeps({
      codeSandboxService: new CodeSandboxService(),
      meshServer: { stop: async () => {} },
      uvManager: { ensureUv: async () => 'uv', getUvVersion: async () => null, isPythonAvailable: async () => true, ensurePython: async () => {} },
      mcpAppOAuthStore: identity.mcpOAuth,
    })
    expect(gaps.mcpAppOAuthStore).toBe(identity.mcpOAuth)
    const server = createDaemonHttpApi(new RuntimeService({ settings }), { settingsStore: settings, identity, routes: { gaps } })
    servers.push(server)

    const url = 'https://mcp.example.test/mcp'
    const q = `?url=${encodeURIComponent(url)}`
    expect((await server.inject({ method: 'GET', url: `/admin/mcp/oauth/status${q}` })).json()).toEqual({ signedIn: false })

    const TOKEN = 'at-SECRET-wiring-1'
    await identity.mcpOAuth.save(url, { tokens: { access_token: TOKEN, token_type: 'bearer', refresh_token: TOKEN }, serverUrl: url, updatedAt: Date.now() })
    const status = await server.inject({ method: 'GET', url: `/admin/mcp/oauth/status${q}` })
    expect(status.json()).toEqual({ signedIn: true })
    expect(status.body).not.toContain(TOKEN)

    expect((await server.inject({ method: 'POST', url: '/admin/mcp/oauth/signout', payload: { url } })).json()).toEqual({ success: true })
    expect((await server.inject({ method: 'GET', url: `/admin/mcp/oauth/status${q}` })).json()).toEqual({ signedIn: false })
    expect(await identity.mcpOAuth.get(url)).toBeUndefined()
  })

  it('daemon/index.ts passes ownerIdentity.mcpOAuth as mcpAppOAuthStore', () => {
    const source = readFileSync(join(__dirname, '../src/main/daemon/index.ts'), 'utf-8')
    expect(source).toMatch(/daemonGapRouteDeps\(\{ codeSandboxService, meshServer, uvManager, mcpAppOAuthStore: ownerIdentity\.mcpOAuth \}\)/)
  })
})
