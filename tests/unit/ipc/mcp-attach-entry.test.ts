/**
 * Characterization of the entry MCP_ATTACH_SERVER writes into
 * adf_config.mcp.servers[] (embedded ipc/index.ts, extracted under rule E1 into
 * mcpAttachEntry, which the daemon-mode handler calls too).
 */
import { describe, expect, it } from 'vitest'
import { McpAttachArgs, mcpAttachEntry, validateMcpArgs } from '../../../src/main/ipc/mcp-adapter-args'

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

  it('an OAuth http server with a bearer fallback: the oauth flag is dropped, the bearer variable is the auth', () => {
    const entry = entryFor({
      name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true,
      bearerTokenEnvVar: 'REMOTE_TOKEN', envKeys: ['REMOTE_TOKEN'], credentialStorage: 'agent',
    })
    expect(entry.oauth).toBeUndefined()
    expect(entry.bearer_token_env_var).toBe('REMOTE_TOKEN')
    expect(entry).toMatchObject({ name: 'remote', transport: 'http', url: 'https://mcp.example.test/mcp', env_keys: ['REMOTE_TOKEN'] })
  })

  it('an OAuth-only http server: no auth at all', () => {
    const entry = entryFor({ name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true, credentialStorage: 'agent' })
    expect(entry.oauth).toBeUndefined()
    expect(entry.bearer_token_env_var).toBeUndefined()
  })
})
