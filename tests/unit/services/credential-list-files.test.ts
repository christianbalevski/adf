// Characterization of the credential "list files" scans behind Studio's
// MCP_CREDENTIAL_LIST_FILES, ADAPTER_CREDENTIAL_LIST_FILES and
// PROVIDER_CREDENTIAL_LIST_FILES handlers (ipc/index.ts), written against the
// handlers' behaviour before the scan moved into
// src/main/services/credential-list-files.ts (rule E1). Studio and the daemon
// route both call the module, so these cases pin the shared shape.
//
// Rules pinned here: known files (foreground, background) first, then each
// tracked directory walked depth 0..3; dot folders and node_modules skipped;
// a file is listed when it holds credentials under the prefix (populatedKeys =
// the key names, never values) or names the server / adapter / provider in its
// config; each path at most once; unreadable files skipped.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import {
  listAdapterCredentialFiles,
  listMcpCredentialFiles,
  listProviderCredentialFiles,
} from '../../../src/main/services/credential-list-files'

const SECRET = 'sk-test-SECRET-value-0001'

let root: string
let tracked: string
let outside: string

function makeAgent(filePath: string, name: string, edit: (ws: AdfWorkspace) => void): string {
  mkdirSync(join(filePath, '..'), { recursive: true })
  const ws = AdfWorkspace.create(filePath, { name })
  try { edit(ws) } finally { ws.close() }
  return filePath
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-cred-list-'))
  tracked = join(root, 'tracked')
  outside = join(root, 'outside')
  mkdirSync(tracked, { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('listMcpCredentialFiles', () => {
  it('lists files with stored credentials or the server in config, known files first', () => {
    const known = makeAgent(join(outside, 'agent-1.adf'), 'agent-1', (ws) => {
      ws.setIdentity('mcp:@acme/server:API_KEY', SECRET)
      ws.setIdentity('mcp:@acme/server:REGION', 'eu')
    })
    const configured = makeAgent(join(tracked, 'a', 'agent-2.adf'), 'agent-2', (ws) => {
      const config = ws.getAgentConfig()
      config.mcp = { servers: [{ name: 'acme', transport: 'stdio', command: 'node' }] }
      ws.setAgentConfig(config)
    })
    makeAgent(join(tracked, 'agent-3.adf'), 'agent-3', () => {})
    makeAgent(join(tracked, '.hidden', 'agent-4.adf'), 'agent-4', (ws) => ws.setIdentity('mcp:@acme/server:API_KEY', SECRET))
    makeAgent(join(tracked, 'node_modules', 'agent-5.adf'), 'agent-5', (ws) => ws.setIdentity('mcp:@acme/server:API_KEY', SECRET))
    const depth3 = makeAgent(join(tracked, 'a', 'b', 'c', 'agent-6.adf'), 'agent-6', (ws) => ws.setIdentity('mcp:@acme/server:API_KEY', SECRET))
    makeAgent(join(tracked, 'a', 'b', 'c', 'd', 'agent-7.adf'), 'agent-7', (ws) => ws.setIdentity('mcp:@acme/server:API_KEY', SECRET))
    writeFileSync(join(tracked, 'broken.adf'), 'not a database')

    const result = listMcpCredentialFiles(
      { mcpServerName: 'acme', npmPackage: '@acme/server' },
      { knownFiles: [known, known], trackedDirs: [tracked, join(root, 'missing')] },
    )

    const byPath = new Map(result.files.map((f) => [f.filePath, f]))
    expect(result.files[0].filePath).toBe(known)
    expect(byPath.get(known)).toEqual({ filePath: known, fileName: 'agent-1.adf', hasCredentials: true, populatedKeys: expect.arrayContaining(['API_KEY', 'REGION']) })
    expect(byPath.get(configured)).toEqual({ filePath: configured, fileName: 'agent-2.adf', hasCredentials: false, populatedKeys: [] })
    expect(byPath.get(depth3)?.hasCredentials).toBe(true)
    expect(result.files.map((f) => f.fileName).sort()).toEqual(['agent-1.adf', 'agent-2.adf', 'agent-6.adf'])
    // Metadata only: key names, never the stored values.
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

describe('listAdapterCredentialFiles', () => {
  it('lists files with adapter credentials or the adapter type in config', () => {
    const withCreds = makeAgent(join(tracked, 'agent-1.adf'), 'agent-1', (ws) => ws.setIdentity('adapter:telegram:BOT_TOKEN', SECRET))
    const configured = makeAgent(join(tracked, 'agent-2.adf'), 'agent-2', (ws) => {
      const config = ws.getAgentConfig()
      config.adapters = { telegram: { enabled: true } }
      ws.setAgentConfig(config)
    })
    makeAgent(join(tracked, 'agent-3.adf'), 'agent-3', (ws) => ws.setIdentity('adapter:email:PASSWORD', SECRET))

    const result = listAdapterCredentialFiles('telegram', { knownFiles: [], trackedDirs: [tracked] })
    expect(result.files.sort((a, b) => a.fileName.localeCompare(b.fileName))).toEqual([
      { filePath: withCreds, fileName: 'agent-1.adf', hasCredentials: true, populatedKeys: ['BOT_TOKEN'] },
      { filePath: configured, fileName: 'agent-2.adf', hasCredentials: false, populatedKeys: [] },
    ])
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

describe('listProviderCredentialFiles', () => {
  it('lists files with provider credentials or the provider copy, with the secret-free copy', () => {
    const provider = { id: 'custom:ab12cd', type: 'openai-compatible' as const, name: 'Local', baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'm-1', requestDelayMs: 5 }
    const both = makeAgent(join(tracked, 'agent-1.adf'), 'agent-1', (ws) => {
      ws.setIdentity('provider:custom:ab12cd:apiKey', SECRET)
      const config = ws.getAgentConfig()
      config.providers = [provider]
      ws.setAgentConfig(config)
    })
    const keyOnly = makeAgent(join(tracked, 'agent-2.adf'), 'agent-2', (ws) => ws.setIdentity('provider:custom:ab12cd:apiKey', SECRET))
    const copyOnly = makeAgent(join(tracked, 'agent-3.adf'), 'agent-3', (ws) => {
      const config = ws.getAgentConfig()
      config.providers = [provider]
      ws.setAgentConfig(config)
    })
    makeAgent(join(tracked, 'agent-4.adf'), 'agent-4', () => {})

    const result = listProviderCredentialFiles('custom:ab12cd', { knownFiles: [], trackedDirs: [tracked] })
    const copy = { defaultModel: 'm-1', params: undefined, requestDelayMs: 5 }
    expect(result.files.sort((a, b) => a.fileName.localeCompare(b.fileName))).toEqual([
      { filePath: both, fileName: 'agent-1.adf', hasCredentials: true, populatedKeys: ['apiKey'], providerConfig: copy },
      { filePath: keyOnly, fileName: 'agent-2.adf', hasCredentials: true, populatedKeys: ['apiKey'], providerConfig: undefined },
      { filePath: copyOnly, fileName: 'agent-3.adf', hasCredentials: false, populatedKeys: [], providerConfig: copy },
    ])
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
