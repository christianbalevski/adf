import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'

let rootDir: string

function makeWorkspace(name: string): AdfWorkspace {
  return AdfWorkspace.create(join(rootDir, `${name}.adf`), { name })
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-did-history-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('adf_did_history (ADF_IDENTITY_SPEC D3)', () => {
  it('is empty for a fresh workspace and after first provisioning', () => {
    const ws = makeWorkspace('fresh')
    try {
      expect(ws.getDidHistory()).toEqual([])
      ws.generateIdentityKeys(null)
      expect(ws.getDidHistory()).toEqual([])
    } finally {
      ws.close()
    }
  })

  it('appends the prior DID on regeneration, oldest first', () => {
    const ws = makeWorkspace('rotate')
    try {
      const first = ws.generateIdentityKeys(null).did
      const second = ws.generateIdentityKeys(null).did
      expect(second).not.toBe(first)
      expect(ws.getDidHistory()).toEqual([first])
      expect(ws.getDid()).toBe(second)

      const third = ws.generateIdentityKeys(null).did
      expect(ws.getDidHistory()).toEqual([first, second])
      expect(ws.getDid()).toBe(third)
    } finally {
      ws.close()
    }
  })

  it('preserves the DID across identity reset (wipeAllIdentity)', () => {
    const ws = makeWorkspace('reset')
    try {
      const did = ws.generateIdentityKeys(null).did
      ws.wipeAllIdentity()
      expect(ws.getDid()).toBe('')
      expect(ws.getDidHistory()).toEqual([did])

      // Re-provision after reset: history retained, no empty-string entries
      const fresh = ws.generateIdentityKeys(null).did
      expect(ws.getDid()).toBe(fresh)
      expect(ws.getDidHistory()).toEqual([did])
    } finally {
      ws.close()
    }
  })

  it('covers the claim sequence: delete keys, regenerate — old DID survives', () => {
    // Mirrors IPC.IDENTITY_CLAIM: signing keys deleted, then generateIdentityKeys.
    const ws = makeWorkspace('claim')
    try {
      const original = ws.generateIdentityKeys(null).did
      ws.getDatabase().deleteIdentity('crypto:signing:private_key')
      ws.getDatabase().deleteIdentity('crypto:signing:public_key')
      const claimed = ws.generateIdentityKeys(null).did
      expect(claimed).not.toBe(original)
      expect(ws.getDidHistory()).toEqual([original])
    } finally {
      ws.close()
    }
  })

  it('never duplicates an entry', () => {
    const ws = makeWorkspace('dedupe')
    try {
      const did = ws.generateIdentityKeys(null).did
      ws.wipeAllIdentity()
      // wipe again — adf_did is now '', nothing new to record
      ws.wipeAllIdentity()
      expect(ws.getDidHistory()).toEqual([did])
    } finally {
      ws.close()
    }
  })

  it('is written with readonly protection and tolerates corrupt JSON', () => {
    const ws = makeWorkspace('protection')
    try {
      ws.generateIdentityKeys(null)
      ws.generateIdentityKeys(null)
      expect(ws.getDatabase().getMetaProtection('adf_did_history')).toBe('readonly')

      // Corrupt the value directly — reader must degrade to []
      ws.getDatabase().setMeta('adf_did_history', 'not-json', 'readonly')
      expect(ws.getDidHistory()).toEqual([])
    } finally {
      ws.close()
    }
  })
})
