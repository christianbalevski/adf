import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-provider-keys-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-provider-keys-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

// /runtime/auth asks Claude Code for its sign-in; never spawn the real binary here.
vi.mock('../src/main/providers/claude-subscription/auth-manager', () => ({
  getClaudeAuthManager: () => ({
    getAuthStatus: async () => ({ authenticated: true, installed: true, version: '2.1.250', email: 'user@example.test', plan: 'max' }),
    startAuthFlowDetached: async () => ({ url: 'https://claude.ai/oauth/authorize?code=true', completion: new Promise<void>(() => {}) }),
    submitCode: () => { throw new Error('No Claude sign-in is in progress.') },
    cancelAuthFlow: () => {},
    logout: async () => {},
  }),
}))

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { FileSettingsStore } from '../src/main/daemon/file-settings-store'
import { MemoryProviderKeyVault, SecretBackendProviderKeyVault } from '../src/main/daemon/provider-key-vault'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import type { ProviderConfig } from '../src/shared/types/ipc.types'

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef'
const dirs: string[] = []
const servers: Array<{ close: () => Promise<unknown> }> = []

afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function setup(vault = new MemoryProviderKeyVault()) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-provider-keys-'))
  dirs.push(dir)
  const file = join(dir, 'adf-settings.json')
  const settings = new FileSettingsStore(file)
  settings.setProviderKeyVault(vault)
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { settingsStore: settings, providerKeys: vault })
  servers.push(server)
  return { server, settings, vault, file }
}

describe('POST /runtime/providers', () => {
  it('keeps the key in the secret store, never in the settings file or a response', async () => {
    const { server, settings, vault, file } = setup()
    const res = await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'openrouter', name: 'OpenRouter', preset: 'openrouter', apiKey: KEY } })
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain(KEY)
    const { provider, defaultProviderId } = res.json()
    expect(provider).toMatchObject({ type: 'openrouter', name: 'OpenRouter', apiKeyStorage: 'secret-store', hasApiKey: true })
    expect(defaultProviderId).toBe(provider.id)
    expect(vault.values.get(provider.id)).toBe(KEY)
    expect(readFileSync(file, 'utf8')).not.toContain(KEY)

    // Every daemon reader sees an ordinary provider with its key.
    expect(settings.getProvider(provider.id)?.apiKey).toBe(KEY)
    expect((settings.get('providers') as ProviderConfig[])[0].apiKey).toBe(KEY)

    // Diagnostics and settings reads: hasApiKey / redacted, never the key.
    for (const url of ['/runtime/providers', '/runtime/auth', '/settings', '/settings/providers']) {
      const read = await server.inject({ method: 'GET', url })
      expect(read.body, url).not.toContain(KEY)
    }
    expect((await server.inject({ method: 'GET', url: '/runtime/providers' })).json().providers[0]).toMatchObject({ id: provider.id, hasApiKey: true, apiKeyStorage: 'secret-store' })

    // A client echoing the redacted list back keeps the key out of the file.
    const echoed = (await server.inject({ method: 'GET', url: '/settings/providers' })).json().value
    await server.inject({ method: 'PUT', url: '/settings/providers', payload: { value: echoed } })
    expect(readFileSync(file, 'utf8')).not.toContain(KEY)
    expect(settings.getProvider(provider.id)?.apiKey).toBe(KEY)

    // A new key written through settings goes to the vault too.
    await server.inject({ method: 'PUT', url: '/settings/providers', payload: { value: [{ ...echoed[0], apiKey: 'sk-rotated-key-1234' }] } })
    expect(vault.values.get(provider.id)).toBe('sk-rotated-key-1234')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-rotated-key-1234')
  })

  it('an echoed __redacted__ key is restored only to the same type and baseUrl; a changed endpoint needs the key again (W5-D1)', async () => {
    const { server, settings, vault } = setup()
    const made = (await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'openai-compatible', name: 'agent-1 LLM', preset: 'custom', baseUrl: 'https://llm.example.com/v1', apiKey: KEY } })).json().provider
    const echoed = (await server.inject({ method: 'GET', url: '/settings/providers' })).json().value as Array<Record<string, unknown>>
    expect(echoed[0].apiKey).toBe('__redacted__')

    for (const [label, change] of [['baseUrl', { baseUrl: 'https://attacker.example/v1' }], ['type', { type: 'anthropic' }]] as const) {
      for (const write of [
        () => server.inject({ method: 'PATCH', url: '/settings', payload: { providers: [{ ...echoed[0], ...change }] } }),
        () => server.inject({ method: 'PUT', url: '/settings/providers', payload: { value: [{ ...echoed[0], ...change }] } }),
      ]) {
        const res = await write()
        expect(res.statusCode, label).toBe(400)
        expect(res.json(), label).toMatchObject({ code: 'api_key_required' })
        expect(res.json().error, label).toContain('"agent-1 LLM"')
        expect(res.body, label).not.toContain(KEY)
        // Nothing written: the stored entry and key are as they were.
        expect(settings.getProvider(made.id), label).toMatchObject({ baseUrl: 'https://llm.example.com/v1', type: 'openai-compatible', apiKey: KEY })
      }
    }

    // A secret-store entry with an empty key is filled from the vault by id: the same rule (bypass found in review).
    for (const change of [{ baseUrl: 'https://attacker.example/v1' }, { type: 'anthropic' }]) {
      const res = await server.inject({ method: 'PATCH', url: '/settings', payload: { providers: [{ ...echoed[0], ...change, apiKeyStorage: 'secret-store', apiKey: '' }] } })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'api_key_required' })
      expect(settings.getProvider(made.id)).toMatchObject({ baseUrl: 'https://llm.example.com/v1', apiKey: KEY })
    }
    // Any other writer of the store: the vault key is dropped (logged), never filled into the new endpoint.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    settings.update({ providers: [{ ...echoed[0], baseUrl: 'https://attacker.example/v1', apiKeyStorage: 'secret-store', apiKey: '' }] })
    expect(settings.getProvider(made.id)?.apiKey).toBe('')
    expect(vault.values.has(made.id)).toBe(false)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('its stored key was removed'))).toBe(true)
    warn.mockRestore()
    settings.update({ providers: [{ ...echoed[0], apiKeyStorage: 'secret-store', apiKey: KEY }] })

    // A new key with the new address is accepted; the same endpoint keeps the stored key.
    expect((await server.inject({ method: 'PATCH', url: '/settings', payload: { providers: [{ ...echoed[0], name: 'renamed' }] } })).statusCode).toBe(200)
    expect(settings.getProvider(made.id)?.apiKey).toBe(KEY)
    expect((await server.inject({ method: 'PATCH', url: '/settings', payload: { providers: [{ ...echoed[0], baseUrl: 'https://other.example.com/v1', apiKey: 'sk-new-endpoint-key-1' }] } })).statusCode).toBe(200)
    expect(settings.getProvider(made.id)).toMatchObject({ baseUrl: 'https://other.example.com/v1', apiKey: 'sk-new-endpoint-key-1' })
    expect(vault.values.get(made.id)).toBe('sk-new-endpoint-key-1')
  })

  it('refuses while the secret store is locked, subscriptions, and missing keys or URLs', async () => {
    const { server } = setup(new MemoryProviderKeyVault(false))
    const locked = await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'anthropic', apiKey: KEY } })
    expect(locked.statusCode).toBe(409)
    expect(locked.json().code).toBe('secret_store_locked')
    expect((await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'chatgpt-subscription' } })).json().code).toBe('subscription_type')
    expect((await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'openai' } })).json().code).toBe('api_key_required')
    expect((await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'openai-compatible' } })).json().code).toBe('base_url_required')
    // A local server without a key needs no secret store.
    const local = await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'openai-compatible', name: 'Ollama', baseUrl: 'http://localhost:11434/v1/' } })
    expect(local.statusCode).toBe(201)
    expect(local.json().provider).toMatchObject({ baseUrl: 'http://localhost:11434/v1', hasApiKey: false })
  })

  it('dedupes names and DELETE removes the entry and its key', async () => {
    const { server, vault, settings } = setup()
    const a = (await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'openrouter', name: 'OpenRouter', apiKey: KEY } })).json().provider
    const b = (await server.inject({ method: 'POST', url: '/runtime/providers', payload: { type: 'openrouter', name: 'OpenRouter', apiKey: 'sk-second-key-000' } })).json().provider
    expect(b.name).toBe('OpenRouter 2')
    const del = await server.inject({ method: 'DELETE', url: `/runtime/providers/${encodeURIComponent(a.id)}` })
    expect(del.statusCode).toBe(200)
    expect(vault.values.has(a.id)).toBe(false)
    expect(settings.get('defaultProviderId')).toBe(b.id)
    expect((await server.inject({ method: 'DELETE', url: '/runtime/providers/custom:nope' })).statusCode).toBe(404)
  })
})

describe('SecretBackendProviderKeyVault', () => {
  it('scopes accounts per daemon and follows the backend lock', () => {
    const store = new Map<string, string>()
    let unlocked = true
    const backend = { kind: 'file' as const, isUnlocked: () => unlocked, get: (a: string) => store.get(a) ?? null, set: (a: string, v: string) => { store.set(a, v) }, delete: (a: string) => { store.delete(a) } }
    const vault = new SecretBackendProviderKeyVault(backend, 'abc123')
    vault.set('custom:1', KEY)
    expect([...store.keys()]).toEqual(['provider-api-key:abc123:custom:1'])
    expect(vault.get('custom:1')).toBe(KEY)
    unlocked = false
    expect(vault.available()).toBe(false)
    expect(vault.get('custom:1')).toBeNull()
    expect(() => vault.set('custom:2', 'x')).toThrow(/locked/)
  })
})
