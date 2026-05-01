import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { isLoopbackHost, rewriteLoopbackHost } from '../../../src/main/services/mesh-server'

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.5.6.7', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['::1', true],
    ['[::1]', true],
    ['::FFFF:127.0.0.1', true],
    ['192.168.1.179', false],
    ['10.0.0.5', false],
    ['MacBook-Pro.local', false],
    ['example.com', false],
    ['::ffff:192.168.1.1', false],
    ['', false]
  ])('%s → %s', (h, expected) => {
    expect(isLoopbackHost(h)).toBe(expected)
  })
})

describe('rewriteLoopbackHost', () => {
  it('rewrites 127.0.0.1 to observed peer IP', () => {
    expect(rewriteLoopbackHost('http://127.0.0.1:7295/runtime1/mesh/inbox', '192.168.1.176'))
      .toBe('http://192.168.1.176:7295/runtime1/mesh/inbox')
  })

  it('preserves port and path', () => {
    expect(rewriteLoopbackHost('http://localhost:8080/some/deep/path?x=1', '10.0.0.5'))
      .toBe('http://10.0.0.5:8080/some/deep/path?x=1')
  })

  it('leaves a non-loopback host untouched (sender declared a real endpoint)', () => {
    expect(rewriteLoopbackHost('http://my-public.example.com:7295/runtime1/mesh/inbox', '192.168.1.176'))
      .toBe('http://my-public.example.com:7295/runtime1/mesh/inbox')
  })

  it('does NOT rewrite when peer itself is loopback (same-host delivery)', () => {
    expect(rewriteLoopbackHost('http://127.0.0.1:7295/a/mesh/inbox', '127.0.0.1'))
      .toBe('http://127.0.0.1:7295/a/mesh/inbox')
  })

  it('unwraps IPv4-mapped IPv6 peer addresses (::ffff:192.168.x.x → 192.168.x.x)', () => {
    expect(rewriteLoopbackHost('http://127.0.0.1:7295/a/mesh/inbox', '::ffff:192.168.1.176'))
      .toBe('http://192.168.1.176:7295/a/mesh/inbox')
  })

  it('strips IPv6 zone id from the peer address', () => {
    // URL.hostname setter accepts a bare IPv6 and re-brackets it.
    const out = rewriteLoopbackHost('http://[::1]:7295/a/mesh/inbox', 'fe80::abcd%en0')
    expect(out).toBe('http://[fe80::abcd]:7295/a/mesh/inbox')
  })

  it('returns the original string when observedPeer is empty/null', () => {
    expect(rewriteLoopbackHost('http://127.0.0.1:7295/a', undefined))
      .toBe('http://127.0.0.1:7295/a')
    expect(rewriteLoopbackHost('http://127.0.0.1:7295/a', null))
      .toBe('http://127.0.0.1:7295/a')
  })

  it('returns the original string when URL is malformed', () => {
    expect(rewriteLoopbackHost('not a url at all', '192.168.1.176'))
      .toBe('not a url at all')
  })

  it('handles bracketed IPv6 loopback ([::1]) in the URL', () => {
    expect(rewriteLoopbackHost('http://[::1]:7295/a/mesh/inbox', '192.168.1.176'))
      .toBe('http://192.168.1.176:7295/a/mesh/inbox')
  })
})
