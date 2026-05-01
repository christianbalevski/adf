import { describe, it, expect } from 'vitest'
import { classifyRemote, ancestorScope, permits, denialReason } from '../../../src/main/runtime/scope-resolver'
import { sep } from 'path'

describe('classifyRemote', () => {
  it('treats undefined/null/empty as localhost', () => {
    expect(classifyRemote(undefined)).toBe('localhost')
    expect(classifyRemote(null)).toBe('localhost')
    expect(classifyRemote('')).toBe('localhost')
    expect(classifyRemote('   ')).toBe('localhost')
  })

  it('classifies IPv4 loopback as localhost', () => {
    expect(classifyRemote('127.0.0.1')).toBe('localhost')
    expect(classifyRemote('127.5.4.1')).toBe('localhost')
  })

  it('classifies IPv6 loopback as localhost', () => {
    expect(classifyRemote('::1')).toBe('localhost')
    expect(classifyRemote('0:0:0:0:0:0:0:1')).toBe('localhost')
  })

  it('unwraps IPv4-mapped IPv6', () => {
    expect(classifyRemote('::ffff:127.0.0.1')).toBe('localhost')
    expect(classifyRemote('::ffff:10.0.0.5')).toBe('lan')
    expect(classifyRemote('::ffff:8.8.8.8')).toBe('public')
    expect(classifyRemote('::FFFF:192.168.1.1')).toBe('lan')
  })

  it('treats unix socket paths as localhost', () => {
    expect(classifyRemote('/tmp/adf.sock')).toBe('localhost')
  })

  it('classifies RFC1918 as lan', () => {
    expect(classifyRemote('10.0.0.1')).toBe('lan')
    expect(classifyRemote('10.255.255.255')).toBe('lan')
    expect(classifyRemote('172.16.0.1')).toBe('lan')
    expect(classifyRemote('172.31.255.255')).toBe('lan')
    expect(classifyRemote('172.15.0.1')).toBe('public') // just outside 172.16/12
    expect(classifyRemote('172.32.0.1')).toBe('public')
    expect(classifyRemote('192.168.1.1')).toBe('lan')
    expect(classifyRemote('192.168.255.255')).toBe('lan')
  })

  it('classifies IPv4 link-local 169.254/16 as lan', () => {
    expect(classifyRemote('169.254.1.1')).toBe('lan')
  })

  it('classifies IPv6 link-local fe80::/10 as lan', () => {
    expect(classifyRemote('fe80::1')).toBe('lan')
    expect(classifyRemote('FE80::1')).toBe('lan')
  })

  it('strips IPv6 zone identifiers', () => {
    expect(classifyRemote('fe80::1%eth0')).toBe('lan')
  })

  it('classifies ULA fc00::/7 as lan', () => {
    expect(classifyRemote('fc00::1')).toBe('lan')
    expect(classifyRemote('fd12:3456::1')).toBe('lan')
  })

  it('classifies public IPv4 as public', () => {
    expect(classifyRemote('8.8.8.8')).toBe('public')
    expect(classifyRemote('1.1.1.1')).toBe('public')
    expect(classifyRemote('93.184.216.34')).toBe('public')
  })

  it('classifies malformed hosts as public (safe default)', () => {
    expect(classifyRemote('not.an.address')).toBe('public')
    expect(classifyRemote('garbage')).toBe('public')
  })
})

describe('ancestorScope', () => {
  const root = sep + 'work'
  const subDir = sep + 'work' + sep + 'clients' + sep + 'acme'

  it('returns localhost when senderAdf is null (untracked/foreground)', () => {
    expect(ancestorScope(null, root + sep + 'x.adf')).toBe('localhost')
    expect(ancestorScope(undefined, root + sep + 'x.adf')).toBe('localhost')
  })

  it('returns directory for self-send (same path)', () => {
    const p = root + sep + 'a.adf'
    expect(ancestorScope(p, p)).toBe('directory')
  })

  it('returns directory for siblings in same directory', () => {
    expect(ancestorScope(root + sep + 'a.adf', root + sep + 'b.adf')).toBe('directory')
  })

  it('returns directory when sender is in an ancestor directory', () => {
    expect(ancestorScope(root + sep + 'assistant.adf', subDir + sep + 'broker.adf')).toBe('directory')
  })

  it('returns localhost when sender is in a descendant directory (not an ancestor)', () => {
    expect(ancestorScope(subDir + sep + 'broker.adf', root + sep + 'assistant.adf')).toBe('localhost')
  })

  it('returns localhost for unrelated paths', () => {
    expect(ancestorScope(sep + 'personal' + sep + 'x.adf', sep + 'work' + sep + 'y.adf')).toBe('localhost')
  })

  it('does not confuse prefix-similar but distinct directories', () => {
    expect(ancestorScope(sep + 'work' + sep + 'a.adf', sep + 'work2' + sep + 'b.adf')).toBe('localhost')
  })
})

describe('permits', () => {
  it('denies every scope for off-tier agents', () => {
    for (const scope of ['directory', 'localhost', 'lan', 'public'] as const) {
      expect(permits('off', scope)).toBe(false)
    }
  })

  it('directory-tier only accepts directory scope', () => {
    expect(permits('directory', 'directory')).toBe(true)
    expect(permits('directory', 'localhost')).toBe(false)
    expect(permits('directory', 'lan')).toBe(false)
    expect(permits('directory', 'public')).toBe(false)
  })

  it('localhost-tier accepts directory and localhost', () => {
    expect(permits('localhost', 'directory')).toBe(true)
    expect(permits('localhost', 'localhost')).toBe(true)
    expect(permits('localhost', 'lan')).toBe(false)
    expect(permits('localhost', 'public')).toBe(false)
  })

  it('lan-tier accepts directory, localhost, lan but not public', () => {
    expect(permits('lan', 'directory')).toBe(true)
    expect(permits('lan', 'localhost')).toBe(true)
    expect(permits('lan', 'lan')).toBe(true)
    expect(permits('lan', 'public')).toBe(false)
  })
})

describe('denialReason', () => {
  it('returns the off-specific reason for off-tier', () => {
    expect(denialReason('off')).toBe('agent not accepting messages')
  })

  it('returns the tier mismatch reason for every other tier', () => {
    expect(denialReason('directory')).toBe('visibility tier mismatch')
    expect(denialReason('localhost')).toBe('visibility tier mismatch')
    expect(denialReason('lan')).toBe('visibility tier mismatch')
  })
})
