import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

/** Provider that reports a large input token count on every call, so the
 *  NEXT turn's chatTokens (taken from the last assistant row's persisted
 *  usage) sits far above any small compact_threshold used in these tests. */
class HighUsageProvider implements LLMProvider {
  readonly name = 'high-usage-provider'
  readonly modelId = 'high-usage-model-v1'
  createMessageCalls = 0

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    this.createMessageCalls++
    return {
      id: `reply-${this.createMessageCalls}`,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5000, output_tokens: 10 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-nudge-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
  })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
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

function loopTexts(workspace: AdfWorkspace): string[] {
  return workspace.getLoop().map(e => JSON.stringify(e.content_json))
}

/** Text of every archived loop entry across all audit blobs. */
function archivedTexts(workspace: AdfWorkspace): string[] {
  return workspace.listAudits()
    .filter(a => a.source === 'loop')
    .flatMap(a => (workspace.readAudit(a.id) ?? []).map(e => JSON.stringify(e)))
}

const NUDGE_MARKER = 'Context is about to be compacted'
const COMPACTED_MARKER = '[Loop Compacted'

describe('AgentExecutor — pre-compaction memory-flush grace turn', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('issues one flush nudge at the threshold, then compacts on the following turn', async () => {
    const { filePath, workspace } = makeWorkspace('grace')
    const provider = new HighUsageProvider()
    const baseConfig = workspace.getAgentConfig()
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      // The provider reports 5010 tokens. Threshold 4500 puts that OVER the
      // threshold (grace turn granted) but UNDER the preflight emergency bound
      // (min(4500 + 30k, 4500 * 1.3) = 5850), so the grace turn survives.
      config: { ...baseConfig, context: { ...baseConfig.context, compact_threshold: 4500 } },
      provider,
    })

    try {
      // Turn 1: loop is fresh, char-estimated tokens are tiny → no nudge.
      await agent.executor.executeTurn(chatDispatch('hi'))
      expect(loopTexts(workspace).some(t => t.includes(NUDGE_MARKER))).toBe(false)

      // Turn 2: chatTokens = 5010 from the persisted usage → grace turn.
      // The nudge is injected and persisted; compaction does NOT run yet.
      await agent.executor.executeTurn(chatDispatch('more'))
      const afterNudge = loopTexts(workspace)
      expect(afterNudge.some(t => t.includes(NUDGE_MARKER))).toBe(true)
      expect(afterNudge.some(t => t.includes(COMPACTED_MARKER))).toBe(false)

      // Turn 3: still over threshold, nudge already issued → compaction runs.
      // The nudge entry moves into the audit blob with the rest of the loop.
      await agent.executor.executeTurn(chatDispatch('again'))
      expect(loopTexts(workspace).some(t => t.includes(COMPACTED_MARKER))).toBe(true)
      expect(archivedTexts(workspace).some(t => t.includes(NUDGE_MARKER))).toBe(true)

      // Compaction reset the flag (resetContextState): the next threshold
      // crossing gets a fresh grace turn in the new loop.
      await agent.executor.executeTurn(chatDispatch('after compaction'))
      const afterReset = loopTexts(workspace)
      expect(afterReset.some(t => t.includes(NUDGE_MARKER))).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('emergency bound still compacts during the grace turn when the request would blow past it', async () => {
    const { filePath, workspace } = makeWorkspace('emergency')
    const provider = new HighUsageProvider()
    const baseConfig = workspace.getAgentConfig()
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      // Threshold so small that the emergency bound (threshold * 1.3 = 13
      // tokens) is below the char-estimate of even one long user message:
      // the grace turn is granted but the preflight guard compacts anyway.
      config: { ...baseConfig, context: { ...baseConfig.context, compact_threshold: 10 } },
      provider,
    })

    try {
      const longText = 'flush-test '.repeat(60) // ~660 chars ≫ 13-token bound
      await agent.executor.executeTurn(chatDispatch(longText))
      // The emergency bound compacted within the same turn instead of letting
      // the oversized request go out — the live loop holds only the summary…
      expect(loopTexts(workspace).some(t => t.includes(COMPACTED_MARKER))).toBe(true)
      // …and the nudge WAS issued first (threshold crossed, flag fresh): it
      // sits in the archived pre-compaction loop.
      expect(archivedTexts(workspace).some(t => t.includes(NUDGE_MARKER))).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })
})
