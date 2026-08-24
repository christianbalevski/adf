import { describe, expect, it } from 'vitest'
import {
  AppSettingsOAuthStore,
  AgentKeystoreOAuthStore,
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

/** SettingsService-shaped mock backed by a Map (safeStorage available by default). */
function memSettings(safeStorage = true): OAuthSettingsHandle & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getSecret: (k) => map.get(k) ?? null,
    setSecret: (k, v) => { map.set(k, v) },
    delete: (k) => { map.delete(k) },
    isSafeStorageAvailable: () => safeStorage,
  }
}

/** AdfWorkspace-shaped keystore mock backed by a Map. `locked` simulates a locked envelope. */
function memKeystore(opts: { locked?: boolean } = {}): OAuthKeystoreHandle & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    setIdentitySealed: (p, v) => {
      if (opts.locked) throw new Error('credentials envelope is locked in this runtime')
      rows.set(p, v)
    },
    getIdentityDecrypted: (p) => {
      if (!rows.has(p)) return null
      // A locked envelope: the row EXISTS but cannot be decrypted → null.
      return opts.locked ? null : rows.get(p) ?? null
    },
    getIdentityRow: (p) => (rows.has(p) ? { purpose: p } : null),
    deleteIdentity: (p) => rows.delete(p),
  }
}

describe('AppSettingsOAuthStore', () => {
  it('round-trips a record through the single settings secret', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.save(URL_A, record())
    expect(settings.map.has(MCP_OAUTH_SETTINGS_KEY)).toBe(true)
    const got = await store.get(URL_A)
    expect(got?.tokens?.access_token).toBe('at')
  })

  it('merges multiple URLs into one blob', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.save(URL_A, record({ tokens: { access_token: 'a' } as McpOAuthRecord['tokens'] }))
    await store.save(URL_B, record({ tokens: { access_token: 'b' } as McpOAuthRecord['tokens'] }))
    const blob = JSON.parse(settings.map.get(MCP_OAUTH_SETTINGS_KEY)!)
    expect(Object.keys(blob)).toEqual([URL_A, URL_B])
    expect((await store.get(URL_A))?.tokens?.access_token).toBe('a')
    expect((await store.get(URL_B))?.tokens?.access_token).toBe('b')
  })

  it('stamps updatedAt when the record omits it', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.save(URL_A, record({ updatedAt: 0 }))
    expect((await store.get(URL_A))!.updatedAt).toBeGreaterThan(0)
  })

  it('get returns undefined for an unknown url and an empty store', async () => {
    const store = new AppSettingsOAuthStore(memSettings())
    expect(await store.get(URL_A)).toBeUndefined()
  })

  it('invalidate "tokens" drops tokens but keeps the DCR client', async () => {
    const store = new AppSettingsOAuthStore(memSettings())
    await store.save(URL_A, record())
    await store.invalidate(URL_A, 'tokens')
    const got = await store.get(URL_A)
    expect(got?.tokens).toBeUndefined()
    expect(got?.clientInformation?.client_id).toBe('cid')
  })

  it('invalidate "client" drops client + tokens', async () => {
    const store = new AppSettingsOAuthStore(memSettings())
    await store.save(URL_A, record({ discoveryState: { foo: 1 } as unknown as McpOAuthRecord['discoveryState'] }))
    await store.invalidate(URL_A, 'client')
    const got = await store.get(URL_A)
    expect(got?.clientInformation).toBeUndefined()
    expect(got?.tokens).toBeUndefined()
    expect(got?.discoveryState).toBeDefined()
  })

  it('invalidate "all" removes the url, and clears the settings key when the blob empties', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.save(URL_A, record())
    await store.invalidate(URL_A, 'all')
    expect(await store.get(URL_A)).toBeUndefined()
    expect(settings.map.has(MCP_OAUTH_SETTINGS_KEY)).toBe(false)
  })

  it('invalidate "all" keeps other urls in the blob', async () => {
    const settings = memSettings()
    const store = new AppSettingsOAuthStore(settings)
    await store.save(URL_A, record())
    await store.save(URL_B, record())
    await store.invalidate(URL_A)
    expect(await store.get(URL_A)).toBeUndefined()
    expect(await store.get(URL_B)).toBeDefined()
    expect(settings.map.has(MCP_OAUTH_SETTINGS_KEY)).toBe(true)
  })

  it('fails plainly when safeStorage is unavailable (never writes plaintext)', async () => {
    const settings = memSettings(false)
    const store = new AppSettingsOAuthStore(settings)
    await expect(store.save(URL_A, record())).rejects.toThrow(/secure storage \(safeStorage\) is unavailable/)
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
})

describe('captureOAuthToAgent', () => {
  it('copies the app-level record and seals it into the agent keystore', async () => {
    const app = new AppSettingsOAuthStore(memSettings())
    await app.save(URL_A, record())
    const ks = memKeystore()
    const agent = new AgentKeystoreOAuthStore(ks, 'linear')
    const captured = await captureOAuthToAgent(app, agent, URL_A)
    expect(captured).toBe(true)
    expect((await agent.get(URL_A))?.tokens?.access_token).toBe('at')
  })

  it('no-ops and returns false when the app store has nothing for the url', async () => {
    const app = new AppSettingsOAuthStore(memSettings())
    const ks = memKeystore()
    const agent = new AgentKeystoreOAuthStore(ks, 'linear')
    expect(await captureOAuthToAgent(app, agent, URL_A)).toBe(false)
    expect(ks.rows.size).toBe(0)
  })
})

describe('resolveOAuthStoreForConnect', () => {
  it('prefers the agent store when an agent context exists', () => {
    const agentStore = new AgentKeystoreOAuthStore(memKeystore(), 'linear')
    const appStore = new AppSettingsOAuthStore(memSettings())
    expect(resolveOAuthStoreForConnect({ agentStore, appStore })).toBe(agentStore)
  })

  it('falls back to the app store when there is no agent context', () => {
    const appStore = new AppSettingsOAuthStore(memSettings())
    expect(resolveOAuthStoreForConnect({ appStore })).toBe(appStore)
  })

  it('returns undefined when neither is available', () => {
    expect(resolveOAuthStoreForConnect({})).toBeUndefined()
  })
})
