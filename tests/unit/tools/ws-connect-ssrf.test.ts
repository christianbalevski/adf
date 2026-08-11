import { describe, it, expect } from 'vitest'
import { WsConnectTool } from '../../../src/main/tools/built-in/ws-connect.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { SecurityConfig } from '../../../src/shared/types/adf-v02.types'

function mockWorkspace(): AdfWorkspace {
  return { insertLog: () => {} } as unknown as AdfWorkspace
}

/** connectFn spy: records calls and returns a fixed connection_id. */
function spyConnect() {
  const calls: unknown[] = []
  const fn = async (opts: unknown) => {
    calls.push(opts)
    return { connection_id: 'c1' }
  }
  return { fn, calls }
}

describe('ws_connect SSRF guard', () => {
  it('blocks a loopback ws URL by default (no security config)', async () => {
    const { fn, calls } = spyConnect()
    const tool = new WsConnectTool(fn)
    const result = await tool.execute({ url: 'ws://127.0.0.1:9999/' }, mockWorkspace())
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/SSRF guard/)
    expect(calls.length).toBe(0) // never reached the socket
  })

  it('hard-blocks the daemon control API even with allow_local_fetch', async () => {
    const { fn, calls } = spyConnect()
    const tool = new WsConnectTool(fn, () => ({ allow_local_fetch: true } as SecurityConfig))
    // Default daemonPort is 7385 (process.env.ADF_DAEMON_PORT || 7385).
    const result = await tool.execute({ url: 'ws://127.0.0.1:7385/agents' }, mockWorkspace())
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/daemon control API/)
    expect(calls.length).toBe(0)
  })

  it('permits a non-daemon loopback ws when allow_local_fetch is true', async () => {
    const { fn, calls } = spyConnect()
    const tool = new WsConnectTool(fn, () => ({ allow_local_fetch: true } as SecurityConfig))
    const result = await tool.execute({ url: 'ws://127.0.0.1:9999/' }, mockWorkspace())
    expect(result.isError).toBe(false)
    expect(String(result.content)).toContain('c1')
    expect(calls.length).toBe(1)
  })

  it('allows a public wss URL', async () => {
    const { fn, calls } = spyConnect()
    const tool = new WsConnectTool(fn)
    const result = await tool.execute({ url: 'wss://93.184.216.34:443/' }, mockWorkspace())
    expect(result.isError).toBe(false)
    expect(calls.length).toBe(1)
  })
})
