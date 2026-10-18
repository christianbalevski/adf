/**
 * Characterization of the MCP and adapter IPC argument schemas (Studio's
 * ipc/index.ts, before the E1 extraction into ipc/mcp-adapter-args.ts): what
 * each accepts, what it strips, and the refusal each gives.
 */
import { describe, expect, it } from 'vitest'
import {
  AdapterAttachArgs, AdapterCredentialGetArgs, AdapterCredentialSetArgs, AdapterDetachArgs, AdapterListFilesArgs,
  AdapterPackageArgs, AdapterTypeArgs, McpAttachArgs, McpCredentialGetArgs, McpCredentialListArgs, McpCredentialSetArgs,
  McpDetachArgs, McpNameArgs, McpPackageArgs, McpUninstallArgs, validateMcpArgs,
} from '../../../src/main/ipc/mcp-adapter-args'

const FILE = '/agents/agent-1.adf'

describe('MCP argument schemas (E1)', () => {
  it('validateMcpArgs answers the data, or "Invalid arguments: " with every issue message', () => {
    expect(validateMcpArgs(McpPackageArgs, { package: 'p', name: 'n', extra: 1 })).toEqual({ data: { package: 'p', name: 'n' } })
    const bad = validateMcpArgs(McpPackageArgs, { package: '', name: 3 })
    expect(bad).toHaveProperty('error')
    expect((bad as { error: string }).error).toMatch(/^Invalid arguments: .+, .+$/)
    expect(validateMcpArgs(McpUninstallArgs, {})).toHaveProperty('error')
    expect(validateMcpArgs(McpNameArgs, { name: 'srv' })).toEqual({ data: { name: 'srv' } })
  })

  it('credential schemas require non-empty strings, value may be empty', () => {
    expect(validateMcpArgs(McpCredentialSetArgs, { filePath: FILE, npmPackage: 'p', envKey: 'K', value: '' })).toEqual({ data: { filePath: FILE, npmPackage: 'p', envKey: 'K', value: '' } })
    expect(validateMcpArgs(McpCredentialSetArgs, { filePath: FILE, npmPackage: 'p', envKey: '', value: 'v' })).toHaveProperty('error')
    expect(validateMcpArgs(McpCredentialGetArgs, { filePath: FILE, npmPackage: 'p' })).toEqual({ data: { filePath: FILE, npmPackage: 'p' } })
    expect(validateMcpArgs(McpCredentialListArgs, { mcpServerName: 's' })).toHaveProperty('error')
  })

  it('attach keeps the listed server fields (OAuth flags included) and strips the rest; url must be a URL', () => {
    const serverConfig = { name: 'srv', type: 'http', url: 'https://mcp.example.com', oauth: true, oauthClientId: 'c', oauthScopes: ['a'], runLocation: 'host', unknown: 'x' }
    expect(validateMcpArgs(McpAttachArgs, { filePath: FILE, serverConfig })).toEqual({ data: { filePath: FILE, serverConfig: { name: 'srv', type: 'http', url: 'https://mcp.example.com', oauth: true, oauthClientId: 'c', oauthScopes: ['a'], runLocation: 'host' } } })
    expect(validateMcpArgs(McpAttachArgs, { filePath: FILE, serverConfig: { name: 'srv', url: 'not a url' } })).toHaveProperty('error')
    expect(validateMcpArgs(McpAttachArgs, { filePath: FILE, serverConfig: { name: 'srv', type: 'docker' } })).toHaveProperty('error')
    expect(validateMcpArgs(McpDetachArgs, { filePath: FILE, serverName: 'srv', credentialNamespace: 'mcp:srv' })).toEqual({ data: { filePath: FILE, serverName: 'srv', credentialNamespace: 'mcp:srv' } })
  })
})

describe('adapter argument schemas (E1)', () => {
  it('parse accepts plain strings (empty included) and throws a ZodError otherwise', () => {
    expect(AdapterPackageArgs.parse({ package: '' })).toEqual({ package: '' })
    expect(() => AdapterPackageArgs.parse({})).toThrow()
    expect(AdapterTypeArgs.parse({ type: 'telegram' })).toEqual({ type: 'telegram' })
    expect(AdapterCredentialSetArgs.parse({ filePath: FILE, adapterType: 't', envKey: 'K', value: 'v' })).toEqual({ filePath: FILE, adapterType: 't', envKey: 'K', value: 'v' })
    expect(AdapterCredentialGetArgs.parse({ filePath: FILE, adapterType: 't', x: 1 })).toEqual({ filePath: FILE, adapterType: 't' })
    expect(AdapterListFilesArgs.parse({ adapterType: 't' })).toEqual({ adapterType: 't' })
    expect(AdapterDetachArgs.parse({ filePath: FILE, adapterType: 't' })).toEqual({ filePath: FILE, adapterType: 't' })
  })

  it('attach validates the policy enums and a positive integer attachment limit', () => {
    const config = { enabled: true, policy: { dm: 'allowlist', groups: 'mention', allow_from: ['1'] }, limits: { max_attachment_size: 10 } }
    expect(AdapterAttachArgs.parse({ filePath: FILE, adapterType: 't', config })).toEqual({ filePath: FILE, adapterType: 't', config })
    expect(() => AdapterAttachArgs.parse({ filePath: FILE, adapterType: 't', config: { enabled: true, policy: { dm: 'some' } } })).toThrow()
    expect(() => AdapterAttachArgs.parse({ filePath: FILE, adapterType: 't', config: { enabled: true, limits: { max_attachment_size: 0 } } })).toThrow()
  })
})
