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

import { buildAgentCard, verifyCardSignature } from '../../../src/main/services/mesh-server'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { createAttestation, writeAdfAttestations, verifyAttestation } from '../../../src/main/services/attestation.service'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import type { ServableAgent } from '../../../src/main/runtime/mesh-manager'

let dir: string
let workspace: AdfWorkspace
let agentDid: string
const owner = (() => {
  const kp = generateEd25519KeyPair()
  return { ...kp, did: publicKeyToDid(extractRawPublicKey(kp.publicKey)) }
})()

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-card-att-'))
  workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'card-att-test' })
  agentDid = workspace.generateIdentityKeys(null).did
  writeAdfAttestations(workspace, [
    createAttestation({ issuer: owner.did, subject: agentDid, role: 'owner', issued_at: new Date().toISOString() }, owner.privateKey),
    // Stale (different subject) and expired entries must be filtered out of the card
    createAttestation({ issuer: owner.did, subject: 'did:key:zOldSubject', role: 'owner', issued_at: new Date().toISOString() }, owner.privateKey),
    createAttestation({ issuer: owner.did, subject: agentDid, role: 'operator', issued_at: new Date().toISOString(), expires_at: '2000-01-01T00:00:00.000Z' }, owner.privateKey)
  ])
})

afterAll(() => {
  workspace.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function makeAgent(publish: boolean): ServableAgent {
  const config = workspace.getAgentConfig()
  config.card = { ...(config.card ?? {}), publish_attestations: publish || undefined }
  return {
    handle: 'card-att-test',
    filePath: workspace.getFilePath(),
    config,
    workspace,
    triggerEvaluator: null,
    adfCallHandler: null,
    codeSandboxService: null,
    getSigningKey: () => workspace.getSigningKeys(null)?.privateKey ?? null
  }
}

describe('buildAgentCard attestation fill', () => {
  it('default (opt-in absent) → empty attestations, no owner_attestation policy', () => {
    const card = buildAgentCard(makeAgent(false), '127.0.0.1', 7295)
    expect(card.attestations).toEqual([])
    expect((card.policies ?? []).some((p) => p.type === 'owner_attestation')).toBe(false)
  })

  it('opted in → current-subject unexpired attestations only, policy advertised, card signature covers them', () => {
    const card = buildAgentCard(makeAgent(true), '127.0.0.1', 7295)
    expect(card.attestations).toHaveLength(1)
    expect(card.attestations![0].subject).toBe(agentDid)
    expect(card.attestations![0].role).toBe('owner')
    expect(verifyAttestation(card.attestations![0], { expectedSubject: card.did! })).toBe(true)
    expect((card.policies ?? []).some((p) => p.type === 'owner_attestation')).toBe(true)

    // Card signature is valid and pins the attestations
    expect(verifyCardSignature(card)).toBe(true)
    const tampered = { ...card, attestations: [] }
    expect(verifyCardSignature(tampered)).toBe(false)
  })

  it('verifyCardSignature rejects unsigned or DID-less cards', () => {
    const card = buildAgentCard(makeAgent(true), '127.0.0.1', 7295)
    expect(verifyCardSignature({ ...card, signature: undefined })).toBe(false)
    expect(verifyCardSignature({ ...card, did: undefined })).toBe(false)
  })
})
