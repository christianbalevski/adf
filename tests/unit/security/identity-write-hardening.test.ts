import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  AdfWorkspace,
  isCodeForbiddenIdentityWrite,
} from '../../../src/main/adf/adf-workspace'

/**
 * Finding #2: agent code could overwrite runtime-owned key material. The
 * code-facing identity write sink (setIdentityFromCode) and the guard behind it
 * must reject the whole `crypto:*` namespace while leaving owner/UI/runtime
 * writes (plain setIdentity) untouched. The shell `export` and set_identity code
 * method both route through this sink; the shell variable READ routes through
 * getIdentityForCode, which already hard-blocks crypto:* and code_access=0 rows.
 */
describe('identity write hardening', () => {
  let ws: AdfWorkspace
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-idsec-'))
    ws = AdfWorkspace.create(join(dir, 'agent-1.adf'), { name: 'agent-1' })
    ws.setIdentity('crypto:signing:private_key', 'REAL-KEY')
  })

  afterAll(() => {
    try { ws.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('guard flags every crypto:* purpose and nothing else', () => {
    expect(isCodeForbiddenIdentityWrite('crypto:signing:private_key')).toBe(true)
    expect(isCodeForbiddenIdentityWrite('crypto:envelope:identity')).toBe(true)
    expect(isCodeForbiddenIdentityWrite('crypto:kdf:salt')).toBe(true)
    expect(isCodeForbiddenIdentityWrite('crypto:anything:new')).toBe(true)
    expect(isCodeForbiddenIdentityWrite('mcp:garmin:GARMIN_EMAIL')).toBe(false)
    expect(isCodeForbiddenIdentityWrite('adapter:telegram:TELEGRAM_BOT_TOKEN')).toBe(false)
    expect(isCodeForbiddenIdentityWrite('openai_api_key')).toBe(false)
  })

  it('setIdentityFromCode refuses to overwrite crypto:* key material', () => {
    expect(() => ws.setIdentityFromCode('crypto:signing:private_key', 'ATTACKER-KEY')).toThrow(/crypto/)
    // Untouched.
    expect(ws.getIdentity('crypto:signing:private_key')).toBe('REAL-KEY')
  })

  it('setIdentityFromCode refuses crypto:envelope:* and crypto:kdf:*', () => {
    expect(() => ws.setIdentityFromCode('crypto:envelope:identity', 'x')).toThrow()
    expect(() => ws.setIdentityFromCode('crypto:kdf:salt', 'x')).toThrow()
  })

  it('setIdentityFromCode allows ordinary agent credentials (code-readable)', () => {
    ws.setIdentityFromCode('mcp:garmin:GARMIN_EMAIL', 'user@example.com')
    expect(ws.getIdentityForCode('mcp:garmin:GARMIN_EMAIL', null)).toBe('user@example.com')
  })

  it('owner/UI setIdentity path still writes crypto:* (unchanged behavior)', () => {
    ws.setIdentity('crypto:signing:private_key', 'ROTATED-BY-OWNER')
    expect(ws.getIdentity('crypto:signing:private_key')).toBe('ROTATED-BY-OWNER')
  })

  it('getIdentityForCode never returns crypto:* even when present', () => {
    expect(ws.getIdentityForCode('crypto:signing:private_key', null)).toBeNull()
  })
})
