/**
 * limits.execution_timeout_ms is the one limit for code execution: the sandbox
 * has no ceiling of its own, and sys_code / sys_lambda read the limit live, so
 * a limit raised with sys_update_config applies without a restart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const fn of cleanup.splice(0)) { try { fn() } catch { /* best effort */ } }
})

describe('execution_timeout_ms is the one code-execution limit', () => {
  it('the sandbox honors a timeout above 300s instead of clamping it', async () => {
    const sandbox = new CodeSandboxService()
    cleanup.push(() => sandbox.destroyAll())
    const delays: number[] = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number') delays.push(ms)
      return real(fn, ms, ...rest)
    }) as typeof setTimeout)

    const result = await sandbox.execute('timeout-limit-agent', 'return 1', 7_200_000)
    expect(result.error).toBeUndefined()
    // Worker guard = effective timeout + 2s RPC buffer.
    expect(delays).toContain(7_202_000)
    expect(delays).not.toContain(302_000)
  })

  it('sys_code / sys_lambda schemas follow a limit raised after the agent started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-exec-limit-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const filePath = join(dir, 'agent-1.adf')
    createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const config = workspace.getAgentConfig()
    config.limits = { ...config.limits, execution_timeout_ms: 600_000 }
    for (const name of ['sys_code', 'sys_lambda']) {
      if (!config.tools.some(t => t.name === name)) config.tools.push({ name, enabled: true, visible: true } as never)
    }
    workspace.setAgentConfig(config)

    const sandbox = new CodeSandboxService()
    cleanup.push(() => sandbox.destroyAll())
    const agent = await new AgentRuntimeBuilder({ codeSandboxService: sandbox })
      .build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    cleanup.push(() => { void agent.disposeAsync() })

    const sysCode = agent.registry.get('sys_code')!
    const sysLambda = agent.registry.get('sys_lambda')!
    expect(sysCode.inputSchema.safeParse({ code: '1', timeout: 7_200_000 }).success).toBe(false)

    // What sys_update_config does with { limits: { execution_timeout_ms } }.
    const next = workspace.getAgentConfig()
    next.limits = { ...next.limits, execution_timeout_ms: 7_200_000 }
    workspace.setAgentConfig(next)

    expect(sysCode.inputSchema.safeParse({ code: '1', timeout: 7_200_000 }).success).toBe(true)
    expect(sysLambda.inputSchema.safeParse({ source: 'a.js', timeout: 7_200_000 }).success).toBe(true)
    expect(JSON.stringify(sysLambda.toProviderFormat().input_schema)).toContain('7200000')
    expect(JSON.stringify(sysLambda.toProviderFormat().input_schema)).not.toContain('600000')
  })
})
