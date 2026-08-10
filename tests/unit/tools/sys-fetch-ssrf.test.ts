import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { SysFetchTool, checkFetchTarget, isBlockedIpAddress, parseLooseIPv4 } from '../../../src/main/tools/built-in/sys-fetch.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { SecurityConfig } from '../../../src/shared/types/adf-v02.types'

function mockWorkspace(): AdfWorkspace {
  return { insertLog: () => {} } as unknown as AdfWorkspace
}

/** Attach only the security-config dep; middleware deps are never reached. */
function withSecurity(tool: SysFetchTool, security: Partial<SecurityConfig>): SysFetchTool {
  tool.setMiddlewareDeps({
    codeSandboxService: undefined as never,
    adfCallHandler: undefined as never,
    agentId: 'test-agent',
    getSecurityConfig: () => security as SecurityConfig
  })
  return tool
}

describe('sys_fetch SSRF guard', () => {
  const servers: Server[] = []
  afterAll(() => { for (const s of servers) s.close() })

  describe('address classification', () => {
    it('parses loose inet_aton IPv4 spellings', () => {
      expect(parseLooseIPv4('127.1')).toBe('127.0.0.1')
      expect(parseLooseIPv4('0x7f000001')).toBe('127.0.0.1')
      expect(parseLooseIPv4('2130706433')).toBe('127.0.0.1')
      expect(parseLooseIPv4('0177.0.0.1')).toBe('127.0.0.1')
      expect(parseLooseIPv4('example.com')).toBeNull()
    })

    it('classifies loopback, private, link-local and CGNAT as blocked', () => {
      for (const ip of [
        '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
        '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::',
        'fe80::1', 'fc00::1', '::ffff:127.0.0.1'
      ]) {
        expect(isBlockedIpAddress(ip), ip).toBe(true)
      }
    })

    it('leaves public addresses alone', () => {
      for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
        expect(isBlockedIpAddress(ip), ip).toBe(false)
      }
    })
  })

  describe('checkFetchTarget', () => {
    it('blocks every literal spelling of the local daemon', async () => {
      for (const url of [
        'http://127.0.0.1:7385/agents',
        'http://localhost:7385/agents',
        'http://LOCALHOST/',
        'http://api.localhost/',
        'http://[::1]:7385/',
        'http://127.1:7385/',
        'http://0x7f000001/',
        'http://2130706433/',
        'http://0.0.0.0:7385/'
      ]) {
        expect(await checkFetchTarget(url), url).toMatch(/SSRF guard/)
      }
    })

    it('blocks cloud metadata and private ranges', async () => {
      expect(await checkFetchTarget('http://169.254.169.254/latest/meta-data/')).toMatch(/SSRF guard/)
      expect(await checkFetchTarget('http://192.168.0.10/admin')).toMatch(/SSRF guard/)
      expect(await checkFetchTarget('http://10.0.0.5/')).toMatch(/SSRF guard/)
    })

    it('blocks non-http(s) protocols', async () => {
      expect(await checkFetchTarget('file:///etc/passwd')).toMatch(/only http and https/)
      expect(await checkFetchTarget('ftp://example.com/x')).toMatch(/only http and https/)
    })

    it('allows public destinations', async () => {
      expect(await checkFetchTarget('https://93.184.216.34/')).toBeNull()
      expect(await checkFetchTarget('https://[2606:4700:4700::1111]/')).toBeNull()
    })
  })

  describe('tool behaviour', () => {
    it('refuses a loopback fetch by default', async () => {
      const result = await new SysFetchTool().execute(
        { url: 'http://127.0.0.1:7385/agents', method: 'GET', timeout_ms: 5000 },
        mockWorkspace()
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('security.allow_local_fetch')
    })

    it('permits a loopback fetch when security.allow_local_fetch is true', async () => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      const tool = withSecurity(new SysFetchTool(), { allow_local_fetch: true })
      const result = await tool.execute(
        { url: `http://127.0.0.1:${port}/`, method: 'GET', timeout_ms: 5000 },
        mockWorkspace()
      )
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content).body).toBe('{"ok":true}')
    })
  })
})
