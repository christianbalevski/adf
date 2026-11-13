import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

// A Settings server that signs in with its own auth command (Gmail, Google
// Calendar) used to have no signed-in answer: with only its client file it
// started, listed tools, and showed "Connected" while every call failed.

const userData = mkdtempSync(join(tmpdir(), 'adf-authstatus-'))
vi.mock('../../../src/main/utils/user-data-path', () => ({ getUserDataPath: () => userData }))

const { mcpOAuthStatus } = await import('../../../src/main/services/mcp-connect-tests')

const CLIENT = '~/.gmail-mcp/gcp-oauth.keys.json'
const TOKEN = '~/.gmail-mcp/credentials.json'
const gmail = (name: string, partial: Partial<McpServerRegistration> = {}): McpServerRegistration => ({
  id: name, name, type: 'npm', npmPackage: '@gongrzhe/server-gmail-autoauth-mcp', auth: true, authArgs: ['auth'], runLocation: 'host',
  credentialFiles: [{ path: CLIENT, required: true }, { path: TOKEN }],
  lastVerifiedAt: 1,
  ...partial,
})
const place = (name: string, path: string) => {
  const file = join(userData, 'mcp-home', 'app', name, path.slice(2))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{}')
}
const settingsWith = (servers: McpServerRegistration[], compute: Record<string, unknown> = { hostAccessEnabled: true, hostApproved: [] }) =>
  ({ get: (key: string) => (key === 'mcpServers' ? servers : key === 'compute' ? compute : undefined) })
const noStore = { forServer: () => { throw new Error('the app OAuth store is for remote servers') } }

describe('mcpOAuthStatus for a server that signs in with its own auth command (by name, no url)', () => {
  it('only its client file in its folder: signed out', async () => {
    place('gmail-client', CLIENT)
    const settings = settingsWith([gmail('gmail-client')])
    expect(await mcpOAuthStatus(noStore, { name: 'gmail-client' }, settings)).toEqual({ signedIn: false, byName: true })
  })

  it('a file the server creates (declared, not required) in its folder: signed in', async () => {
    place('gmail-token', CLIENT)
    place('gmail-token', TOKEN)
    const settings = settingsWith([gmail('gmail-token')])
    expect(await mcpOAuthStatus(noStore, { name: 'gmail-token' }, settings)).toEqual({ signedIn: true, byName: true })
  })

  it('credentials stored per agent: unknown', async () => {
    place('gmail-agent', TOKEN)
    const settings = settingsWith([gmail('gmail-agent', { credentialStorage: 'agent' })])
    expect(await mcpOAuthStatus(noStore, { name: 'gmail-agent' }, settings)).toEqual({ byName: true })
  })

  it('no file the server creates is declared: unknown', async () => {
    place('client-only', CLIENT)
    const settings = settingsWith([gmail('client-only', { credentialFiles: [{ path: CLIENT, required: true }] })])
    expect(await mcpOAuthStatus(noStore, { name: 'client-only' }, settings)).toEqual({ byName: true })
  })

  it('runs in the container (its Settings sign-in writes nothing to the folder): unknown', async () => {
    place('gmail-shared', CLIENT)
    expect(await mcpOAuthStatus(noStore, { name: 'gmail-shared' }, settingsWith([gmail('gmail-shared', { runLocation: 'shared' })]))).toEqual({ byName: true })
    // Host chosen, Host access off: runs in the container too.
    expect(await mcpOAuthStatus(noStore, { name: 'gmail-shared' }, settingsWith([gmail('gmail-shared')], { hostAccessEnabled: false, hostApproved: [] }))).toEqual({ byName: true })
  })

  it('no auth command, or not a Settings server: unknown', async () => {
    const settings = settingsWith([gmail('plain', { auth: false })])
    expect(await mcpOAuthStatus(noStore, { name: 'plain' }, settings)).toEqual({ byName: true })
    expect(await mcpOAuthStatus(noStore, { name: 'missing' }, settings)).toEqual({ byName: true })
  })

  it('config moved by XDG_CONFIG_HOME (inherited or in the row\'s env), a created file under ~/.config/: unknown', async () => {
    const created = '~/.config/example-mcp/tokens.json'
    const row = (name: string, partial: Partial<McpServerRegistration> = {}) => gmail(name, { credentialFiles: [{ path: CLIENT, required: true }, { path: created }], ...partial })
    place('xdg', CLIENT)
    place('xdg', created)
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(userData, 'elsewhere')
    try {
      expect(await mcpOAuthStatus(noStore, { name: 'xdg' }, settingsWith([row('xdg')]))).toEqual({ byName: true })
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
    place('xdg-env', CLIENT)
    const env = [{ key: 'XDG_CONFIG_HOME', value: join(userData, 'elsewhere') }]
    expect(await mcpOAuthStatus(noStore, { name: 'xdg-env' }, settingsWith([row('xdg-env', { env })]))).toEqual({ byName: true })
    // A created file outside ~/.config/ is still told.
    expect(await mcpOAuthStatus(noStore, { name: 'xdg-env' }, settingsWith([gmail('xdg-env', { env })]))).toEqual({ signedIn: false, byName: true })
  })

  it('a name without settings to look it up in: unknown; no name: signed out, as before', async () => {
    expect(await mcpOAuthStatus(null, { name: 'gmail' }, undefined)).toEqual({ byName: true })
    expect(await mcpOAuthStatus(null, {}, undefined)).toEqual({ signedIn: false })
    expect(await mcpOAuthStatus(null, { url: 'https://mcp.example.test/mcp' }, undefined)).toEqual({ signedIn: false })
  })

  it('an http OAuth row is still answered by its URL from the app store, as before', async () => {
    const view = { get: vi.fn(async () => ({ tokens: { access_token: 'x', token_type: 'bearer' }, updatedAt: 1 })), save: vi.fn(), invalidate: vi.fn(async () => {}) }
    const store = { forServer: vi.fn(() => view) }
    const settings = settingsWith([{ id: 'r', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true }])
    expect(await mcpOAuthStatus(store, { name: 'remote', url: 'https://mcp.example.test/mcp' }, settings)).toEqual({ signedIn: true })
    view.get.mockResolvedValueOnce(undefined as never)
    expect(await mcpOAuthStatus(store, { name: 'remote', url: 'https://mcp.example.test/mcp' }, settings)).toEqual({ signedIn: false })
    expect(await mcpOAuthStatus(store, {}, settings)).toEqual({ signedIn: false })
  })
})
