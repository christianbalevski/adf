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

// The card's policies must project what the runtime does: `send` what egress
// produces, `receive` what ingress rejects.

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

const encryptionPolicy = (security: SecurityConfig) =>
  cardFor(security).policies?.find(p => p.type === 'encryption')

describe('agent card signing and encryption policies', () => {
  it('signing: send follows the level, receive follows the require settings', () => {
    expect(signingPolicy({ level: 1 })).toEqual({ type: 'signing', standard: 'ed25519', send: 'required', receive: 'optional' })
    expect(signingPolicy({ level: 1, require_signature: true })).toMatchObject({ send: 'required', receive: 'required' })
    expect(signingPolicy({ level: 1, require_payload_signature: true })).toMatchObject({ receive: 'required' })
    expect(signingPolicy({ level: 0, require_signature: true })).toMatchObject({ send: 'optional', receive: 'required' })
    expect(signingPolicy({ level: 0 })).toBeUndefined()
  })

  it('encryption: send at level 2, receive with require_encryption', () => {
    expect(encryptionPolicy({ level: 1 })).toBeUndefined()
    expect(encryptionPolicy({ level: 2 })).toMatchObject({ send: 'required', receive: 'optional' })
    expect(encryptionPolicy({ level: 0, require_encryption: true })).toMatchObject({ send: 'optional', receive: 'required' })
  })

  it('an agent with no security settings advertises neither', () => {
    const config = { ...workspace.getAgentConfig() }
    delete (config as { security?: SecurityConfig }).security
    const agent: ServableAgent = {
      handle: 'card-signing-test', filePath: workspace.getFilePath(), config, workspace,
      triggerEvaluator: null, adfCallHandler: null, codeSandboxService: null,
      getSigningKey: () => workspace.getSigningKeys(null)?.privateKey ?? null
    }
    const types = buildAgentCard(agent, '127.0.0.1', 7295).policies?.map(p => p.type) ?? []
    expect(types).not.toContain('signing')
    expect(types).not.toContain('encryption')
  })
})
