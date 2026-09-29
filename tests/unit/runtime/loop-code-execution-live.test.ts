/**
 * A side loop never holds a code-execution capability the agent lacks, and an
 * owner revocation on the agent reaches a LIVE loop through the pool's
 * config-change reconcile — not just the next derive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { LoopPool } from '../../../src/main/runtime/loop-pool'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'

const provider: LLMProvider = {
  name: 'stub',
  providerId: 'stub',
  modelId: 'stub-model',
  createMessage: async () => ({
    id: 'reply',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  validateConfig: async () => ({ valid: true }),
}

let rootDir: string
let ws: AdfWorkspace
let pool: LoopPool
let live: AgentConfig

function setHost(mutate: (config: AgentConfig) => void): void {
  const next = JSON.parse(JSON.stringify(live)) as AgentConfig
  mutate(next)
  ws.setAgentConfig(next)
  live = next
  pool.reconcile(next)
}

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-loop-ce-'))
  ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'agent-1' })
  live = ws.getAgentConfig()
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const handler = new AdfCallHandler({ toolRegistry: registry, workspace: ws, config: live, provider })
  pool = new LoopPool({
    workspace: ws,
    registry,
    getProvider: () => provider,
    basePrompt: '',
    toolPrompts: {},
    adfCallHandler: handler,
    codeSandboxService: null,
    mcpManager: null,
    getHostConfig: () => live,
    saveConfig: (next) => {
      ws.setAgentConfig(next)
      live = next
      pool.reconcile(next)
    },
    onLoopEvent: () => {},
    main: {
      session: new AgentSession(ws),
      isBusy: () => false,
      dispatch: async () => {},
      getState: () => 'idle',
    },
  })
  await pool.createLoop({ name: 'reflector', goal: 'reflect', enabled: true, tools: [] })
})

afterEach(() => {
  try { pool.dispose() } catch { /* already disposed */ }
  try { ws.close() } catch { /* already closed */ }
  clearAllUmbilicalBuses()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('side-loop code_execution follows the agent live', () => {
  it('agent revokes model_invoke → the running loop loses it; re-enable restores it', async () => {
    const runtime = () => pool.getRuntime('reflector')!
    expect(runtime().executor.getConfig().code_execution?.model_invoke).toBe(true)
    const allowed = await runtime().callHandler!.handleCall('model_invoke', { prompt: 'hi' })
    expect(allowed.errorCode).not.toBe('DISABLED')

    setHost(c => { c.code_execution = { ...c.code_execution!, model_invoke: false } })

    expect(runtime().derived.code_execution?.model_invoke).toBe(false)
    expect(runtime().executor.getConfig().code_execution?.model_invoke).toBe(false)
    const denied = await runtime().callHandler!.handleCall('model_invoke', { prompt: 'hi' })
    expect(denied.errorCode).toBe('DISABLED')

    setHost(c => { c.code_execution = { ...c.code_execution!, model_invoke: true, network: true } })
    expect(runtime().derived.code_execution?.model_invoke).toBe(true)
    // The fixed loop profile still applies on top of an agent grant.
    expect(runtime().derived.code_execution?.network).toBe(false)
  })
})
