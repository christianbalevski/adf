import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'adf-mcphome-'))
vi.mock('../../../src/main/utils/user-data-path', () => ({ getUserDataPath: () => userData }))

const {
  mcpContainerHomeEnv, mcpCredentialFileStore, mcpCredentialOwner, mcpHostHomeEnv, mcpServerContainerHome, mcpServerHostHome,
} = await import('../../../src/main/services/mcp-server-home')
const { RUNTIME_ONLY_CREDENTIAL_STORE } = await import('../../../src/main/services/mcp-credential-files')
const { resolveMcpEnvVars } = await import('../../../src/main/services/mcp-spawn-utils')

const withFiles = (name: string) => ({ name, credential_files: [{ path: '~/.gmail-mcp/credentials.json' }] })
const plain = (name: string) => ({ name })
const app = { kind: 'app' } as const
const agentA = { kind: 'agent', agentId: 'agentA' } as const
const agentB = { kind: 'agent', agentId: 'agentB' } as const

describe('mcpCredentialOwner', () => {
  it('a registration stores credentials in the app unless set to per agent; anything else is the agent\'s', () => {
    expect(mcpCredentialOwner({}, 'a1')).toEqual(app)
    expect(mcpCredentialOwner({ credentialStorage: 'app' }, 'a1')).toEqual(app)
    expect(mcpCredentialOwner({ credentialStorage: 'agent' }, 'a1')).toEqual({ kind: 'agent', agentId: 'a1' })
    expect(mcpCredentialOwner(undefined, 'a1')).toEqual({ kind: 'agent', agentId: 'a1' })
  })
})

describe('home folders', () => {
  it('a server with credential files gets one folder per owner and name', () => {
    const homes = [
      mcpServerHostHome(withFiles('gmail'), app),
      mcpServerHostHome(withFiles('gmail-work'), app),
      mcpServerHostHome(withFiles('gmail'), agentA),
      mcpServerHostHome(withFiles('gmail'), agentB),
    ]
    expect(new Set(homes).size).toBe(4)
    for (const h of homes) expect(h.startsWith(join(userData, 'mcp-home'))).toBe(true)
  })

  it('every other server keeps the real home on the host and the agent home in a container', () => {
    expect(mcpServerHostHome(plain('github'), agentA)).toBe(homedir())
    expect(mcpHostHomeEnv(plain('github'), agentA)).toEqual({})
    expect(mcpServerContainerHome(plain('github'), '/workspace/home')).toBe('/workspace/home')
    expect(mcpContainerHomeEnv(plain('github'), '/workspace/home')).toEqual({})
  })

  it('in a container, two copies in one agent get separate folders under the agent home', () => {
    expect(mcpServerContainerHome(withFiles('gmail'), '/w/home')).toBe('/w/home/.mcp-home/gmail')
    expect(mcpServerContainerHome(withFiles('gmail-work'), '/w/home')).toBe('/w/home/.mcp-home/gmail-work')
    expect(mcpContainerHomeEnv(withFiles('gmail'), '/w/home')).toEqual(expect.objectContaining({
      HOME: '/w/home/.mcp-home/gmail', npm_config_cache: '/w/home/.npm',
    }))
  })

  it('the host env points HOME at the (created) folder and keeps the real npm settings', () => {
    const env = mcpHostHomeEnv(withFiles('gmail'), app, {})
    const home = mcpServerHostHome(withFiles('gmail'), app)
    expect(env.HOME).toBe(home)
    expect(env.USERPROFILE).toBe(home)
    expect(env.npm_config_userconfig).toBe(join(homedir(), '.npmrc'))
    expect(existsSync(home)).toBe(true)
  })

  it('refuses a name that is not one plain path segment', () => {
    expect(() => mcpServerHostHome(withFiles('../x'), app)).toThrow(/cannot name an MCP server home folder/)
    expect(() => mcpServerHostHome(withFiles('con'), app)).toThrow(/reserved device name/)
  })
})

describe('mcpCredentialFileStore', () => {
  const agentStore = { getDecrypted: () => null, hasRow: () => false, setIdentitySealed: vi.fn() }

  it('agent credentials come from the agent keystore wherever the server runs', () => {
    expect(mcpCredentialFileStore(withFiles('gmail'), agentA, agentStore, 'host')).toBe(agentStore)
    expect(mcpCredentialFileStore(withFiles('gmail'), agentA, agentStore, 'container')).toBe(agentStore)
  })

  it('app credentials on the host are already in the folder the server runs in; in a container they come from it', () => {
    expect(mcpCredentialFileStore(withFiles('gmail'), app, agentStore, 'host')).toBe(RUNTIME_ONLY_CREDENTIAL_STORE)
    const inContainer = mcpCredentialFileStore(withFiles('gmail'), app, agentStore, 'container')
    expect(inContainer).not.toBe(agentStore)
    expect(inContainer.hasRow('mcp:gmail:file:~/.gmail-mcp/credentials.json')).toBe(false)
  })
})

describe('resolveMcpEnvVars', () => {
  it('reads each copy\'s values under its own name, never the package', () => {
    const rows: Record<string, string> = {
      'mcp:gmail:API_KEY': 'personal',
      'mcp:gmail-work:API_KEY': 'work',
      'mcp:@x/gmail:API_KEY': 'package-level',
    }
    const get = (p: string) => rows[p] ?? null
    const cfg = (name: string) => ({ name, transport: 'stdio' as const, npm_package: '@x/gmail', env_keys: ['API_KEY'] })
    expect(resolveMcpEnvVars(cfg('gmail'), get)).toEqual({ API_KEY: 'personal' })
    expect(resolveMcpEnvVars(cfg('gmail-work'), get)).toEqual({ API_KEY: 'work' })
    expect(resolveMcpEnvVars(cfg('gmail-other'), get)).toEqual({})
  })
})
