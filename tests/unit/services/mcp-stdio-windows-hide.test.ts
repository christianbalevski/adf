// The SDK's StdioClientTransport sets windowsHide only inside Electron's main
// process. The daemon and the CLI run as Node, so on Windows every host stdio
// MCP server opened a visible console window. The manager's transport must
// spawn hidden whatever the host process is. The server is a node process
// that never answers the handshake; the connect is cancelled once it started.
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'

// cross-spawn calls the CommonJS module object's spawn at call time.
const cp = createRequire(__filename)('node:child_process') as typeof import('node:child_process')

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('McpClientManager stdio transport on Windows', () => {
  it('spawns the server with windowsHide outside Electron main too', async () => {
    expect('type' in process, 'this test runs outside Electron main, where the SDK sets no windowsHide').toBe(false)
    const spawn = vi.spyOn(cp, 'spawn')
    const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-hide-'))
    dirs.push(dir)
    const pidFile = join(dir, 'pid')
    const manager = new McpClientManager()
    const controller = new AbortController()
    const connecting = manager.connect({
      name: 'silent', transport: 'stdio', command: 'node',
      args: ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile],
    }, { signal: controller.signal })
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await sleep(50)
    controller.abort()
    expect(await connecting).toBeNull()
    await manager.disconnectAll()
    const call = spawn.mock.calls.find(([, args]) => (args ?? []).includes(pidFile))
    expect(call, 'the server spawn').toBeDefined()
    expect(call![2]).toMatchObject({ windowsHide: true })
  }, 30_000)

  it('leaves cross-spawn itself unwrapped for its other users', () => {
    const sdkStdio = join(dirname(createRequire(__filename).resolve('@modelcontextprotocol/sdk/client')), 'stdio.js')
    const crossSpawn = createRequire(sdkStdio)('cross-spawn') as { name: string; sync: unknown }
    expect(crossSpawn.name).toBe('spawn')
    expect(typeof crossSpawn.sync).toBe('function')
  })
})
