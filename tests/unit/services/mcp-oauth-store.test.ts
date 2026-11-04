import { describe, expect, it } from 'vitest'
import {
  AppSettingsOAuthStore,
  AgentKeystoreOAuthStore,
  DaemonAppOAuthStore,
  captureOAuthToAgent,
  oauthKeystorePurpose,
  resolveOAuthStoreForConnect,
  MCP_OAUTH_SETTINGS_KEY,
  type OAuthSettingsHandle,
  type OAuthKeystoreHandle,
} from '../../../src/main/services/mcp-oauth-store'
import type { McpOAuthRecord } from '../../../src/main/services/mcp-oauth.types'

const URL_A = 'https://mcp.linear.app/sse'
const URL_B = 'https://mcp.notion.com/sse'

function record(overrides: Partial<McpOAuthRecord> = {}): McpOAuthRecord {
  return {
    tokens: { access_token: 'at', token_type: 'bearer', refresh_token: 'rt' } as McpOAuthRecord['tokens'],
    clientInformation: { client_id: 'cid' } as McpOAuthRecord['clientInformation'],
    updatedAt: 1000,
    ...overrides,
  }
}

/** SettingsService-shaped mock backed by a Map (secrets storable by default). */
function memSettings(safeStorage = true): OAuthSettingsHandle & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getSecret: (k) => map.get(k) ?? null,
    secretStatus: (k) => map.has(k) ? 'ok' : 'absent',
    setSecret: (k, v) => { map.set(k, v) },
    delete: (k) => { map.delete(k) },
    secretWriteRefusal: () => (safeStorage ? null : 'The OS keychain is not available, and ADF Studio does not store secrets unencrypted unless you choose to.'),
  }
}

/** AdfWorkspace-shaped keystore mock backed by a Map. `locked` simulates a locked envelope. */
function memKeystore(opts: { locked?: boolean } = {}): OAuthKeystoreHandle & {
  rows: Map<string, string>
  codeAccess: Map<string, boolean>
} {
  const rows = new Map<string, string>()
  const codeAccess = new Map<string, boolean>()
  return {
    rows,
    codeAccess,
    setIdentitySealed: (p, v) => {
      if (opts.locked) throw new Error('credentials envelope is locked in this runtime')
      rows.set(p, v)
      // Mirror production: a seal PRESERVES an existing row's code_access flag;
      // a brand-new row defaults to false.
      if (!codeAccess.has(p)) codeAccess.set(p, false)
    },
    setIdentityCodeAccess: (p, ca) => { codeAccess.set(p, ca); return true },
    getIdentityDecrypted: (p) => {
      if (!rows.has(p)) return null
      // A locked envelope: the row EXISTS but cannot be decrypted → null.
      return opts.locked ? null : rows.get(p) ?? null
    },
    getIdentityRow: (p) => (rows.has(p) ? { purpose: p } : null),
    deleteIdentity: (p) => { codeAccess.delete(p); return rows.delete(p) },
  }
}

describe('AppSettingsOAuthStore', () => {
  it('round-trips a record through the single settings secret, keyed by server name', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.forServer('linear').save(URL_A, record())
    expect(Object.keys(JSON.parse(settings.map.get(MCP_OAUTH_SETTINGS_KEY)!))).toEqual(['linear'])
    const got = await store.forServer('linear').get(URL_A)
    expect(got?.tokens?.access_token).toBe('at')
    expect(got?.serverUrl).toBe(URL_A)
  })

  it('two servers of the same URL keep separate records', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.forServer('notion').save(URL_B, record({ tokens: { access_token: 'personal' } as McpOAuthRecord['tokens'] }))
    await store.forServer('notion-2').save(URL_B, record({ tokens: { access_token: 'work' } as McpOAuthRecord['tokens'] }))
    expect(Object.keys(JSON.parse(settings.map.get(MCP_OAUTH_SETTINGS_KEY)!))).toEqual(['notion', 'notion-2'])
    expect((await store.forServer('notion').get(URL_B))?.tokens?.access_token).toBe('personal')
    expect((await store.forServer('notion-2').get(URL_B))?.tokens?.access_token).toBe('work')
    await store.forServer('notion').invalidate(URL_B)
    expect(await store.forServer('notion').get(URL_B)).toBeUndefined()
    expect((await store.forServer('notion-2').get(URL_B))?.tokens?.access_token).toBe('work')
  })

  it('refuses a record for a URL other than the one it was minted for', async () => {
    const store = new AppSettingsOAuthStore(memSettings())
    await store.forServer('linear').save(URL_A, record())
    await expect(store.forServer('linear').get(URL_B)).rejects.toThrow(/refusing to send credentials/i)
  })

  it('stamps updatedAt when the record omits it', async () => {
    const store = new AppSettingsOAuthStore(memSettings())
    await store.forServer('linear').save(URL_A, record({ updatedAt: 0 }))
    expect((await store.forServer('linear').get(URL_A))!.updatedAt).toBeGreaterThan(0)
  })

  it('get returns undefined for an unknown server and an empty store', async () => {
    const store = new AppSettingsOAuthStore(memSettings())
    expect(await store.forServer('linear').get(URL_A)).toBeUndefined()
  })

  it('invalidate "tokens" drops tokens but keeps the DCR client', async () => {
    const store = new AppSettingsOAuthStore(memSettings()).forServer('linear')
    await store.save(URL_A, record())
    await store.invalidate(URL_A, 'tokens')
    const got = await store.get(URL_A)
    expect(got?.tokens).toBeUndefined()
    expect(got?.clientInformation?.client_id).toBe('cid')
  })

  it('invalidate "client" drops client + tokens', async () => {
    const store = new AppSettingsOAuthStore(memSettings()).forServer('linear')
    await store.save(URL_A, record({ discoveryState: { foo: 1 } as unknown as McpOAuthRecord['discoveryState'] }))
    await store.invalidate(URL_A, 'client')
    const got = await store.get(URL_A)
    expect(got?.clientInformation).toBeUndefined()
    expect(got?.tokens).toBeUndefined()
    expect(got?.discoveryState).toBeDefined()
  })

  it('invalidate "all" removes the record, and clears the settings key when the blob empties', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings).forServer('linear')
    await store.save(URL_A, record())
    await store.invalidate(URL_A, 'all')
    expect(await store.get(URL_A)).toBeUndefined()
    expect(settings.map.has(MCP_OAUTH_SETTINGS_KEY)).toBe(false)
  })

  it('invalidate "all" keeps other servers in the blob', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.forServer('linear').save(URL_A, record())
    await store.forServer('notion').save(URL_B, record())
    await store.forServer('linear').invalidate(URL_A)
    expect(await store.forServer('linear').get(URL_A)).toBeUndefined()
    expect(await store.forServer('notion').get(URL_B)).toBeDefined()
    expect(settings.map.has(MCP_OAUTH_SETTINGS_KEY)).toBe(true)
  })

  it('fails plainly when secrets cannot be stored (no keychain, no plain-text choice): never writes', async () => {
    const settings = memSettings(false)
    const store = new AppSettingsOAuthStore(settings)
    await expect(store.forServer('linear').save(URL_A, record())).rejects.toThrow(/Cannot store MCP OAuth tokens\. The OS keychain is not available/)
    expect(settings.map.size).toBe(0)
  })
})

describe('AgentKeystoreOAuthStore', () => {
  it('uses the mcp:<name>:oauth keystore namespace', () => {
    expect(oauthKeystorePurpose('linear')).toBe('mcp:linear:oauth')
  })

  it('seals and reads a single record per server', async () => {
    const ks = memKeystore()
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record())
    expect(ks.rows.has('mcp:linear:oauth')).toBe(true)
    const got = await store.get(URL_A)
    expect(got?.tokens?.access_token).toBe('at')
  })

  it('get returns undefined when the row is absent (bootstrap)', async () => {
    const store = new AgentKeystoreOAuthStore(memKeystore(), 'linear')
    expect(await store.get(URL_A)).toBeUndefined()
  })

  it('THROWS the sign-in hint on a locked envelope (not null)', async () => {
    const ks = memKeystore()
    // Seal while unlocked, then flip to locked so the row exists but won't decrypt.
    await new AgentKeystoreOAuthStore(ks, 'linear').save(URL_A, record())
    const locked = { ...ks, getIdentityDecrypted: () => null }
    const store = new AgentKeystoreOAuthStore(locked, 'linear')
    await expect(store.get(URL_A)).rejects.toThrow(/envelope is locked.*ADF Studio once.*daemon runtime key/s)
  })

  it('save propagates the seal-or-fail error on a locked envelope', async () => {
    const store = new AgentKeystoreOAuthStore(memKeystore({ locked: true }), 'linear')
    await expect(store.save(URL_A, record())).rejects.toThrow(/envelope is locked/)
  })

  it('invalidate "all" removes the sealed row', async () => {
    const ks = memKeystore()
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record())
    await store.invalidate(URL_A, 'all')
    expect(ks.rows.has('mcp:linear:oauth')).toBe(false)
  })

  it('invalidate "tokens" re-seals without the tokens', async () => {
    const ks = memKeystore()
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record())
    await store.invalidate(URL_A, 'tokens')
    const got = await store.get(URL_A)
    expect(got?.tokens).toBeUndefined()
    expect(got?.clientInformation?.client_id).toBe('cid')
  })

  it('save forces code_access=false, even on a pre-seeded (poisoned) row', async () => {
    const ks = memKeystore()
    // Simulate an agent having pre-created the row code-readable via set_identity.
    ks.rows.set('mcp:linear:oauth', '{"updatedAt":1}')
    ks.codeAccess.set('mcp:linear:oauth', true)
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record())
    expect(ks.codeAccess.get('mcp:linear:oauth')).toBe(false)
  })

  it('invalidate "tokens" re-seal also forces code_access=false', async () => {
    const ks = memKeystore()
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record())
    ks.codeAccess.set('mcp:linear:oauth', true) // pretend something flipped it back
    await store.invalidate(URL_A, 'tokens')
    expect(ks.codeAccess.get('mcp:linear:oauth')).toBe(false)
  })

  it('get() REFUSES a token minted for a different url (URL binding)', async () => {
    const ks = memKeystore()
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record({ serverUrl: URL_A }))
    await expect(store.get('https://evil.example.com/sse')).rejects.toThrow(/refusing to send credentials/i)
  })

  it('get() returns the record when the requested url matches the pinned one', async () => {
    const ks = memKeystore()
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record({ serverUrl: URL_A }))
    // A query-only difference must still match (canonicalization strips it).
    expect((await store.get(`${URL_A}?extra=1`))?.tokens?.access_token).toBe('at')
  })

  it('get() still returns a legacy record with no pinned serverUrl (back-compat)', async () => {
    const ks = memKeystore()
    const store = new AgentKeystoreOAuthStore(ks, 'linear')
    await store.save(URL_A, record()) // no serverUrl stamped
    expect((await store.get('https://anything.example.com/x'))?.tokens?.access_token).toBe('at')
  })
})

describe('captureOAuthToAgent', () => {
  it('copies the app-level record and seals it into the agent keystore', async () => {
    const app = new AppSettingsOAuthStore(memSettings()).forServer('linear')
    await app.save(URL_A, record())
    const ks = memKeystore()
    const agent = new AgentKeystoreOAuthStore(ks, 'linear')
    const captured = await captureOAuthToAgent(app, agent, URL_A)
    expect(captured).toBe(true)
    expect((await agent.get(URL_A))?.tokens?.access_token).toBe('at')
  })

  it('no-ops and returns false when the app store has nothing for the server', async () => {
    const app = new AppSettingsOAuthStore(memSettings()).forServer('linear')
    const ks = memKeystore()
    const agent = new AgentKeystoreOAuthStore(ks, 'linear')
    expect(await captureOAuthToAgent(app, agent, URL_A)).toBe(false)
    expect(ks.rows.size).toBe(0)
  })

  it('stamps the canonical serverUrl onto the sealed copy so the agent store can URL-bind it', async () => {
    const app = new AppSettingsOAuthStore(memSettings()).forServer('linear')
    await app.save(URL_A, record())
    const ks = memKeystore()
    const agent = new AgentKeystoreOAuthStore(ks, 'linear')
    await captureOAuthToAgent(app, agent, URL_A)
    const sealed = JSON.parse(ks.rows.get('mcp:linear:oauth')!)
    expect(sealed.serverUrl).toBe(URL_A)
    // And it is now bound: a different requested url is refused.
    await expect(agent.get('https://evil.example.com/sse')).rejects.toThrow(/refusing to send credentials/i)
  })
})

describe('resolveOAuthStoreForConnect', () => {
  it('prefers the agent store when an agent context exists', () => {
    const agentStore = new AgentKeystoreOAuthStore(memKeystore(), 'linear')
    const appStore = new AppSettingsOAuthStore(memSettings()).forServer('linear')
    expect(resolveOAuthStoreForConnect({ agentStore, appStore })).toBe(agentStore)
  })

  it('falls back to the app store when there is no agent context', () => {
    const appStore = new AppSettingsOAuthStore(memSettings()).forServer('linear')
    expect(resolveOAuthStoreForConnect({ appStore })).toBe(appStore)
  })

  it('returns undefined when neither is available', () => {
    expect(resolveOAuthStoreForConnect({})).toBeUndefined()
  })
})

describe('DaemonAppOAuthStore index', () => {
  const ACCOUNT = 'mcp-oauth-credentials:test'
  function memBackend() {
    const map = new Map<string, string>()
    let failOnce: string | null = null
    return {
      map,
      failNextRead(account: string) { failOnce = account },
      isUnlocked: () => true,
      get: (account: string) => {
        if (failOnce === account) {
          failOnce = null
          throw new Error('keychain read failed')
        }
        return map.get(account) ?? null
      },
      set: (account: string, value: string) => { map.set(account, value) },
      delete: (account: string) => { map.delete(account) },
    }
  }

  it('an unreadable index is never rewritten by a new sign-in (missing chunk, then a read error)', async () => {
    const backend = memBackend()
    const store = new DaemonAppOAuthStore(backend, ACCOUNT)
    await store.forServer('linear').save(URL_A, record())
    expect(store.listServers()).toEqual(['linear'])
    const indexHead = backend.map.get(ACCOUNT)!
    const chunk = [...backend.map.keys()].find((k) => k.startsWith(`${ACCOUNT}#`))!
    const chunkValue = backend.map.get(chunk)!
    backend.map.delete(chunk) // the head stays, its chunk is gone: unreadable, not absent

    await store.forServer('notion').save(URL_B, record())
    expect(backend.map.get(ACCOUNT)).toBe(indexHead)
    backend.map.set(chunk, chunkValue)
    expect(store.listServers()).toEqual(['linear'])
    expect(await store.forServer('notion').get(URL_B)).toBeDefined() // the record itself was saved

    // A removal leaves an unreadable index as it is too.
    backend.map.delete(chunk)
    await store.forServer('linear').invalidate(URL_A)
    backend.map.set(chunk, chunkValue)
    expect(store.listServers()).toEqual(['linear'])

    // A transient read error of the index chunk.
    const URL_C = 'https://mcp.example.com/sse'
    backend.failNextRead(chunk)
    await store.forServer('example').save(URL_C, record())
    expect(store.listServers()).toEqual(['linear'])
  })

  it('no index yet: the first sign-in creates it', async () => {
    const store = new DaemonAppOAuthStore(memBackend(), ACCOUNT)
    await store.forServer('linear').save(URL_A, record())
    await store.forServer('notion').save(URL_B, record())
    expect(store.listServers()).toEqual(['linear', 'notion'])
  })

  it('two servers of the same URL keep separate records; a different URL is refused', async () => {
    const store = new DaemonAppOAuthStore(memBackend(), ACCOUNT)
    await store.forServer('notion').save(URL_B, record({ tokens: { access_token: 'personal' } as McpOAuthRecord['tokens'] }))
    await store.forServer('notion-2').save(URL_B, record({ tokens: { access_token: 'work' } as McpOAuthRecord['tokens'] }))
    expect(store.listServers()).toEqual(['notion', 'notion-2'])
    expect((await store.forServer('notion').get(URL_B))?.tokens?.access_token).toBe('personal')
    expect((await store.forServer('notion-2').get(URL_B))?.tokens?.access_token).toBe('work')
    await expect(store.forServer('notion').get(URL_A)).rejects.toThrow(/refusing to send credentials/i)
  })
})
