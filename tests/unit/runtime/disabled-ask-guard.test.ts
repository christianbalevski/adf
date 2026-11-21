import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { ToolDeclaration } from '../../../src/shared/types/adf-v02.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

/** `ask` is intercepted before the registry; it must still honor the enabled-tool guard. */

class ScriptedProvider implements LLMProvider {
  readonly name = 'ask-guard-provider'
  readonly modelId = 'ask-guard-model'
  readonly calls: CreateMessageOptions[] = []
  constructor(private readonly respond: (call: number) => LLMResponse) {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push(options)
    return this.respond(this.calls.length)
  }
  async validateConfig(): Promise<{ valid: boolean }> { return { valid: true } }
}

const ASK_INPUT = { questions: [{ question: 'Proceed?' }] }

function respond(call: number): LLMResponse {
  return call === 1
    ? { id: 'r1', content: [{ type: 'tool_use', id: 'tu-ask', name: 'ask', input: ASK_INPUT }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
    : { id: 'r2', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function start(tools: ToolDeclaration[]) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-ask-guard-'))
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new ScriptedProvider(respond), createOptions: { tools } }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const config = workspace.getAgentConfig()
  config.tools = tools
  config.recovery = { ...(config.recovery ?? {}), auto_retry: false }
  workspace.setAgentConfig(config)
  const provider = new ScriptedProvider(respond)
  const agent = await new AgentRuntimeBuilder({}).build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  cleanup.push(async () => {
    try { await agent.disposeAsync() } catch { /* cleanup */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* cleanup */ }
  })
  return { agent, provider }
}

describe('ask enabled-tool guard', () => {
  it('refuses a disabled ask without opening a question', async () => {
    const { agent, provider } = await start([{ name: 'ask', enabled: false, visible: false }])
    // Before the fix the ask opened and blocked on an owner answer: dispatch never resolved.
    await agent.dispatch(createDispatch(createEvent({
      type: 'chat',
      source: 'ask-guard-test',
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'hi' }], created_at: Date.now() } },
    }), { scope: 'agent' }))

    expect(provider.calls).toHaveLength(2)
    expect(agent.session.getMessages().some(m =>
      Array.isArray(m.content) && m.content.some(b =>
        b.type === 'tool_result' && b.tool_use_id === 'tu-ask' && b.is_error === true
        && String(b.content).includes('Tool "ask" is not enabled'))
    )).toBe(true)
  }, 10_000)
})
