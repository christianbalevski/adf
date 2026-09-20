import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { SysFetchTool } from '../../../src/main/tools/built-in/sys-fetch.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

/**
 * sys_fetch used to `await response.arrayBuffer()` and apply the 25 MB cap
 * afterwards, so an oversized response was fully materialized in the main
 * process first. The body is now streamed and the connection cancelled once
 * the cap is passed.
 */

const MAX_BODY_BYTES = 25 * 1024 * 1024

function mockWorkspace(): AdfWorkspace {
  return { insertLog: () => {} } as unknown as AdfWorkspace
}

const servers: Server[] = []
afterAll(() => { for (const s of servers) s.close() })

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

describe('sys_fetch body streaming', () => {
  it('stops reading and cancels once the cap is exceeded', async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, 'a')
    const HARD_STOP = 60 * 1024 * 1024 // safety net if the cap were ignored
    let written = 0
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const pump = (): void => {
        while (written < HARD_STOP) {
          written += CHUNK.length
          if (!res.write(CHUNK)) { res.once('drain', pump); return }
        }
        res.end()
      }
      pump()
    })
    const port = await listen(server)

    const r = await new SysFetchTool().execute(
      { url: `http://127.0.0.1:${port}/`, method: 'GET', timeout_ms: 30000 },
      mockWorkspace()
    )

    expect(r.isError).toBe(false)
    const payload = JSON.parse(r.content) as { body: string }
    expect(payload.body).toContain('[truncated: response was')
    expect(payload.body).toContain(`showing first ${MAX_BODY_BYTES}]`)
    // Exactly the cap, plus the notice — not the whole stream.
    expect(payload.body.length).toBeGreaterThan(MAX_BODY_BYTES)
    expect(payload.body.length).toBeLessThan(MAX_BODY_BYTES + 200)
    // The server never got to push its full 60 MB: the read stopped early.
    expect(written).toBeLessThan(HARD_STOP)
  }, 60000)

  it('returns a small body untouched', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const port = await listen(server)

    const r = await new SysFetchTool().execute(
      { url: `http://127.0.0.1:${port}/`, method: 'GET', timeout_ms: 5000 },
      mockWorkspace()
    )
    expect(r.isError).toBe(false)
    expect(JSON.parse(JSON.parse(r.content).body)).toEqual({ ok: true })
  })

  it('base64-encodes a binary body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 253, 254, 255]))
    })
    const port = await listen(server)

    const r = await new SysFetchTool().execute(
      { url: `http://127.0.0.1:${port}/`, method: 'GET', timeout_ms: 5000 },
      mockWorkspace()
    )
    const payload = JSON.parse(r.content) as { body: string; _body_encoding?: string }
    expect(payload._body_encoding).toBe('base64')
    expect([...Buffer.from(payload.body, 'base64')]).toEqual([0, 1, 2, 253, 254, 255])
  })

  it('leaves a HEAD response with an empty body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '11' })
      res.end()
    })
    const port = await listen(server)

    const r = await new SysFetchTool().execute(
      { url: `http://127.0.0.1:${port}/`, method: 'HEAD', timeout_ms: 5000 },
      mockWorkspace()
    )
    expect(JSON.parse(r.content).body).toBe('')
  })
})
