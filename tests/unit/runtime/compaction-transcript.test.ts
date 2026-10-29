import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundCompactionTranscript } from '../../../src/main/runtime/compaction-prompt'
import { hasLoneSurrogate } from '../../../src/shared/utils/well-formed'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

describe('bounded compaction transcript', () => {
  it.each(['', '[USER S1] Keep exploring.\n[ASSISTANT S2] Result: 🧪', 'x'.repeat(100_000)])(
    'leaves a transcript within the input budget unchanged (%#)', transcript => {
      expect(boundCompactionTranscript(transcript, 100_000)).toBe(transcript)
    },
  )

  it('retains the initial mandate and recent evidence within the existing cap', () => {
    const early = '[USER S1] Investigate unexpected results; finishing a batch does not finish the assignment.\n'
    const recent = '\n[USER S900] Latest evidence: the control reproduced the anomaly.'
    const transcript = early + 'x'.repeat(50_000) + 'MIDDLE-ONLY' + 'x'.repeat(100_000) + recent
    const bounded = boundCompactionTranscript(transcript, 100_000)
    expect(bounded.startsWith(early)).toBe(true)
    expect(bounded.endsWith(recent)).toBe(true)
    expect(bounded).toContain('[Middle of transcript omitted')
    expect(bounded).not.toContain('MIDDLE-ONLY')
    expect(bounded.length).toBeLessThanOrEqual(100_000)
  })

  it('does not split surrogate pairs at either excerpt boundary', () => {
    // The first astral character straddles the 20k head boundary. Vary the
    // suffix parity so the tail boundary also lands inside a surrogate pair.
    for (const suffix of ['', 'x']) {
      const bounded = boundCompactionTranscript('a'.repeat(19_999) + '🧪'.repeat(60_000) + suffix, 100_000)
      expect(hasLoneSurrogate(bounded)).toBe(false)
      expect(bounded.length).toBeLessThanOrEqual(100_000)
      expect(bounded).toContain('[Middle of transcript omitted')
    }
  })
})

class RecordingCompactor implements LLMProvider {
  readonly name = 'recording-compactor'
  readonly modelId = 'recording-compactor-model'
  readonly requests: CreateMessageOptions[] = []

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.requests.push(options)
    return {
      id: 'summary',
      content: [{ type: 'text', text: 'The ongoing investigation continues. The latest control reproduced the anomaly.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 25_000, output_tokens: 30 },
    }
  }

  async validateConfig() { return { valid: true } }
}

describe('compaction input received by the provider', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it('sends original role/seq provenance for the beginning and recent evidence after clipping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-compact-transcript-'))
    const filePath = join(dir, 'agent.adf')
    createHeadlessAgent({ filePath, name: 'agent', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const goal = 'Keep investigating unexplained results after every completed batch.'
    const latest = 'Latest control: the anomaly reproduced. 🧪'
    const goalSeq = workspace.appendToLoop('user', [{ type: 'text', text: goal }])
    workspace.appendToLoop('assistant', [{ type: 'text', text: 'Intermediate notes. '.repeat(8_000) }])
    const latestSeq = workspace.appendToLoop('user', [{ type: 'text', text: latest }])
    const provider = new RecordingCompactor()
    const config = workspace.getAgentConfig()
    config.context = { ...config.context, compact_threshold: 50_000 }
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })
    try {
      expect(await agent.executor.compactNow('test: preserve both ends')).toEqual({ success: true })
      expect(provider.requests).toHaveLength(1)
      const content = provider.requests[0].messages[0].content
      expect(typeof content).toBe('string')
      const transcript = (content as string).split('<transcript>\n')[1].split('\n</transcript>')[0]
      expect(transcript).toContain(`[USER S${goalSeq}] ${goal}`)
      expect(transcript).toContain(`[USER S${latestSeq}] ${latest}`)
      expect(transcript).toContain('[Middle of transcript omitted')
      expect(hasLoneSurrogate(transcript)).toBe(false)
      const inputLog = workspace.getLogs().find(log => log.event === 'compaction_input')
      expect(inputLog).toBeDefined()
    } finally {
      await agent.disposeAsync()
    }
  })
})
