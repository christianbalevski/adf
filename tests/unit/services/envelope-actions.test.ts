// Characterization of Studio's per-file envelope, attestation and claim
// handlers (IDENTITY_ENVELOPE_STATUS, _SHARE_SET_PASSWORD,
// _SHARE_REMOVE_PASSWORD, _UNLOCK_PASSWORD, IDENTITY_ATTESTATIONS_GET,
// _REISSUE, IDENTITY_CLAIM in ipc/index.ts), written against their bodies
// before they moved into services/envelope-actions.ts (rule E1). The daemon's
// owner-envelope routes call the same functions.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

import { SettingsService } from '../../../src/main/services/settings.service'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import {
  claimAgentWorkspace,
  readAttestations,
  readEnvelopeStatus,
  reissueAttestations,
  removeSharePassword,
  setSharePassword,
  unlockWithSharePassword,
} from '../../../src/main/services/envelope-actions'

let rootDir: string
let settings: SettingsService

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-envelope-actions-'))
  h.userDataDir = join(rootDir, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  settings = new SettingsService()
  settings.getOwnerIdentity().ensureIdentity()
})

afterEach(() => { rmSync(rootDir, { recursive: true, force: true }) })

function provisioned(name: string): AdfWorkspace {
  const ws = AdfWorkspace.create(join(rootDir, `${name}.adf`), { name })
  settings.getOwnerIdentity().ensureWorkspaceIdentity(ws)
  return ws
}

const unlock = (ws: AdfWorkspace) => settings.getOwnerIdentity().unlockWorkspaceEnvelopes(ws)

describe('envelope status and share password', () => {
  it('reports both envelopes and the share-password slot', () => {
    const ws = provisioned('agent-1')
    try {
      const svc = settings.getOwnerIdentity()
      expect(readEnvelopeStatus(ws, svc, unlock)).toEqual({ success: true, identity: 'unlocked', credentials: 'unlocked', sharePasswordSet: false })
      expect(setSharePassword(ws, 'short')).toEqual({ success: false, error: 'Share password must be at least 8 characters' })
      expect(setSharePassword(ws, 'correct horse')).toEqual({ success: true })
      expect(setSharePassword(ws, 'battery staple')).toEqual({ success: true })
      expect((ws.readEnvelopeSlots('credentials') ?? []).filter((s) => s.type === 'password')).toHaveLength(1)
      expect(readEnvelopeStatus(ws, svc, unlock).sharePasswordSet).toBe(true)
      expect(removeSharePassword(ws)).toEqual({ success: true })
      expect(readEnvelopeStatus(ws, svc, unlock).sharePasswordSet).toBe(false)
    } finally {
      ws.close()
    }
  })

  it('unlock with the share password: wrong, session-only (adopt false), adopt', () => {
    const filePath = join(rootDir, 'agent-2.adf')
    const ws = provisioned('agent-2')
    setSharePassword(ws, 'correct horse')
    ws.close()
    // A fresh open is locked until something unlocks it.
    const fresh = AdfWorkspace.open(filePath)
    try {
      const svc = settings.getOwnerIdentity()
      expect(unlockWithSharePassword(fresh, 'wrong password', undefined, svc)).toEqual({ success: false, error: 'Wrong password' })
      expect(unlockWithSharePassword(fresh, 'correct horse', false, svc)).toEqual({ success: true, adopted: false, credentials: 'unlocked' })
      expect(unlockWithSharePassword(fresh, 'correct horse', true, svc)).toEqual({ success: true, adopted: true, credentials: 'unlocked' })
      // The password slot survives adoption (multi-route).
      expect((fresh.readEnvelopeSlots('credentials') ?? []).some((s) => s.type === 'password')).toBe(true)
    } finally {
      fresh.close()
    }
  })
})

describe('attestations', () => {
  it('reads and reissues the owner/operator attestations', () => {
    const ws = provisioned('agent-3')
    try {
      const svc = settings.getOwnerIdentity()
      const before = readAttestations(ws)
      expect(before.did).toBe(ws.getDid())
      expect(before.attestations.length).toBeGreaterThan(0)
      const after = reissueAttestations(ws, svc)
      expect(after.success).toBe(true)
      expect((after as { attestations: unknown[] }).attestations.length).toBeGreaterThan(0)
    } finally {
      ws.close()
    }
    const bare = AdfWorkspace.create(join(rootDir, 'agent-4.adf'), { name: 'agent-4' })
    try {
      expect(reissueAttestations(bare, settings.getOwnerIdentity())).toEqual({ success: false, error: 'Agent has no DID — generate keys first' })
      expect(readAttestations(bare)).toEqual({ attestations: [], did: null })
    } finally {
      bare.close()
    }
  })
})

describe('claimAgentWorkspace', () => {
  it('claims an identity-less file under the local owner', () => {
    const ws = AdfWorkspace.create(join(rootDir, 'agent-5.adf'), { name: 'agent-5' })
    try {
      const svc = settings.getOwnerIdentity()
      const ensureRuntimeIdentity = vi.fn(() => settings.ensureRuntimeIdentity())
      const result = claimAgentWorkspace(ws, { derivedKey: null, svc, ensureRuntimeIdentity, onPasswordRemoved: () => {} })
      expect(result).toEqual({ success: true, did: ws.getDid() })
      expect(ensureRuntimeIdentity).toHaveBeenCalled()
      expect(ws.getMeta('adf_owner_did')).toBe(svc.getOwnerDid())
    } finally {
      ws.close()
    }
  })

  it('refuses a password-protected file without the derived key, and without recipients', () => {
    const ws = AdfWorkspace.create(join(rootDir, 'agent-6.adf'), { name: 'agent-6' })
    try {
      ws.generateIdentityKeys(null)
      ws.setPassword('hunter22')
      const svc = settings.getOwnerIdentity()
      expect(claimAgentWorkspace(ws, { derivedKey: null, svc, ensureRuntimeIdentity: () => {}, onPasswordRemoved: () => {} }))
        .toEqual({ success: false, error: 'File is password-protected — enter the password before claiming' })
    } finally {
      ws.close()
    }
    const ws2 = AdfWorkspace.create(join(rootDir, 'agent-7.adf'), { name: 'agent-7' })
    try {
      const noKeys = Object.assign(Object.create(settings.getOwnerIdentity()), { getEnvelopeRecipients: () => null }) as Parameters<typeof claimAgentWorkspace>[1]['svc']
      expect(claimAgentWorkspace(ws2, { derivedKey: null, svc: noKeys, ensureRuntimeIdentity: () => {}, onPasswordRemoved: () => {} }))
        .toEqual({ success: false, error: 'Owner and runtime encryption keys are unavailable (keystore locked?), so the template cannot be claimed securely.' })
      expect(claimAgentWorkspace(ws2, { derivedKey: null, svc: settings.getOwnerIdentity(), ensureRuntimeIdentity: () => { throw new Error('no owner') }, onPasswordRemoved: () => {} }))
        .toEqual({ success: false, error: 'Error: no owner' })
    } finally {
      ws2.close()
    }
  })

  it('removes a password first when the derived key is known', () => {
    const ws = AdfWorkspace.create(join(rootDir, 'agent-8.adf'), { name: 'agent-8' })
    try {
      ws.generateIdentityKeys(null)
      ws.setPassword('hunter22')
      const key = ws.unlockWithPassword('hunter22')
      const onPasswordRemoved = vi.fn()
      const result = claimAgentWorkspace(ws, { derivedKey: key, svc: settings.getOwnerIdentity(), ensureRuntimeIdentity: () => {}, onPasswordRemoved })
      expect(result.success).toBe(true)
      expect(onPasswordRemoved).toHaveBeenCalledTimes(1)
      expect(ws.isPasswordProtected()).toBe(false)
    } finally {
      ws.close()
    }
  })
})
