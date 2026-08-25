import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ensureDaemonEncKey, daemonEncKeyLabel } from '../../../src/main/daemon/daemon-enc-key'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-key-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const posixOnly = process.platform === 'win32' ? describe.skip : describe

describe('ensureDaemonEncKey', () => {
  it('creates the keypair files with a matching public sidecar', () => {
    const key = ensureDaemonEncKey(dir)
    expect(existsSync(key.keyPath)).toBe(true)
    expect(existsSync(key.pubKeyPath)).toBe(true)
    expect(key.publicKeyRaw.length).toBe(32)
    expect(readFileSync(key.pubKeyPath, 'utf-8').trim()).toBe(key.publicKeyB64)
    expect(key.label).toBe(daemonEncKeyLabel(key.publicKeyRaw))
    expect(key.label).toMatch(/^daemon:[0-9a-f]{16}$/)
  })

  it('is stable across boots — same key every call', () => {
    const first = ensureDaemonEncKey(dir)
    const second = ensureDaemonEncKey(dir)
    expect(second.publicKeyB64).toBe(first.publicKeyB64)
    expect(second.privateKeyPkcs8.equals(first.privateKeyPkcs8)).toBe(true)
    expect(second.label).toBe(first.label)
  })

  it('heals a deleted or stale public sidecar from the private key', () => {
    const first = ensureDaemonEncKey(dir)
    unlinkSync(first.pubKeyPath)
    const second = ensureDaemonEncKey(dir)
    expect(readFileSync(second.pubKeyPath, 'utf-8').trim()).toBe(first.publicKeyB64)
  })

  it('refuses to mint over a corrupt key file', () => {
    const first = ensureDaemonEncKey(dir)
    writeFileSync(first.keyPath, 'not-json{{')
    expect(() => ensureDaemonEncKey(dir)).toThrow(/REFUSING to mint a replacement/)
    // The corrupt file is preserved for recovery, not overwritten.
    expect(readFileSync(first.keyPath, 'utf-8')).toBe('not-json{{')
  })
})

posixOnly('ensureDaemonEncKey (posix permissions)', () => {
  it('writes the private key file 0600', () => {
    const key = ensureDaemonEncKey(dir)
    expect(statSync(key.keyPath).mode & 0o777).toBe(0o600)
  })
})
