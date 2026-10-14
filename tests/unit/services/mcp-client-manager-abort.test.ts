// McpConnectOptions.signal (W3-C, the W1-D cancel follow-up): a cancelled
// connect closes the server it was still starting at once, instead of when
// its connect times out, and nothing retries it. The server is a node
// process that writes its pid and never answers the MCP handshake (no
// network, no npx).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function silentServer(): { args: string[]; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-abort-'))
  dirs.push(dir)
  const pidFile = join(dir, 'pid')
  return { pidFile, args: ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile] }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('McpClientManager connect with a signal', () => {
  it('abort while the server starts: connect answers null at once and the server process is gone', async () => {
    const manager = new McpClientManager()
    const controller = new AbortController()
    const server = silentServer()
    const started = Date.now()
    const connecting = manager.connect({ name: 'silent', transport: 'stdio', command: 'node', args: server.args }, { signal: controller.signal })
    for (let i = 0; i < 200 && !existsSync(server.pidFile); i++) await sleep(50)
    const pid = Number(readFileSync(server.pidFile, 'utf-8'))
    expect(isAlive(pid)).toBe(true)
    controller.abort()
    expect(await connecting).toBeNull()
    // Well before the 30 s connect timeout.
    expect(Date.now() - started).toBeLessThan(15_000)
    for (let i = 0; i < 100 && isAlive(pid); i++) await sleep(50)
    expect(isAlive(pid)).toBe(false)
    const messages = manager.getServerState('silent')?.logs.map((l) => l.message) ?? []
    expect(messages).toContain('Connect cancelled — closing the server it started')
    // No inline retry and no background retry after the cancel.
    expect(messages.some((m) => /Retrying/.test(m))).toBe(false)
    await manager.disconnectAll()
  }, 30_000)

  it('an already aborted signal starts nothing', async () => {
    const manager = new McpClientManager()
    const controller = new AbortController()
    controller.abort()
    const server = silentServer()
    expect(await manager.connect({ name: 'silent', transport: 'stdio', command: 'node', args: server.args }, { signal: controller.signal })).toBeNull()
    expect(manager.getServerState('silent')).toBeNull()
    await sleep(300)
    expect(existsSync(server.pidFile)).toBe(false)
  })
})
