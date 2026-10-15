// closeConnection (disconnect, restart, agent stop) of a connected stdio
// server. E3: a server started through a cmd.exe shim (npx, uvx on Windows)
// that ignores stdin EOF was orphaned: the SDK's close killed only the shim,
// and the tree sweep after close reached only the dead shim. Now it gets the
// EOF grace, then its tree is killed while the shim still links it.
// The servers are node scripts speaking just enough MCP to connect (no
// network, no npx).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'

const dirs: string[] = []
const pids: number[] = []
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid) } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A minimal MCP stdio server: `ignore` keeps running after stdin EOF; `exit` writes `eof` and exits on it. */
const SERVER = `
const fs = require('fs')
const [pidFile, onEof] = process.argv.slice(2)
fs.writeFileSync(pidFile, String(process.pid))
let buf = ''
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })
    else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
    else send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
process.stdin.on('end', () => {
  if (onEof === 'exit') { fs.writeFileSync(pidFile + '.eof', 'graceful'); process.exit(0) }
})
setInterval(() => {}, 1000)
`

function fakeServer(onEof: 'ignore' | 'exit'): { script: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-close-'))
  dirs.push(dir)
  const script = join(dir, 'server.js')
  writeFileSync(script, SERVER)
  return { script, pidFile: join(dir, `pid-${onEof}`) }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function connected(manager: McpClientManager, name: string, command: string, args: string[], pidFile: string): Promise<number> {
  const tools = await manager.connect({ name, transport: 'stdio', command, args })
  expect(tools).toEqual([])
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50)
  const pid = Number(readFileSync(pidFile, 'utf-8'))
  pids.push(pid)
  expect(isAlive(pid)).toBe(true)
  return pid
}

describe('McpClientManager closeConnection', () => {
  it('a server that exits on stdin EOF gets its graceful exit', async () => {
    const manager = new McpClientManager()
    const server = fakeServer('exit')
    const pid = await connected(manager, 'graceful', process.execPath, [server.script, server.pidFile, 'exit'], server.pidFile)
    await manager.disconnect('graceful')
    for (let i = 0; i < 100 && isAlive(pid); i++) await sleep(50)
    expect(isAlive(pid)).toBe(false)
    expect(existsSync(`${server.pidFile}.eof`)).toBe(true)
  }, 30_000)

  it.runIf(process.platform === 'win32')('a server behind a cmd.exe shim that ignores stdin EOF is stopped with its tree', async () => {
    const manager = new McpClientManager()
    const server = fakeServer('ignore')
    const pid = await connected(manager, 'shim', 'cmd.exe', ['/d', '/c', 'node', server.script, server.pidFile, 'ignore'], server.pidFile)
    const messages: string[] = []
    manager.on('log', (_name, entry) => { messages.push(entry.message) })
    await manager.disconnect('shim')
    for (let i = 0; i < 60 && isAlive(pid); i++) await sleep(50)
    expect(isAlive(pid), 'the node grandchild of the cmd.exe shim survived the disconnect').toBe(false)
    expect(messages.some((m) => /did not exit 2s after its input closed/.test(m))).toBe(true)
  }, 30_000)

  it.runIf(process.platform === 'win32')('a server behind a cmd.exe shim that exits on stdin EOF exits gracefully', async () => {
    const manager = new McpClientManager()
    const server = fakeServer('exit')
    const pid = await connected(manager, 'shim-graceful', 'cmd.exe', ['/d', '/c', 'node', server.script, server.pidFile, 'exit'], server.pidFile)
    await manager.disconnect('shim-graceful')
    for (let i = 0; i < 60 && isAlive(pid); i++) await sleep(50)
    expect(isAlive(pid)).toBe(false)
    expect(existsSync(`${server.pidFile}.eof`)).toBe(true)
  }, 30_000)
})
