/**
 * Characterization of the entry MCP_ATTACH_SERVER writes into
 * adf_config.mcp.servers[] (embedded ipc/index.ts, extracted under rule E1 into
 * mcpAttachEntry, which the daemon-mode handler calls too). E3: the oauth flag
 * reaches the .adf (it used to be dropped, so another runtime connected
 * without OAuth and got a 401). The renderer sends it unless a bearer or
 * header token is being saved (a dual-mode server given a pasted token uses
 * the token, as the TUI writes it).
 */
import { describe, expect, it } from 'vitest'
import { McpAttachArgs, mcpAttachEntry, validateMcpArgs } from '../../../src/main/ipc/mcp-adapter-args'
import { mcpAttachServerConfig } from '../../../src/renderer/components/mcp/McpCredentialPanel'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

function entryFor(serverConfig: Record<string, unknown>) {
  const v = validateMcpArgs(McpAttachArgs, { filePath: '/agents/agent-1.adf', serverConfig })
  if ('error' in v) throw new Error(v.error)
  return mcpAttachEntry(v.data.serverConfig)
}

const URL = 'https://mcp.example.test/mcp'
const HTTP = { name: 'remote', transport: 'http', url: URL, source: `http:${URL}` }
const TOKEN_SCHEMA = [{ key: 'REMOTE_TOKEN', scope: 'agent', required: true, credential_ref: undefined }]

/** The entries before the E3 fix, for every input: the oauth flag was dropped, so an input with it built what the same input without it builds. */
const BEFORE_E3 = {
  bearer: { ...HTTP, bearer_token_env_var: 'REMOTE_TOKEN', env_keys: ['REMOTE_TOKEN'], env_schema: TOKEN_SCHEMA },
  oauthOnly: { ...HTTP },
}

describe('mcpAttachEntry', () => {
  it('an npm server with agent-stored keys', () => {
    expect(entryFor({ name: 'acme', type: 'npm', npmPackage: '@acme/server', envKeys: ['API_KEY'], credentialStorage: 'agent', runLocation: 'host' })).toEqual({
      name: 'acme',
      transport: 'stdio',
      source: 'npm:@acme/server',
      npm_package: '@acme/server',
      env_keys: ['API_KEY'],
      env_schema: [{ key: 'API_KEY', required: true, scope: 'agent', credential_ref: undefined }],
      run_location: 'host',
    })
  })

  it('a bearer-only http server: unchanged by E3', () => {
    expect(entryFor({ name: 'remote', type: 'http', url: URL, bearerTokenEnvVar: 'REMOTE_TOKEN', envKeys: ['REMOTE_TOKEN'], credentialStorage: 'agent' })).toEqual(BEFORE_E3.bearer)
  })

  it('an http server with static and env headers: unchanged by E3', () => {
    expect(entryFor({
      name: 'remote', type: 'http', url: URL, headers: [{ key: 'X-Team', value: 't1' }],
      headerEnv: [{ key: 'X-Api-Key', value: 'REMOTE_KEY' }], envKeys: ['REMOTE_KEY'], credentialStorage: 'agent',
    })).toEqual({
      ...HTTP,
      headers: { 'X-Team': 't1' },
      header_env: [{ header: 'X-Api-Key', env: 'REMOTE_KEY', required: true, credential_ref: undefined }],
      env_keys: ['REMOTE_KEY'],
      env_schema: [{ key: 'REMOTE_KEY', scope: 'agent', required: true, credential_ref: undefined }],
    })
  })

  it('oauth sent with a bearer variable: oauth is the auth, the variable stays a fillable key (before E3: the bearer entry)', () => {
    const input = { name: 'remote', type: 'http', url: URL, bearerTokenEnvVar: 'REMOTE_TOKEN', envKeys: ['REMOTE_TOKEN'], credentialStorage: 'agent' }
    expect(entryFor(input)).toEqual(BEFORE_E3.bearer)
    expect(entryFor({ ...input, oauth: true })).toEqual({ ...HTTP, oauth: true, env_keys: ['REMOTE_TOKEN'], env_schema: TOKEN_SCHEMA })
  })

  it('an OAuth-only http server signs in with OAuth (before E3: no auth at all)', () => {
    const input = { name: 'remote', type: 'http', url: URL, credentialStorage: 'agent' }
    expect(entryFor(input)).toEqual(BEFORE_E3.oauthOnly)
    expect(entryFor({ ...input, oauth: true })).toEqual({ ...HTTP, oauth: true })
  })
})

describe('McpCredentialPanel attach arguments', () => {
  const dualMode: McpServerRegistration = { id: 'mcp:remote', name: 'remote', type: 'http', url: URL, oauth: true, bearerTokenEnvVar: 'REMOTE_TOKEN', credentialStorage: 'agent' }
  const entryOf = (serverConfig: ReturnType<typeof mcpAttachServerConfig>) => entryFor(serverConfig as unknown as Record<string, unknown>)

  it('a dual-mode server given a pasted bearer token: the token is the auth, no oauth', () => {
    const config = mcpAttachServerConfig(dualMode, undefined, ['REMOTE_TOKEN'], ['REMOTE_TOKEN'])
    expect(config.oauth).toBeUndefined()
    expect(entryOf(config)).toEqual(BEFORE_E3.bearer)
  })

  it('a dual-mode server given a header token: no oauth', () => {
    const headerServer: McpServerRegistration = { id: 'mcp:remote', name: 'remote', type: 'http', url: URL, oauth: true, headerEnv: [{ key: 'X-Api-Key', value: 'REMOTE_KEY' }], credentialStorage: 'agent' }
    expect(mcpAttachServerConfig(headerServer, undefined, ['REMOTE_KEY'], ['REMOTE_KEY']).oauth).toBeUndefined()
  })

  it('an OAuth server saving no token sends oauth: from the registration or its catalog entry', () => {
    expect(mcpAttachServerConfig(dualMode, undefined, ['REMOTE_TOKEN'], ['OTHER_KEY']).oauth).toBe(true)
    expect(mcpAttachServerConfig({ ...dualMode, oauth: undefined }, { oauth: true } as never, ['REMOTE_TOKEN'], []).oauth).toBe(true)
    expect(mcpAttachServerConfig({ ...dualMode, oauth: undefined }, undefined, ['REMOTE_TOKEN'], []).oauth).toBeUndefined()
    expect(entryOf(mcpAttachServerConfig(dualMode, undefined, ['REMOTE_TOKEN'], []))).toEqual({ ...HTTP, oauth: true, env_keys: ['REMOTE_TOKEN'], env_schema: TOKEN_SCHEMA })
  })
})
