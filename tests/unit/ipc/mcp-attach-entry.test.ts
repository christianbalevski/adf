/**
 * Characterization of the entry MCP_ATTACH_SERVER writes into
 * adf_config.mcp.servers[] (embedded ipc/index.ts, extracted under rule E1 into
 * mcpAttachEntry, which the daemon-mode handler calls too). E3: the oauth flag
 * reaches the .adf (it used to be dropped, so another runtime connected
 * without OAuth and got a 401), and the renderer sends it.
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

  it('an OAuth http server with a bearer fallback: oauth is the auth, the bearer variable stays a fillable key', () => {
    const entry = entryFor({
      name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true,
      bearerTokenEnvVar: 'REMOTE_TOKEN', envKeys: ['REMOTE_TOKEN'], credentialStorage: 'agent',
    })
    expect(entry.oauth).toBe(true)
    expect(entry.bearer_token_env_var).toBeUndefined()
    expect(entry).toMatchObject({ name: 'remote', transport: 'http', url: 'https://mcp.example.test/mcp', env_keys: ['REMOTE_TOKEN'] })
  })

  it('an OAuth-only http server signs in with OAuth', () => {
    const entry = entryFor({ name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true, credentialStorage: 'agent' })
    expect(entry.oauth).toBe(true)
    expect(entry.bearer_token_env_var).toBeUndefined()
  })

  it('a bearer-only http server keeps its bearer variable', () => {
    const entry = entryFor({ name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', bearerTokenEnvVar: 'REMOTE_TOKEN', credentialStorage: 'agent' })
    expect(entry.oauth).toBeUndefined()
    expect(entry.bearer_token_env_var).toBe('REMOTE_TOKEN')
  })
})

describe('McpCredentialPanel attach arguments', () => {
  const server: McpServerRegistration = { id: 'mcp:remote', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', bearerTokenEnvVar: 'REMOTE_TOKEN', credentialStorage: 'agent' }

  it('send oauth for an OAuth registration, or one whose catalog entry is OAuth', () => {
    expect(mcpAttachServerConfig({ ...server, oauth: true }, undefined, ['REMOTE_TOKEN']).oauth).toBe(true)
    expect(mcpAttachServerConfig(server, { oauth: true } as never, ['REMOTE_TOKEN']).oauth).toBe(true)
    expect(mcpAttachServerConfig(server, undefined, ['REMOTE_TOKEN']).oauth).toBeUndefined()
  })

  it('pass the schema, and the entry built from them signs in with OAuth', () => {
    const v = validateMcpArgs(McpAttachArgs, { filePath: '/agents/agent-1.adf', serverConfig: mcpAttachServerConfig({ ...server, oauth: true }, undefined, ['REMOTE_TOKEN']) })
    if ('error' in v) throw new Error(v.error)
    expect(mcpAttachEntry(v.data.serverConfig)).toMatchObject({ name: 'remote', transport: 'http', oauth: true, env_keys: ['REMOTE_TOKEN'] })
  })
})
