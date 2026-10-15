/**
 * Settings → Backend, Remote daemon: a confirmed plain-http URL can be
 * un-confirmed without changing the URL. Saving with the box unchecked
 * withdraws the confirmation; the token is kept, and the transport rule
 * blocks connecting until the box is checked again or the URL changes.
 */
import { describe, expect, it } from 'vitest'
import { remoteSaveBlocked } from '../../../src/renderer/components/settings/BackendSettings'
import { applyBackendPatch, defaultBackendConfig, remoteTransportRefusal, type SecretCodec, type StudioBackendConfig } from '../../../src/main/backend/backend-config'

const codec: SecretCodec = { available: () => true, encrypt: (plain) => `safe:${plain}`, decrypt: (stored) => stored.slice(5) }
const URL_HTTP = 'http://192.168.1.5:7385'

describe('remoteSaveBlocked (the Save button)', () => {
  const draft = { kind: 'insecure-http' as const, urlChanged: false, confirmed: false, savedConfirmed: true, newToken: false }

  it('allows saving the saved plain-http URL with its confirmation unchecked (a withdrawal)', () => {
    expect(remoteSaveBlocked(draft)).toBeNull()
  })

  it('still refuses unconfirmed plain http for a new URL, a never-confirmed URL, or with a new token', () => {
    expect(remoteSaveBlocked({ ...draft, urlChanged: true })).toBe('unconfirmed')
    expect(remoteSaveBlocked({ ...draft, savedConfirmed: false })).toBe('unconfirmed')
    expect(remoteSaveBlocked({ ...draft, newToken: true })).toBe('unconfirmed')
    expect(remoteSaveBlocked({ ...draft, kind: 'invalid' })).toBe('invalid')
    expect(remoteSaveBlocked({ ...draft, confirmed: true })).toBeNull()
    expect(remoteSaveBlocked({ ...draft, kind: 'https' })).toBeNull()
  })
})

describe('what main does with that save', () => {
  it('withdraws the confirmation, keeps the token, says so, and the transport rule blocks connecting', () => {
    const current: StudioBackendConfig = { ...defaultBackendConfig(), remote: { url: URL_HTTP, token: 'safe:tok_1234567890', allowInsecureHttp: true } }
    expect(remoteTransportRefusal(current)).toBeNull()
    // The renderer's patch for that Save (saveRemote): the URL as saved, unchecked, no token.
    const result = applyBackendPatch(current, { remoteUrl: URL_HTTP, allowInsecureHttp: false }, { codec, allowModeChange: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.remote).toEqual({ url: URL_HTTP, token: 'safe:tok_1234567890', allowInsecureHttp: false })
    expect(result.notices.join(' ')).toMatch(/will not send the token to http:\/\/192\.168\.1\.5:7385 until you confirm plain http/)
    expect(remoteTransportRefusal(result.config)).not.toBeNull()
    // Checking the box again restores it.
    const again = applyBackendPatch(result.config, { remoteUrl: URL_HTTP, allowInsecureHttp: true, insecureHttpOrigin: URL_HTTP }, { codec, allowModeChange: true })
    expect(again.ok && again.config.remote.allowInsecureHttp).toBe(true)
  })
})
