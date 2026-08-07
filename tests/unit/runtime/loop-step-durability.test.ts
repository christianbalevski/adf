import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { CreateAgentOptions } from '../../../src/shared/types/adf-v02.types'

type LoopRow = ReturnType<AdfWorkspace['getLoop']>[number]

const cleanupDirs: string[] = []

function makeWorkspace(name: string, createOptions?: Partial<CreateAgentOptions>) {
  const dir = mkdtempSync(join(tmpdir(), `adf-loop-durability-${name}-`))
  cleanupDirs.push(dir)
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions,
  })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function chatDispatch(text = 'hello') {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text' as const, text }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

/** All rows whose serialized content contains `needle`. */
function rowsContaining(rows: LoopRow[], needle: string): LoopRow[] {
  return rows.filter(row => JSON.stringify(row.content_json).includes(needle))
}

function textResponse(id: string, text: string): LLMResponse {
  return {
    id,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function toolUseResponse(id: string, toolUseId: string, name: string, input: Record<string, unknown>): LLMResponse {
  return {
    id,
    content: [{ type: 'tool_use', id: toolUseId, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

/** Serves scripted responses per call; the last script entry repeats. Records a
 *  loop-table snapshot (a real SQLite read) at the start of every call, which is
 *  what proves entries hit disk BEFORE the turn's finally-flush runs. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  readonly loopAtCall: LoopRow[][] = []

  constructor(
    private readonly workspace: AdfWorkspace,
    private readonly script: Array<(opts: CreateMessageOptions) => LLMResponse | Promise<LLMResponse>>,
  ) {}

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.loopAtCall.push(this.workspace.getLoop())
    const step = this.script[Math.min(this.loopAtCall.length - 1, this.script.length - 1)]
    return step(opts)
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

async function buildAgent(workspace: AdfWorkspace, filePath: string, provider: LLMProvider) {
  return new AgentRuntimeBuilder().build({
    workspace,
    filePath,
    config: workspace.getAgentConfig(),
    provider,
  })
}

describe('loop entry per-step durability', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows file locks */ }
    }
  })

  it('persists the trigger message and each completed tool step before the turn ends', async () => {
    const { filePath, workspace } = makeWorkspace('agent-1', {
      tools: [{ name: 'fs_write', enabled: true, visible: true, restricted: false }],
    })
    const provider = new ScriptedProvider(workspace, [
      () => toolUseResponse('step-1', 'write-1', 'fs_write', { path: 'notes.txt', content: 'durable' }),
      () => textResponse('step-2', 'all done'),
    ])
    const agent = await buildAgent(workspace, filePath, provider)

    try {
      await agent.executor.executeTurn(chatDispatch('hello durable world'))

      // Snapshot taken during the FIRST model call: the trigger user message
      // was already on disk the moment the turn started.
      expect(rowsContaining(provider.loopAtCall[0], 'hello durable world')).toHaveLength(1)

      // Snapshot taken during the SECOND model call (mid-turn, before the
      // turn-level flush in finally): the full first step — assistant
      // tool_use batch AND its tool_result — is already in SQLite.
      const midTurn = provider.loopAtCall[1]
      const assistantRows = midTurn.filter(row =>
        row.role === 'assistant' && row.content_json.some(b => b.type === 'tool_use' && b.id === 'write-1'))
      const resultRows = midTurn.filter(row =>
        row.role === 'user' && row.content_json.some(b => b.type === 'tool_result' && b.tool_use_id === 'write-1'))
      expect(assistantRows).toHaveLength(1)
      expect(resultRows).toHaveLength(1)

      // After the turn, nothing was double-written by the finally-flush.
      const final = workspace.getLoop()
      expect(rowsContaining(final, 'write-1')).toHaveLength(2)
      expect(rowsContaining(final, 'all done')).toHaveLength(1)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('has all completed steps on disk when aborted mid-turn', async () => {
    const { filePath, workspace } = makeWorkspace('agent-2', {
      tools: [{ name: 'fs_write', enabled: true, visible: true, restricted: false }],
    })
    let reachedSecondCall!: () => void
    const secondCallStarted = new Promise<void>(resolve => { reachedSecondCall = resolve })
    const provider = new ScriptedProvider(workspace, [
      () => toolUseResponse('step-1', 'write-2', 'fs_write', { path: 'notes.txt', content: 'durable' }),
      (opts) => {
        reachedSecondCall()
        // Hang until abort — simulates an in-flight model call at shutdown.
        return new Promise<LLMResponse>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    ])
    const agent = await buildAgent(workspace, filePath, provider)

    try {
      const turn = agent.executor.executeTurn(chatDispatch('abort me'))
      await secondCallStarted

      // BEFORE abort: trigger + assistant tool_use + tool_result already durable.
      const midTurn = workspace.getLoop()
      expect(rowsContaining(midTurn, 'abort me')).toHaveLength(1)
      expect(rowsContaining(midTurn, 'write-2')).toHaveLength(2)

      agent.executor.abort()
      await turn

      const final = workspace.getLoop()
      expect(rowsContaining(final, 'abort me')).toHaveLength(1)
      expect(rowsContaining(final, 'write-2')).toHaveLength(2)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('flushToLoop is idempotent — repeated flushes write no duplicate rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-loop-durability-flush-'))
    cleanupDirs.push(dir)
    const workspace = AdfWorkspace.create(join(dir, 'agent-3.adf'), { name: 'agent-3' })
    try {
      const session = new AgentSession(workspace)

      session.flushToLoop() // empty buffer — no-op
      expect(workspace.getLoop()).toHaveLength(0)

      session.addMessage({ role: 'user', content: [{ type: 'text', text: 'first' }] })
      session.flushToLoop()
      session.flushToLoop()
      expect(workspace.getLoop()).toHaveLength(1)

      session.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'second' }] })
      session.flushToLoop()
      session.flushToLoop()

      const rows = workspace.getLoop()
      expect(rows).toHaveLength(2)
      expect(rows[0].role).toBe('user')
      expect(rows[1].role).toBe('assistant')
    } finally {
      workspace.dispose()
    }
  })

  it('loop_clear still wipes mid-turn-flushed rows (no resurrection from the buffer)', async () => {
    const { filePath, workspace } = makeWorkspace('agent-4', {
      tools: [{ name: 'loop_clear', enabled: true, visible: true, restricted: false }],
    })
    const provider = new ScriptedProvider(workspace, [
      () => toolUseResponse('step-1', 'clear-1', 'loop_clear', {}),
      () => textResponse('step-2', 'should never be reached'),
    ])
    const agent = await buildAgent(workspace, filePath, provider)

    try {
      await agent.executor.executeTurn(chatDispatch('please clear'))

      // The mid-turn flush put the trigger + tool step on disk BEFORE the
      // clear ran — verify none of it survives or is resurrected by the
      // turn-level flush in finally.
      const final = workspace.getLoop()
      expect(rowsContaining(final, 'please clear')).toHaveLength(0)
      expect(rowsContaining(final, 'clear-1')).toHaveLength(0)
      // A full loop_clear empties the session, which ends the turn before a
      // second model call (pre-existing executor semantics) — the only rows
      // left are UI/SQL-only [Context: …] audit entries.
      for (const row of final) {
        expect(JSON.stringify(row.content_json)).toContain('[Context: ')
      }
    } finally {
      await agent.disposeAsync()
    }
  })

  it('voluntary loop_compact preserves the current turn exactly once despite mid-turn flushes', async () => {
    const { filePath, workspace } = makeWorkspace('agent-5', {
      tools: [{ name: 'loop_compact', enabled: true, visible: true, restricted: false }],
    })
    const provider = new ScriptedProvider(workspace, [
      () => toolUseResponse('step-1', 'compact-1', 'loop_compact', {}),
      () => textResponse('summary', 'condensed history'),
      () => textResponse('step-3', 'after-compact'),
    ])
    const agent = await buildAgent(workspace, filePath, provider)

    try {
      await agent.executor.executeTurn(chatDispatch('please compact'))

      const final = workspace.getLoop()
      // One summary marker; the pre-compaction trigger is summarized away.
      expect(rowsContaining(final, '[Loop Compacted]')).toHaveLength(1)
      expect(rowsContaining(final, 'please compact')).toHaveLength(0)
      // The preserved current turn (assistant tool_use + tool_result) appears
      // exactly once each — the mid-turn flush did not duplicate it.
      const preservedAssistant = final.filter(row =>
        row.role === 'assistant' && row.content_json.some(b => b.type === 'tool_use' && b.id === 'compact-1'))
      const preservedResult = final.filter(row =>
        row.role === 'user' && row.content_json.some(b => b.type === 'tool_result' && b.tool_use_id === 'compact-1'))
      expect(preservedAssistant).toHaveLength(1)
      expect(preservedResult).toHaveLength(1)
      expect(rowsContaining(final, 'after-compact')).toHaveLength(1)
    } finally {
      await agent.disposeAsync()
    }
  })
})
