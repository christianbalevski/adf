import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { SysFetchTool, checkFetchTarget, isBlockedIpAddress, parseLooseIPv4 } from '../../../src/main/tools/built-in/sys-fetch.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { SecurityConfig } from '../../../src/shared/types/adf-v02.types'

function mockWorkspace(): AdfWorkspace {
  return { insertLog: () => {} } as unknown as AdfWorkspace
}

/** Attach only the security-config dep; middleware deps are never reached. */
function withSecurity(
  tool: SysFetchTool,
  security: Partial<SecurityConfig>,
  guardCtx?: { daemonPort?: number; ownOrigin?: { port: number; pathPrefix: string } }
): SysFetchTool {
  tool.setMiddlewareDeps({
    codeSandboxService: undefined as never,
    adfCallHandler: undefined as never,
    agentId: 'test-agent',
    getSecurityConfig: () => security as SecurityConfig,
    ...(guardCtx ? { getFetchGuardContext: () => guardCtx } : {})
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
    it('blocks every literal spelling of the local daemon (daemon port tier)', async () => {
      const opts = { daemonPort: 7385 }
      for (const url of [
        'http://127.0.0.1:7385/agents',
        'http://localhost:7385/agents',
        'http://[::1]:7385/',
        'http://127.1:7385/',
        'http://2130706433:7385/',
        'http://0.0.0.0:7385/'
      ]) {
        expect(await checkFetchTarget(url, opts), url).toMatch(/daemon control API/)
      }
    })

    it('allows loopback by default (non-daemon ports)', async () => {
      const opts = { daemonPort: 7385 }
      for (const url of [
        'http://127.0.0.1:9999/',
        'http://LOCALHOST/',
        'http://api.localhost/',
        'http://[::1]:8080/',
        'http://0x7f000001/',
        'http://2130706433/'
      ]) {
        expect(await checkFetchTarget(url, opts), url).toBeNull()
      }
    })

    it('still blocks the unspecified address by default (not true loopback)', async () => {
      expect(await checkFetchTarget('http://0.0.0.0:9999/')).toMatch(/SSRF guard/)
    })

    it('blocks cloud metadata and private ranges', async () => {
      // Link-local / cloud metadata is an always-block tier with its own message.
      expect(await checkFetchTarget('http://169.254.169.254/latest/meta-data/')).toMatch(/link-local \/ cloud-metadata/)
      expect(await checkFetchTarget('http://192.168.0.10/admin')).toMatch(/SSRF guard/)
      expect(await checkFetchTarget('http://10.0.0.5/')).toMatch(/SSRF guard/)
      // CGNAT (100.64/10) — the range Tailscale addresses live in.
      expect(await checkFetchTarget('http://100.100.1.2/')).toMatch(/SSRF guard/)
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

  describe('tiered guard (opts)', () => {
    const daemon = { allowLocal: true, daemonPort: 7385 }

    it('hard-blocks the daemon control API even with allowLocal', async () => {
      const msg = await checkFetchTarget('http://127.0.0.1:7385/agents', daemon)
      expect(msg).toMatch(/daemon control API/)
      // loose spellings + localhost also hit the daemon block
      expect(await checkFetchTarget('http://localhost:7385/', daemon)).toMatch(/daemon control API/)
      expect(await checkFetchTarget('http://2130706433:7385/', daemon)).toMatch(/daemon control API/)
    })

    it('hard-blocks link-local / cloud metadata even with allowLocal', async () => {
      expect(await checkFetchTarget('http://169.254.169.254/latest/meta-data/', daemon))
        .toMatch(/link-local \/ cloud-metadata/)
      expect(await checkFetchTarget('http://[fe80::1]/', daemon)).toMatch(/link-local \/ cloud-metadata/)
    })

    it('allows the own served origin even when allowLocal is false', async () => {
      const opts = { allowLocal: false, daemonPort: 7385, ownOrigin: { port: 7295, pathPrefix: '/agents/agent-1/' } }
      expect(await checkFetchTarget('http://127.0.0.1:7295/agents/agent-1/inbox', opts)).toBeNull()
    })

    it('allows other loopback origins by default too (loopback is default-open)', async () => {
      const opts = { allowLocal: false, daemonPort: 7385, ownOrigin: { port: 7295, pathPrefix: '/agents/agent-1/' } }
      expect(await checkFetchTarget('http://127.0.0.1:7295/agents/other/inbox', opts)).toBeNull()
      expect(await checkFetchTarget('http://127.0.0.1:9999/agents/agent-1/inbox', opts)).toBeNull()
    })

    it('blocks private/LAN addresses when allowLocal is false, allows with true', async () => {
      expect(await checkFetchTarget('http://192.168.1.50/', { allowLocal: false, daemonPort: 7385 })).toMatch(/SSRF guard/)
      expect(await checkFetchTarget('http://192.168.1.50/', { allowLocal: true, daemonPort: 7385 })).toBeNull()
    })
  })

  describe('tool behaviour', () => {
    it('refuses the daemon control API even with no guard context wired (built-in default port)', async () => {
      // No setMiddlewareDeps at all — the tool must still supply daemonPort
      // itself, because loopback is default-open.
      const result = await new SysFetchTool().execute(
        { url: 'http://127.0.0.1:7385/agents', method: 'GET', timeout_ms: 5000 },
        mockWorkspace()
      )
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content).error).toMatch(/daemon control API/)
    })

    it('refuses a private-network fetch by default', async () => {
      const result = await new SysFetchTool().execute(
        { url: 'http://192.168.255.253:9/', method: 'GET', timeout_ms: 5000 },
        mockWorkspace()
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('security.allow_local_fetch')
    })

    it('permits a loopback fetch by default (no security config)', async () => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      const result = await new SysFetchTool().execute(
        { url: `http://127.0.0.1:${port}/`, method: 'GET', timeout_ms: 5000 },
        mockWorkspace()
      )
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content).body).toBe('{"ok":true}')
    })

    it('blocks a redirect to the daemon port even under allowLocal', async () => {
      // A "real" daemon port we never actually reach — just its number.
      const daemonSrv = createServer((_req, res) => { res.writeHead(200); res.end('daemon') })
      servers.push(daemonSrv)
      await new Promise<void>((resolve) => daemonSrv.listen(0, '127.0.0.1', resolve))
      const daemonPort = (daemonSrv.address() as { port: number }).port

      // A loopback origin that 302s to the daemon port.
      const redirector = createServer((_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${daemonPort}/agents` })
        res.end()
      })
      servers.push(redirector)
      await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
      const port = (redirector.address() as { port: number }).port

      const tool = withSecurity(new SysFetchTool(), { allow_local_fetch: true }, { daemonPort })
      const result = await tool.execute(
        { url: `http://127.0.0.1:${port}/`, method: 'GET', timeout_ms: 5000 },
        mockWorkspace()
      )
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content).error).toMatch(/daemon control API/)
    })
  })
})
