import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'adf-mcphome-'))
vi.mock('../../../src/main/utils/user-data-path', () => ({ getUserDataPath: () => userData }))

const {
  mcpContainerHomeEnv, mcpCredentialOwner, mcpHostHomeEnv, mcpServerContainerHome, mcpServerCredentials, mcpServerHostHome, removeMcpServerHome,
} = await import('../../../src/main/services/mcp-server-home')
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

describe('mcpServerCredentials', () => {
  const agentStore = { getDecrypted: () => null, hasRow: () => false, setIdentitySealed: vi.fn() }

  it('agent credentials: read from and captured into the agent keystore', () => {
    for (const reg of [undefined, { credentialStorage: 'agent' as const }]) {
      const creds = mcpServerCredentials(withFiles('gmail'), reg, 'agentA', agentStore)
      expect(creds.owner).toEqual(agentA)
      expect(creds.files).toBe(agentStore)
      expect(creds.capture).toBe(agentStore)
    }
  })

  it('app credentials: read from the registration\'s folder, never captured from an agent', () => {
    const creds = mcpServerCredentials(withFiles('gmail'), {}, 'agentA', agentStore)
    expect(creds.owner).toEqual(app)
    expect(creds.files).not.toBe(agentStore)
    expect(creds.files.hasRow('mcp:gmail:file:~/.gmail-mcp/credentials.json')).toBe(false)
    expect(creds.capture).toBeUndefined()
  })
})

describe('removeMcpServerHome', () => {
  it('deletes the folder so a server added later under the name starts signed out', () => {
    for (const owner of [app, agentA]) {
      mcpHostHomeEnv(withFiles('gmail-2'), owner)
      const home = mcpServerHostHome(withFiles('gmail-2'), owner)
      expect(existsSync(home)).toBe(true)
      removeMcpServerHome('gmail-2', owner)
      expect(existsSync(home)).toBe(false)
    }
  })

  it('is a no-op for a folder that never existed or a name that cannot have one', () => {
    expect(() => removeMcpServerHome('never-made', app)).not.toThrow()
    expect(() => removeMcpServerHome('a/../b', app)).not.toThrow()
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
