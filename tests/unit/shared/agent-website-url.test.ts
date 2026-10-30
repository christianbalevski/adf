import { describe, expect, it } from 'vitest'
import { agentWebsiteUrl, meshWebsiteUrl, resolveRelativeWebsiteLink } from '../../../src/shared/utils/agent-website-url'

describe('agent website URLs viewed from another runtime', () => {
  it.each(['localhost', '127.0.0.1', '127.0.0.2', '0.0.0.0', '[::1]', '[::]'])('reaches %s through the connected host and keeps the website port and suffix', (host) => {
    expect(agentWebsiteUrl(`http://${host}:7295/agents/my-agent/page?q=1#details`, 'https://server.example:7386/control'))
      .toBe('http://server.example:7295/agents/my-agent/page?q=1#details')
  })

  it.each([
    'https://custom.example/agents/my-agent/',
    'http://192.168.1.5:9000/agents/my-agent/',
    'http://localhost:3000/custom-site',
    'http://localhost:7295/agents-custom/',
    'ftp://localhost/agents/my-agent/',
    'http://user:password@localhost:7295/agents/my-agent/',
    'not a URL',
  ])('preserves custom or noncanonical links verbatim: %s', (url) => {
    expect(agentWebsiteUrl(url, 'https://server.example:7386')).toBe(url)
  })

  it('keeps local links and tolerates missing or invalid connection URLs', () => {
    const url = 'http://localhost:7295/agents/my-agent/'
    for (const runtime of [undefined, null, '', 'bad', 'file:///tmp/runtime']) {
      expect(agentWebsiteUrl(url, runtime)).toBe(url)
    }
  })

  it('uses the selected runtime, including IPv6, without copying connection credentials or control paths', () => {
    const server = { host: '0.0.0.0', port: 7296 }
    expect(meshWebsiteUrl(server, '/agents/a/', 'https://one.example:7386')).toBe('http://one.example:7296/agents/a/')
    expect(meshWebsiteUrl(server, '/agents/a/', 'https://user:secret@[2001:db8::1]:7386/control')).toBe('http://[2001:db8::1]:7296/agents/a/')
    expect(server.host).toBe('0.0.0.0')
  })

  it('builds valid local wildcard and IPv6 URLs', () => {
    expect(meshWebsiteUrl({ host: '::', port: 7295 }, '/agents')).toBe('http://127.0.0.1:7295/agents')
    expect(meshWebsiteUrl({ host: '::1', port: 7295 }, '/agents/a/')).toBe('http://[::1]:7295/agents/a/')
    expect(meshWebsiteUrl({ host: '2001:db8::2', port: 7295 }, '/agents/a/', 'https://remote.example')).toBe('http://[2001:db8::2]:7295/agents/a/')
  })
})

describe('relative website references', () => {
  it('resolves using the hosting website origin, with query, fragment and encoded paths intact', () => {
    expect(resolveRelativeWebsiteLink('/agents/a/a%20file?q=one&x=2#section', 'https://peer.example:8443/agents/b/card'))
      .toBe('https://peer.example:8443/agents/a/a%20file?q=one&x=2#section')
    expect(resolveRelativeWebsiteLink('/agents/a/', 'http://[2001:db8::1]:7295')).toBe('http://[2001:db8::1]:7295/agents/a/')
  })

  it.each(['/agents/a/../../admin', '/agents/a/%2e%2e/%2e%2e/admin', '/agents/\\evil.example', '/agents/a/\npage'])('rejects invalid paths or namespace escapes: %s', (href) => {
    expect(() => resolveRelativeWebsiteLink(href, 'http://host:7295')).toThrow('invalid')
  })

  it.each(['https://user:secret@host/', 'file:///tmp/'])('rejects unsuitable website bases: %s', (base) => {
    expect(() => resolveRelativeWebsiteLink('/agents/a/', base)).toThrow('unavailable')
  })

  it.each(['http://localhost:7295/agents/a/', 'https://custom.example/agents/a/', '//host/agents/a/', '/agents-other/a', 'adf-file://README.md', '#heading'])('preserves non-relative-site references verbatim: %s', (href) => {
    expect(resolveRelativeWebsiteLink(href, 'invalid base')).toBe(href)
  })
})
