import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import { DEFAULT_TOOL_PROMPTS } from '../../../src/shared/constants/adf-defaults'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

/**
 * `bare_prompt` is an escape hatch, so the only assertion worth making is on
 * the bytes the PROVIDER received — not on any intermediate. Every case below
 * reads `opts.system` (and `opts.dynamicInstructions`) off a recording
 * provider for that reason.
 */
class RecordingProvider implements LLMProvider {
  readonly name = 'recording-provider'
  readonly modelId = 'recording-model-v1'
  readonly systems: string[] = []
  readonly dynamics: (string | undefined)[] = []
  readonly toolCounts: number[] = []

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.systems.push(opts.system)
    this.dynamics.push(opts.dynamicInstructions)
    this.toolCounts.push(opts.tools?.length ?? 0)
    return {
      id: `reply-${this.systems.length}`,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

function chatDispatch(text: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: {
        message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() },
      },
    }),
    { scope: 'agent' },
  )
}

function makeWorkspace(name: string): { filePath: string; workspace: AdfWorkspace } {
  const dir = mkdtempSync(join(tmpdir(), `adf-bare-prompt-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

async function promptFor(
  name: string,
  overrides: Partial<AgentConfig>,
  prepare?: (workspace: AdfWorkspace) => void,
): Promise<RecordingProvider> {
  const { filePath, workspace } = makeWorkspace(name)
  prepare?.(workspace)
  const config = { ...workspace.getAgentConfig(), ...overrides }
  workspace.setAgentConfig(config)
  const provider = new RecordingProvider()
  const agent = await new AgentRuntimeBuilder({
    basePrompt: 'BASE PROMPT MARKER. You are an agent.',
    toolPrompts: {
      _skills: DEFAULT_TOOL_PROMPTS._skills,
      _serving_stub: 'SERVING STUB MARKER',
      _autonomous: 'AUTONOMOUS MARKER',
    },
  }).build({ workspace, filePath, config, provider })
  try {
    await agent.executor.executeTurn(chatDispatch('go'))
  } finally {
    await agent.disposeAsync()
  }
  return provider
}

describe('bare_prompt', () => {
  beforeEach(() => { clearAllUmbilicalBuses() })

  it('sends the instructions and nothing else', async () => {
    const provider = await promptFor('bare', {
      instructions: 'ONLY MY WORDS.',
      bare_prompt: true,
      autonomous: true,
    })

    // Exactly the instructions — not merely "contains" them. No base prompt,
    // no tool-prompt sections, no identity block, no heading, no autonomous
    // suffix, no `---` separators.
    expect(provider.systems[0]).toBe('ONLY MY WORDS.')
    // Per-turn injections are runtime text on a later hop; they go too.
    expect(provider.dynamics[0]).toBeUndefined()
    // Tool schemas are an API concern and are untouched.
    expect(provider.toolCounts[0]).toBeGreaterThan(0)
  })

  it('still resolves {{path}} placeholders the owner wrote into instructions', async () => {
    // Deliberate: those are the agent's OWN text. Dropping them would make
    // bare mode silently lose content the owner asked for by name.
    const provider = await promptFor(
      'placeholder',
      { instructions: 'Follow this:\n\n{{playbook.md}}', bare_prompt: true },
      (workspace) => { workspace.writeFile('playbook.md', 'STEP ONE.', 'none') },
    )
    expect(provider.systems[0]).toContain('STEP ONE.')
    expect(provider.systems[0]).not.toContain('{{playbook.md}}')
  })

  it('leaves the full prompt intact when the flag is off', async () => {
    const provider = await promptFor('full', {
      instructions: 'ONLY MY WORDS.',
      autonomous: true,
    })
    const system = provider.systems[0]
    expect(system).toContain('BASE PROMPT MARKER')
    expect(system).toContain('SERVING STUB MARKER')
    expect(system).toContain('## Skills')
    expect(system).toContain('## Your Identity')
    expect(system).toContain('## Agent-Specific Instructions')
    expect(system).toContain('AUTONOMOUS MARKER')
  })

  it('drops the base prompt and its sections but keeps identity when only include_base_prompt is off', async () => {
    // The pre-existing flag's meaning must not move: it already skipped
    // assemblePrompt wholesale, which is why bare_prompt is a separate field
    // rather than a redefinition of this one.
    const provider = await promptFor('no-base', {
      instructions: 'ONLY MY WORDS.',
      include_base_prompt: false,
      autonomous: true,
    })
    const system = provider.systems[0]
    expect(system).not.toContain('BASE PROMPT MARKER')
    expect(system).not.toContain('SERVING STUB MARKER')
    expect(system).toContain('## Your Identity')
    expect(system).toContain('AUTONOMOUS MARKER')
  })

  it('keys the prompt cache on the flag, so flipping it takes effect', async () => {
    const { filePath, workspace } = makeWorkspace('cache')
    const config = { ...workspace.getAgentConfig(), instructions: 'ONLY MY WORDS.' }
    workspace.setAgentConfig(config)
    const provider = new RecordingProvider()
    const agent = await new AgentRuntimeBuilder({
      basePrompt: 'BASE PROMPT MARKER.',
      toolPrompts: { _skills: DEFAULT_TOOL_PROMPTS._skills },
    }).build({ workspace, filePath, config, provider })

    try {
      await agent.executor.executeTurn(chatDispatch('one'))
      expect(provider.systems[0]).toContain('BASE PROMPT MARKER')

      agent.executor.updateConfig({ ...config, bare_prompt: true })
      await agent.executor.executeTurn(chatDispatch('two'))
      expect(provider.systems[1]).toBe('ONLY MY WORDS.')

      agent.executor.updateConfig({ ...config, bare_prompt: undefined })
      await agent.executor.executeTurn(chatDispatch('three'))
      expect(provider.systems[2]).toContain('BASE PROMPT MARKER')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('skips a section whose configured text has been blanked', async () => {
    const { filePath, workspace } = makeWorkspace('blank')
    const config = workspace.getAgentConfig()
    const provider = new RecordingProvider()
    const agent = await new AgentRuntimeBuilder({
      basePrompt: 'BASE PROMPT MARKER.',
      // Blanking a section in Settings must remove it cleanly rather than
      // leaving an empty block between two `---` separators.
      toolPrompts: { _skills: '   \n  ', _serving_stub: 'SERVING STUB MARKER' },
    }).build({ workspace, filePath, config, provider })

    try {
      await agent.executor.executeTurn(chatDispatch('go'))
      const system = provider.systems[0]
      expect(system).toContain('SERVING STUB MARKER')
      expect(system).not.toMatch(/---\s*\n\s*\n\s*---/)
    } finally {
      await agent.disposeAsync()
    }
  })
})
