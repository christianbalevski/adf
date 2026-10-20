/**
 * The turn interrupt reaches the work: compute_exec on the host kills its
 * shell's process tree, an MCP call is cancelled, and a call made from inside
 * another call (adf_shell's `adf compute_exec`) inherits the signal.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ComputeExecTool } from '../../../src/main/tools/built-in/compute-exec.tool'
import { McpTool } from '../../../src/main/tools/mcp-tool'
import { ToolRegistry, currentToolSignal } from '../../../src/main/tools/tool-registry'
import { killAllHostExecs, killHostExecsFor, hostExec, liveHostExecCount } from '../../../src/main/services/host-exec.service'
import type { McpClientManager } from '../../../src/main/services/mcp-client-manager'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

const AGENT_ID = '5d0c2b8e-1f4a-4c3d-9e7b-2a6f8c1d0e01'
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const workDir = mkdtempSync(join(tmpdir(), 'compute-exec-interrupt-'))

vi.mock('../../../src/main/services/host-exec.service', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/services/host-exec.service')>()
  // The agent's host workspace is a temp dir here, never the user-data folder.
  return { ...real, ensureHostWorkspace: () => workDir }
})

afterAll(async () => {
  await killAllHostExecs(3_000)
  rmSync(workDir, { recursive: true, force: true })
})

describe('compute_exec on the host', () => {
  const tool = new ComputeExecTool(null, { hasIsolated: false, hasShared: false, hasHost: true, agentId: AGENT_ID })

  it('an aborted call kills the shell tree and reports interrupted', async () => {
    const marker = join(workDir, 'grandchild.log').replace(/\\/g, '/')
    const controller = new AbortController()
    const run = tool.execute({ command: `(while true; do echo x >> "${marker}"; sleep 0.2; done) & sleep 30`, target: 'host', timeout_ms: 60_000 }, {} as AdfWorkspace, { signal: controller.signal })
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (liveHostExecCount(AGENT_ID) === 1) { clearInterval(t); resolve() } }, 10) })
    await sleep(600)
    const started = Date.now()
    controller.abort()
    const result = JSON.parse((await run).content)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toMatchObject({ target: 'host', exit_code: 130, interrupted: true })
    expect(result.stderr).toContain('turn was interrupted')
    expect(liveHostExecCount(AGENT_ID)).toBe(0)
    // The tree is gone: the background grandchild stops writing.
    await sleep(1_500)
    const size = statSync(marker).size
    await sleep(800)
    expect(statSync(marker).size).toBe(size)
  }, 20_000)

  it('a call whose turn was already interrupted does not start a shell', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = JSON.parse((await tool.execute({ command: 'echo never', target: 'host' }, {} as AdfWorkspace, { signal: controller.signal })).content)
    expect(result).toMatchObject({ exit_code: 130, stdout: '' })
  })

  it('killHostExecsFor reaps only that agent\'s shells', async () => {
    const mine = hostExec(workDir, 'sleep 30', 60_000, { owner: AGENT_ID })
    const theirs = hostExec(workDir, 'sleep 30', 60_000, { owner: 'agent-2-id' })
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (liveHostExecCount() >= 2) { clearInterval(t); resolve() } }, 10) })
    expect(await killHostExecsFor(AGENT_ID)).toBe(1)
    expect((await mine).code).not.toBe(0)
    expect(liveHostExecCount('agent-2-id')).toBe(1)
    await killHostExecsFor('agent-2-id')
    await theirs
  }, 20_000)
})

describe('MCP calls', () => {
  it('pass the turn signal to the client call', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: 'ok', isError: false })
    const tool = new McpTool('srv', { name: 'search', input_schema: { type: 'object' } }, { callTool } as unknown as McpClientManager)
    const controller = new AbortController()
    await tool.execute({ q: 'x', _reason: 'r' }, {} as AdfWorkspace, { signal: controller.signal })
    expect(callTool).toHaveBeenCalledWith('srv', 'search', { q: 'x' }, { signal: controller.signal })
    await tool.execute({ q: 'y' }, {} as AdfWorkspace)
    expect(callTool).toHaveBeenLastCalledWith('srv', 'search', { q: 'y' })
  })
})

describe('the registry', () => {
  it('hands the signal to the tool, and a nested call inherits it', async () => {
    const registry = new ToolRegistry()
    const seen: Array<AbortSignal | undefined> = []
    registry.register({
      name: 'inner', description: 'inner', inputSchema: z.object({}).passthrough(), category: 'system',
      execute: async (_i, _w, ctx) => { seen.push(ctx?.signal); return { content: 'inner', isError: false } },
      toProviderFormat: () => ({ name: 'inner', description: 'inner', input_schema: {} }),
    })
    registry.register({
      name: 'outer', description: 'outer', inputSchema: z.object({}).passthrough(), category: 'system',
      // Like adf_shell's `adf <tool>`: no signal passed explicitly.
      execute: async (_i, ws) => { seen.push(currentToolSignal()); return registry.executeTool('inner', {}, ws) },
      toProviderFormat: () => ({ name: 'outer', description: 'outer', input_schema: {} }),
    })
    const controller = new AbortController()
    await registry.executeTool('outer', {}, {} as AdfWorkspace, { signal: controller.signal })
    expect(seen).toEqual([controller.signal, controller.signal])
    // Outside any call there is no signal.
    expect(currentToolSignal()).toBeUndefined()
    await registry.executeTool('inner', {}, {} as AdfWorkspace)
    expect(seen.at(-1)).toBeUndefined()
  })
})
