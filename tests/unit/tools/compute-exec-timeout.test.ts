/**
 * compute_exec timeouts: one limit (the agent's live limits.execution_timeout_ms,
 * no per-tool ceiling), and a command killed by it is reported as a timeout —
 * never as an ordinary completion with exit code 1.
 */
import { describe, expect, it, vi } from 'vitest'
import { ComputeExecTool } from '../../../src/main/tools/built-in/compute-exec.tool'
import type { PodmanService } from '../../../src/main/services/podman.service'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

const AGENT_ID = '3f1c9a2e-7b4d-4e8a-9c6f-1a2b3c4d5e6f'
const sharedCaps = { hasIsolated: false, hasShared: true, hasHost: false, agentId: AGENT_ID }

function sharedTool(execInContainer: ReturnType<typeof vi.fn>, limit: () => number | undefined) {
  const podman = { ensureWorkspace: vi.fn().mockResolvedValue(undefined), execInContainer } as Partial<PodmanService>
  return new ComputeExecTool(podman as PodmanService, sharedCaps, limit)
}

describe('compute_exec timeout', () => {
  it('reports a container exec killed by its timeout as a timeout, not exit 1', async () => {
    // podman exec0's shape when execFile's own timeout killed the client.
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 1, timedOut: true })
    const result = await sharedTool(exec, () => 600_000).execute({ command: 'sleep 150', timeout_ms: 200_000 }, {} as AdfWorkspace)

    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content)
    expect(body.timed_out).toBe(true)
    expect(body.timeout_ms).toBe(200_000)
    expect(body.exit_code).not.toBe(1)
    expect(body.error).toMatch(/timed out after 200000 ms/)
    expect(body.error).toMatch(/limits\.execution_timeout_ms/)
  })

  it('uses the agent\'s live execution_timeout_ms as the only ceiling (no 120s cap), default stays 30s', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 })
    let limit = 600_000
    const tool = sharedTool(exec, () => limit)

    await tool.execute({ command: 'true', timeout_ms: 300_000 }, {} as AdfWorkspace)
    expect(exec).toHaveBeenLastCalledWith('adf-mcp', `/workspace/${AGENT_ID}`, 'true', 300_000)
    expect(JSON.stringify(tool.toProviderFormat().input_schema)).toContain('600000')

    await tool.execute({ command: 'true' }, {} as AdfWorkspace)
    expect(exec).toHaveBeenLastCalledWith('adf-mcp', `/workspace/${AGENT_ID}`, 'true', 30_000)

    limit = 50_000 // sys_update_config mid-run
    await tool.execute({ command: 'true', timeout_ms: 300_000 }, {} as AdfWorkspace)
    expect(exec).toHaveBeenLastCalledWith('adf-mcp', `/workspace/${AGENT_ID}`, 'true', 50_000)
    expect(JSON.stringify(tool.toProviderFormat().input_schema)).toContain('50000')
  })

  it.skipIf(process.platform === 'win32')('reports a host command killed by its timeout as a timeout', async () => {
    const tool = new ComputeExecTool(null, { hasIsolated: false, hasShared: false, hasHost: true, agentId: AGENT_ID }, () => 60_000)
    const result = await tool.execute({ command: 'sleep 5', target: 'host', timeout_ms: 300 }, {} as AdfWorkspace)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({ timed_out: true, timeout_ms: 300 })
  })
})
