import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import { SKILLS_REGISTRY_PATH } from '../../../src/main/adf/skill-indexer'
import { DEFAULT_TOOL_PROMPTS } from '../../../src/shared/constants/adf-defaults'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

/** Captures the system prompt the model actually received, turn by turn. */
class RecordingProvider implements LLMProvider {
  readonly name = 'recording-provider'
  readonly modelId = 'recording-model-v1'
  readonly systems: string[] = []

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.systems.push(opts.system)
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

function manifest(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`
}

function chatDispatch(text: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text', text }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

function makeWorkspace(name: string): { filePath: string; workspace: AdfWorkspace } {
  const dir = mkdtempSync(join(tmpdir(), `adf-skills-prompt-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

describe('{{skills-registry.json}} across a session reset', () => {
  beforeEach(() => { clearAllUmbilicalBuses() })

  it('snapshots the catalog, holds it mid-session, and refreshes it on reset', async () => {
    const { filePath, workspace } = makeWorkspace('refresh')
    const base = workspace.getAgentConfig()
    const config = { ...base, skills: { enabled: true } }
    workspace.setAgentConfig(config)
    workspace.writeFile('skills/alpha/SKILL.md', manifest('alpha'), 'none')
    workspace.refreshSkillIndex()
    expect(workspace.readFile(SKILLS_REGISTRY_PATH)).toContain('alpha')

    const provider = new RecordingProvider()
    const agent = await new AgentRuntimeBuilder({
      basePrompt: 'You are an agent.',
      // Exactly the shape that matters: the placeholder is in a CONDITIONAL
      // TOOL prompt, which the snapshot scan used not to look at.
      toolPrompts: { _skills: DEFAULT_TOOL_PROMPTS._skills },
    }).build({ workspace, filePath, config, provider })

    try {
      await agent.executor.executeTurn(chatDispatch('one'))
      // The placeholder lives in the _skills TOOL prompt, not the base prompt —
      // the whole point of the fix is that such a file is snapshotted at all.
      expect(provider.systems[0]).toContain('<injected_file path="skills-registry.json">')
      expect(provider.systems[0]).toContain('alpha')
      expect(provider.systems[0]).not.toContain('beta')

      // A mid-session install must NOT rewrite the snapshot — that would
      // invalidate the provider's prompt cache on a file write (spec §5.1).
      workspace.writeFile('skills/beta/SKILL.md', manifest('beta'), 'none')
      workspace.refreshSkillIndex()
      expect(workspace.readFile(SKILLS_REGISTRY_PATH)).toContain('beta')

      await agent.executor.executeTurn(chatDispatch('two'))
      expect(provider.systems[1]).toBe(provider.systems[0])

      // …and it MUST refresh at the next session reset. This is what compaction
      // and loop_clear call. Before the fix the stale catalog survived forever:
      // the registry was never in injectedFilesHash, so the cache key never
      // moved, and resetContextState left the cached prompt in place anyway.
      agent.executor.resetContextState()

      await agent.executor.executeTurn(chatDispatch('three'))
      expect(provider.systems[2]).toContain('beta')
      expect(provider.systems[2]).toContain('alpha')
    } finally {
      await agent.disposeAsync()
    }
  })
})
