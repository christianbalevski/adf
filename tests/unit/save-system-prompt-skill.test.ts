import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../src/main/runtime/agent-runtime-builder'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../src/main/runtime/code-sandbox'
import { createHeadlessAgent } from '../../src/main/runtime/headless'
import { DbQueryTool } from '../../src/main/tools/built-in/db-query.tool'
import { FsReadTool } from '../../src/main/tools/built-in/fs-read.tool'
import { FsWriteTool } from '../../src/main/tools/built-in/fs-write.tool'
import { SysGetConfigTool } from '../../src/main/tools/built-in/sys-get-config.tool'
import { SysUpdateConfigTool } from '../../src/main/tools/built-in/sys-update-config.tool'
import { createDispatch, createEvent } from '../../src/shared/types/adf-event.types'
import { DEFAULT_BASE_PROMPT, DEFAULT_TOOL_PROMPTS } from '../../src/shared/constants/adf-defaults'
import type { CreateMessageOptions, LLMProvider } from '../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../src/shared/types/provider.types'

/**
 * Runs skills/save-system-prompt against a real agent: one real turn records
 * the system prompt in adf_loop, then the lambda runs in the real sandbox with
 * the real tools over the same workspace. A second turn proves the applied
 * copy renders the same runtime prompt.
 */

const SEP = '\n\n---\n\n'
const PREFIX = '[Context: system_prompt] '
const source = readFileSync(resolve(import.meta.dirname, '../../skills/save-system-prompt/scripts/save-system-prompt.js'), 'utf8')

class TextProvider implements LLMProvider {
  readonly name = 'save-prompt-provider'
  readonly modelId = 'save-prompt-model'
  readonly calls: CreateMessageOptions[] = []
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push(options)
    return { id: `r${this.calls.length}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig(): Promise<{ valid: boolean }> { return { valid: true } }
}

const sandbox = new CodeSandboxService()
afterAll(() => sandbox.destroyAll?.())
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function startAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-save-prompt-'))
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new TextProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const config = workspace.getAgentConfig()
  config.instructions = 'Be terse.'
  config.recovery = { ...(config.recovery ?? {}), auto_retry: false }
  workspace.setAgentConfig(config)
  const provider = new TextProvider()
  // The shipped defaults: the base prompt embeds {{soul.md}} and {{mind.md}},
  // and the skills section embeds {{skills-registry.json}}.
  const agent = await new AgentRuntimeBuilder({ basePrompt: DEFAULT_BASE_PROMPT, toolPrompts: DEFAULT_TOOL_PROMPTS }).build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  cleanup.push(async () => {
    try { await agent.disposeAsync() } catch { /* cleanup */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* cleanup */ }
  })
  return { workspace, agent, provider }
}

async function turn(agent: Awaited<ReturnType<typeof startAgent>>['agent']) {
  await agent.dispatch(createDispatch(createEvent({
    type: 'chat',
    source: 'save-prompt-test',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'hi' }], created_at: Date.now() } },
  }), { scope: 'agent' }))
}

function lambda(workspace: AdfWorkspace) {
  const tools = {
    db_query: new DbQueryTool(), fs_read: new FsReadTool(), fs_write: new FsWriteTool(),
    sys_get_config: new SysGetConfigTool(), sys_update_config: new SysUpdateConfigTool(),
  }
  const onAdfCall = async (method: string, args: unknown): Promise<AdfCallResult> => {
    const tool = tools[method as keyof typeof tools]
    if (!tool) return { error: `tool ${method} not available`, errorCode: 'TOOL_ERROR' }
    const result = await tool.execute(args, workspace)
    return result.isError ? { error: String(result.content), errorCode: 'TOOL_ERROR' } : { result: String(result.content) }
  }
  return async (fn: string, args: Record<string, unknown> = {}) => {
    const code = `${source}\nreturn await ${fn}(${JSON.stringify(args)});`
    const out = await sandbox.execute(`save-prompt-test:${Math.random()}`, code, 10_000, onAdfCall)
    if (out.error) throw new Error(out.error)
    return (typeof out.result === 'string' ? JSON.parse(out.result) : out.result) as Record<string, unknown>
  }
}

async function recordedPrompts(workspace: AdfWorkspace): Promise<string[]> {
  const result = await new DbQueryTool().execute({ sql: "SELECT content_json FROM adf_loop WHERE loop = 'main' ORDER BY seq" }, workspace)
  const rows = JSON.parse(String(result.content)) as Array<{ content_json: string }>
  return rows.flatMap((row) => {
    const blocks = JSON.parse(row.content_json) as Array<{ type: string; text?: string }>
    return blocks.filter(b => b.type === 'text' && b.text?.startsWith(PREFIX)).map(b => b.text!.slice(PREFIX.length))
  })
}

describe('save-system-prompt skill', () => {
  it('saves the runtime part with placeholders restored, applies it as an equivalent prompt, and reverts', async () => {
    const { workspace, agent } = await startAgent()
    await turn(agent)
    const run = lambda(workspace)

    const saved = await run('save')
    expect(saved).toMatchObject({ ok: true })
    const text = workspace.readFile('prompts/runtime.md')!
    expect(text).toContain('{{mind.md}}')
    expect(text).toContain('{{soul.md}}')
    expect(text).not.toContain('<injected_file')
    expect(text).not.toContain('Be terse.')
    expect(text).not.toContain('Your name is')

    const applied = await run('apply')
    expect(applied).toMatchObject({ ok: true, changed: true })
    expect(applied.owner_action).toMatch(/No base prompt/)
    const config = workspace.getAgentConfig()
    expect(config.instructions).toBe(text + SEP + 'Be terse.')
    expect(config.include_base_prompt).not.toBe(false)
    expect(await run('apply')).toMatchObject({ ok: true, changed: false })

    // The owner switches the mode; the next turn's prompt carries the same runtime text.
    const before = (await recordedPrompts(workspace)).at(-1)!
    await new SysUpdateConfigTool().execute({ path: 'include_base_prompt', value: false }, workspace)
    // The host fans a config change out to the running executor; this harness
    // calls the tools on the workspace directly, so do that step here.
    agent.executor.updateConfig(workspace.getAgentConfig())
    await turn(agent)
    const after = (await recordedPrompts(workspace)).at(-1)!
    const runtimeBefore = before.slice(0, before.indexOf(SEP + '## Agent-Specific Instructions'))
    expect(after.slice(0, after.indexOf(SEP + '## Your Identity'))).toBe('## Agent-Specific Instructions\n\n' + runtimeBefore + SEP + 'Be terse.')
    expect(after.slice(after.indexOf(SEP + '## Your Identity'))).toBe(before.slice(before.indexOf(SEP + '## Your Identity')))

    const reverted = await run('revert')
    expect(reverted.ok).toBe(true)
    expect(reverted.owner_action).toMatch(/Full/)
    expect(workspace.getAgentConfig().instructions).toBe('Be terse.')
  }, 30_000)

  it('reports a missing record instead of writing an empty file', async () => {
    const { workspace } = await startAgent()
    const out = await lambda(workspace)('save')
    expect(out).toMatchObject({ ok: false, reason: 'no_recorded_prompt' })
    expect(workspace.readFile('prompts/runtime.md')).toBeNull()
  }, 30_000)
})
