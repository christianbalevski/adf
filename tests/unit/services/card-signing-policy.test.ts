import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { buildAgentCard } from '../../../src/main/services/mesh-server'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { ServableAgent } from '../../../src/main/runtime/mesh-manager'
import type { SecurityConfig } from '../../../src/shared/types/adf-v02.types'

// The card's signing policy must project what the runtime actually enforces:
// `receive: 'required'` only when the ingress pipeline rejects unsigned input.

let dir: string
let workspace: AdfWorkspace

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-card-signing-'))
  workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'card-signing-test' })
  workspace.generateIdentityKeys(null)
})

afterAll(() => {
  workspace.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function cardFor(security: SecurityConfig) {
  const config = { ...workspace.getAgentConfig(), security }
  const agent: ServableAgent = {
    handle: 'card-signing-test',
    filePath: workspace.getFilePath(),
    config,
    workspace,
    triggerEvaluator: null,
    adfCallHandler: null,
    codeSandboxService: null,
    getSigningKey: () => workspace.getSigningKeys(null)?.privateKey ?? null
  }
  return buildAgentCard(agent, '127.0.0.1', 7295)
}

const signingPolicy = (security: SecurityConfig) =>
  cardFor(security).policies?.find(p => p.type === 'signing')

describe('agent card signing policy', () => {
  it('advertises receive optional when unsigned inbound is accepted', () => {
    expect(signingPolicy({ level: 2, allow_unsigned: true })).toMatchObject({ send: 'required', receive: 'optional' })
    expect(signingPolicy({ level: 1, allow_unsigned: true, require_signature: true })).toMatchObject({ receive: 'optional' })
    expect(signingPolicy({ level: 1, allow_unsigned: false })).toMatchObject({ receive: 'optional' })
  })

  it('advertises receive required when unsigned inbound is rejected', () => {
    expect(signingPolicy({ level: 1, allow_unsigned: false, require_signature: true }))
      .toEqual({ type: 'signing', standard: 'ed25519', send: 'required', receive: 'required' })
  })

  it('advertises receive required when a payload signature is required', () => {
    expect(signingPolicy({ level: 1, allow_unsigned: true, require_payload_signature: true }))
      .toMatchObject({ send: 'required', receive: 'required' })
  })

  it('falls back to accepting unsigned inbound when the agent has no security settings', () => {
    const config = { ...workspace.getAgentConfig() }
    delete (config as { security?: SecurityConfig }).security
    const agent: ServableAgent = {
      handle: 'card-signing-test', filePath: workspace.getFilePath(), config, workspace,
      triggerEvaluator: null, adfCallHandler: null, codeSandboxService: null,
      getSigningKey: () => workspace.getSigningKeys(null)?.privateKey ?? null
    }
    expect(buildAgentCard(agent, '127.0.0.1', 7295).policies?.find(p => p.type === 'signing')).toBeUndefined()
  })

  it('at level 0, shows a signing policy only when inbound signatures are required', () => {
    expect(signingPolicy({ level: 0, allow_unsigned: true })).toBeUndefined()
    expect(signingPolicy({ level: 0, allow_unsigned: false, require_signature: true }))
      .toMatchObject({ send: 'optional', receive: 'required' })
    expect(signingPolicy({ level: 0, allow_unsigned: true, require_payload_signature: true }))
      .toMatchObject({ send: 'optional', receive: 'required' })
  })
})
