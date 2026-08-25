import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const h = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { SettingsService } from '../../../src/main/services/settings.service'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ensureDaemonEncKey } from '../../../src/main/daemon/daemon-enc-key'
import { materializeCredentialFiles } from '../../../src/main/services/mcp-credential-files'
import { setWorkspaceIdentityHooks, unlockWorkspaceEnvelopes } from '../../../src/main/runtime/identity-provisioner'
import type { KeySlotRecord } from '../../../src/main/crypto/envelope-crypto'

let rootDir: string
let agentsDir: string
let daemonDir: string

function makeSettings(): SettingsService {
  const settings = new SettingsService()
  settings.getOwnerIdentity().ensureIdentity()
  return settings
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-daemon-slot-'))
  h.userDataDir = join(rootDir, 'userData')
  agentsDir = join(rootDir, 'agents')
  daemonDir = join(rootDir, 'daemon')
  mkdirSync(h.userDataDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })
  mkdirSync(daemonDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function keySlotDids(ws: AdfWorkspace, envelope: 'identity' | 'credentials'): string[] {
  return (ws.readEnvelopeSlots(envelope) ?? [])
    .filter((s) => s.type !== 'password')
    .map((s) => (s as KeySlotRecord).recipient_did)
}

describe('trusted daemon envelope slots (mcp-credential-identity Phase C)', () => {
  it('adds a credentials slot for each trusted daemon key — never on the identity envelope — idempotently', () => {
    const daemonKey = ensureDaemonEncKey(daemonDir)
    const settings = makeSettings()
    settings.set('trustedDaemonEncKeys', [daemonKey.publicKeyB64])
    const svc = settings.getOwnerIdentity()

    const ws = AdfWorkspace.create(join(agentsDir, 'a.adf'), { name: 'a' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      expect(keySlotDids(ws, 'credentials')).toContain(daemonKey.label)
      expect(keySlotDids(ws, 'identity')).not.toContain(daemonKey.label)

      const before = (ws.readEnvelopeSlots('credentials') ?? []).length
      svc.ensureWorkspaceIdentity(ws)
      svc.unlockWorkspaceEnvelopes(ws)
      expect((ws.readEnvelopeSlots('credentials') ?? []).length).toBe(before)
    } finally {
      ws.close()
    }
  })

  it('lets the daemon key unlock credentials (round-trip) while identity stays foreign to it', () => {
    const daemonKey = ensureDaemonEncKey(daemonDir)
    const settings = makeSettings()
    settings.set('trustedDaemonEncKeys', [daemonKey.publicKeyB64])
    const svc = settings.getOwnerIdentity()

    const path = join(agentsDir, 'b.adf')
    const ws = AdfWorkspace.create(path, { name: 'b' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      ws.setIdentitySealed('mcp:@x/drive:file:~/.config/x/tokens.json', JSON.stringify({ encoding: 'base64', data: Buffer.from('tok').toString('base64'), mode: 384 }))
    } finally {
      ws.close()
    }

    // Reopen cold, as the daemon would — only the daemon's file-based key.
    const reopened = AdfWorkspace.open(path)
    try {
      expect(reopened.getIdentityDecrypted('mcp:@x/drive:file:~/.config/x/tokens.json', null)).toBeNull()
      const states = reopened.unlockEnvelopes({ runtimeEncPrivateKey: daemonKey.privateKeyPkcs8 })
      expect(states.credentials).toBe('unlocked')
      expect(states.identity).not.toBe('unlocked')
      const raw = reopened.getIdentityDecrypted('mcp:@x/drive:file:~/.config/x/tokens.json', null)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw as string).data).toBe(Buffer.from('tok').toString('base64'))
    } finally {
      reopened.close()
    }
  })

  it('ignores malformed trusted keys without breaking unlock', () => {
    const settings = makeSettings()
    settings.set('trustedDaemonEncKeys', ['definitely-not-a-key'])
    const svc = settings.getOwnerIdentity()
    const ws = AdfWorkspace.create(join(agentsDir, 'c.adf'), { name: 'c' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
      expect(keySlotDids(ws, 'credentials').some((d) => d.startsWith('daemon:'))).toBe(false)
    } finally {
      ws.close()
    }
  })

  it('an un-provisioned daemon fails required-file materialization with the locked hint', async () => {
    // No trusted key registered — Studio seals a row, daemon has no slot.
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()
    const path = join(agentsDir, 'd.adf')
    const ws = AdfWorkspace.create(path, { name: 'd' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      ws.setIdentitySealed('mcp:@x/drive:file:~/.config/x/keys.json', JSON.stringify({ encoding: 'base64', data: 'QQ==', mode: 384 }))
    } finally {
      ws.close()
    }

    const daemonView = AdfWorkspace.open(path) // no unlock — daemon without a slot
    try {
      const hint = 'Add this daemon\'s runtime key (/tmp/daemon/runtime-enc-key.pub) to Studio\'s trusted daemon keys (trustedDaemonEncKeys), then open the agent in Studio once.'
      await expect(materializeCredentialFiles(
        {
          getDecrypted: (p) => daemonView.getIdentityDecrypted(p, null),
          hasRow: (p) => daemonView.getIdentityRow(p) !== null,
          envelopeLockedHint: hint,
        },
        { name: 'drive', transport: 'stdio', npm_package: '@x/drive', credential_files: [{ path: '~/.config/x/keys.json', required: true }] },
        { kind: 'container', containerName: 'adf-mcp', home: '/workspace/x/home', copyToContainer: async () => {}, copyFromContainer: async () => {}, fileExists: async () => false },
      )).rejects.toThrow(/locked in this runtime.*trustedDaemonEncKeys.*open the agent in Studio once/s)
    } finally {
      daemonView.close()
    }
  })

  it('replaces a pre-planted junk slot carrying the daemon label (label squat)', () => {
    const daemonKey = ensureDaemonEncKey(daemonDir)
    const settings = makeSettings()
    const svc = settings.getOwnerIdentity()

    const path = join(agentsDir, 'e.adf')
    const ws = AdfWorkspace.create(path, { name: 'e' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      // Attacker .adf pre-plants a slot with the victim daemon's LABEL but junk key material.
      ws.addEnvelopeKeySlot('credentials', 'runtime', daemonKey.label, randomBytes(32))
      // Enrollment must re-wrap (replace), not skip on the existing label.
      settings.set('trustedDaemonEncKeys', [daemonKey.publicKeyB64])
      svc.unlockWorkspaceEnvelopes(ws)
      ws.setIdentitySealed('mcp:@x/drive:k', 'sealed-value')
    } finally {
      ws.close()
    }

    const reopened = AdfWorkspace.open(path)
    try {
      const states = reopened.unlockEnvelopes({ runtimeEncPrivateKey: daemonKey.privateKeyPkcs8 })
      expect(states.credentials).toBe('unlocked')
      expect(reopened.getIdentityDecrypted('mcp:@x/drive:k', null)).toBe('sealed-value')
    } finally {
      reopened.close()
    }
  })

  it('revokes daemon slots removed from trustedDaemonEncKeys, leaving owner/runtime slots intact', () => {
    const daemonKey = ensureDaemonEncKey(daemonDir)
    const settings = makeSettings()
    settings.set('trustedDaemonEncKeys', [daemonKey.publicKeyB64])
    const svc = settings.getOwnerIdentity()

    const path = join(agentsDir, 'f.adf')
    const ws = AdfWorkspace.create(path, { name: 'f' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      expect(keySlotDids(ws, 'credentials')).toContain(daemonKey.label)
      const nonDaemonBefore = keySlotDids(ws, 'credentials').filter((d) => !d.startsWith('daemon:'))

      settings.set('trustedDaemonEncKeys', [])
      svc.unlockWorkspaceEnvelopes(ws)
      expect(keySlotDids(ws, 'credentials')).not.toContain(daemonKey.label)
      expect(keySlotDids(ws, 'credentials').filter((d) => !d.startsWith('daemon:'))).toEqual(nonDaemonBefore)
    } finally {
      ws.close()
    }

    // The revoked daemon can no longer unlock.
    const reopened = AdfWorkspace.open(path)
    try {
      const states = reopened.unlockEnvelopes({ runtimeEncPrivateKey: daemonKey.privateKeyPkcs8 })
      expect(states.credentials).not.toBe('unlocked')
    } finally {
      reopened.close()
    }
  })

  it('unlocks through the daemon hook WIRING (setWorkspaceIdentityHooks), not just the direct envelope API', () => {
    const daemonKey = ensureDaemonEncKey(daemonDir)
    const settings = makeSettings()
    settings.set('trustedDaemonEncKeys', [daemonKey.publicKeyB64])
    const svc = settings.getOwnerIdentity()

    const path = join(agentsDir, 'g.adf')
    const ws = AdfWorkspace.create(path, { name: 'g' })
    try {
      svc.ensureWorkspaceIdentity(ws)
      ws.setIdentitySealed('mcp:@x/drive:hook', 'via-hooks')
    } finally {
      ws.close()
    }

    // Register hooks exactly as daemon/index.ts does, then drive the same
    // module-level entry point the runtime uses.
    setWorkspaceIdentityHooks({
      ensureIdentity: (w) => { w.unlockEnvelopes({ runtimeEncPrivateKey: daemonKey.privateKeyPkcs8 }) },
      unlockEnvelopes: (w) => { w.unlockEnvelopes({ runtimeEncPrivateKey: daemonKey.privateKeyPkcs8 }) },
    })
    try {
      const reopened = AdfWorkspace.open(path)
      try {
        expect(reopened.getIdentityDecrypted('mcp:@x/drive:hook', null)).toBeNull()
        unlockWorkspaceEnvelopes(reopened)
        expect(reopened.getIdentityDecrypted('mcp:@x/drive:hook', null)).toBe('via-hooks')
      } finally {
        reopened.close()
      }
    } finally {
      // Reset the module-global hooks so later tests aren't affected.
      setWorkspaceIdentityHooks({ ensureIdentity: () => {}, unlockEnvelopes: () => {} })
    }
  })
})
