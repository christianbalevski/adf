// Characterization of Studio's AGENT_REGISTRY_BRING_HOME body (ipc/index.ts),
// written against it before it moved into services/registry-bring-home.ts
// (rule E1): copy the registry file into the agents folder under the first
// free name, strip identity, fresh config.id, config.name from the file name,
// the app default provider when the model names none; built on a .partial,
// nothing left behind on failure.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { availableAdfPath, bringRegistryAgentHome } from '../../../src/main/services/registry-bring-home'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

let root: string
let folder: string
let source: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-bring-home-'))
  folder = join(root, 'agents')
  mkdirSync(join(root, 'registry'))
  source = join(root, 'registry', 'agent-1.adf')
  const ws = AdfWorkspace.create(source, { name: 'registry-agent' })
  try {
    ws.generateIdentityKeys(null)
    const config = ws.getAgentConfig()
    config.model = { ...config.model, provider: '', model_id: 'author-model' }
    ws.setAgentConfig(config)
  } finally {
    ws.close()
  }
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const providers: ProviderConfig[] = [
  { id: 'local', type: 'openai-compatible', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1' },
  { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-SECRET', defaultModel: 'claude-x' },
]

describe('bringRegistryAgentHome', () => {
  it('copies under the first free name with a fresh id, no identity and the default provider', async () => {
    const resolveFile = async () => ({ path: source, entry: { file: 'agent-1.adf' } })
    const first = await bringRegistryAgentHome(resolveFile, { agentsFolder: () => { mkdirSync(folder, { recursive: true }); return folder }, providers, defaultProviderId: 'anthropic' })
    expect(first).toEqual({ success: true, filePath: join(folder, 'agent-1.adf') })
    const second = await bringRegistryAgentHome(resolveFile, { agentsFolder: () => folder, providers, defaultProviderId: undefined })
    expect(second).toEqual({ success: true, filePath: join(folder, 'agent-1 (2).adf') })

    const ws = AdfWorkspace.open(join(folder, 'agent-1.adf'))
    try {
      const config = ws.getAgentConfig()
      expect(ws.getDid()).toBeNull()
      expect(config.id).toHaveLength(12)
      expect(config.name).toBe('agent-1')
      expect(config.model.provider).toBe('anthropic')
      expect(config.model.model_id).toBe('claude-x')
      expect(config.providers?.map((p) => p.id)).toEqual(['anthropic'])
      expect(JSON.stringify(config)).not.toContain('sk-ant-SECRET')
    } finally {
      ws.close()
    }
    const ws2 = AdfWorkspace.open(join(folder, 'agent-1 (2).adf'))
    try {
      // No default id: the first provider; it has no default model, so the author's is kept.
      expect(ws2.getAgentConfig().model).toMatchObject({ provider: 'local', model_id: 'author-model' })
      expect(ws2.getAgentConfig().name).toBe('agent-1 (2)')
    } finally {
      ws2.close()
    }
    expect(readdirSync(folder).filter((f) => f.includes('.partial'))).toEqual([])
  })

  it('a failure returns the error and leaves nothing behind', async () => {
    mkdirSync(folder)
    const bad = await bringRegistryAgentHome(async () => ({ path: join(root, 'missing.adf'), entry: { file: 'agent-2.adf' } }), { agentsFolder: () => folder, providers })
    expect(bad.success).toBe(false)
    expect(readdirSync(folder)).toEqual([])
    const unresolved = await bringRegistryAgentHome(async () => { throw new Error('Unknown registry agent "x"') }, { agentsFolder: () => folder, providers })
    expect(unresolved).toEqual({ success: false, error: 'Unknown registry agent "x"' })
  })

  it('availableAdfPath picks name.adf, then name (2).adf, …', () => {
    mkdirSync(folder)
    expect(availableAdfPath(folder, 'agent-3')).toBe(join(folder, 'agent-3.adf'))
    AdfWorkspace.create(join(folder, 'agent-3.adf'), { name: 'agent-3' }).close()
    expect(availableAdfPath(folder, 'agent-3')).toBe(join(folder, 'agent-3 (2).adf'))
    expect(existsSync(join(folder, 'agent-3 (2).adf'))).toBe(false)
  })
})
