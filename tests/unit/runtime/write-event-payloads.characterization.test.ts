/**
 * Characterization (rule E3, written before W3-F): the payloads of the two
 * events an agent's writes raise for open editors, in both backends.
 * `file_updated` comes from the workspace's file-change choke point
 * (assemble-agent.ts), `document_updated` from the executor's fs_write of the
 * document (agent-executor.ts). Studio's own writes (`system:studio`) raise
 * none. W3-F added `revision` (the one a read returns from then on) and
 * `writer` (the agent).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHeadlessAgent } from '../../../src/main/runtime/headless'
import { apiWriteSource, documentRevision, fileRevision, runAsApiWrite, runAsWriter } from '../../../src/main/runtime/resource-revisions'
import { withSource } from '../../../src/main/runtime/execution-context'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const dirs: string[] = []
afterEach(() => {
  clearAllUmbilicalBuses()
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows file locks */ }
  }
})

const chatDispatch = () => createDispatch(
  createEvent({
    type: 'chat',
    source: 'test',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'go' }], created_at: Date.now() } },
  }),
  { scope: 'agent' },
)

/** fs_write of a note, then of the document, then end_turn. */
class WritingProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  private calls = 0
  private readonly steps = [
    { path: 'notes.md', content: 'from the agent' },
    { path: 'README.md', content: '# Written by the agent' },
  ]
  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    const step = this.steps[this.calls++]
    if (!step) return { id: 'end', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    return {
      id: `r${this.calls}`,
      content: [{ type: 'tool_use', id: `tu${this.calls}`, name: 'fs_write', input: { mode: 'write', ...step } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  async validateConfig(): Promise<{ valid: boolean }> { return { valid: true } }
}

describe('write events an open editor follows', () => {
  it('file_updated and document_updated payloads of an agent turn; a Studio write raises none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-write-events-'))
    dirs.push(dir)
    const agent = createHeadlessAgent({ filePath: join(dir, 'agent-1.adf'), name: 'agent-1', provider: new WritingProvider() })
    const events: AgentExecutionEvent[] = []
    agent.attachHost({ onEvent: (event) => { if (event.type === 'file_updated' || event.type === 'document_updated') events.push(event) } })
    try {
      await agent.executor.executeTurn(chatDispatch())
      const studio = agent.workspace.getAgentConfig().id
      withSource('system:studio', studio, () => agent.workspace.writeFile('notes.md', 'from Studio'))

      expect(events.map(e => [e.type, Object.keys(e.payload as object).sort()])).toEqual([
        ['file_updated', ['content', 'path', 'previousContent', 'revision', 'writer']],
        ['document_updated', ['content', 'previousContent', 'revision', 'writer']],
      ])
      expect(events[0].payload).toMatchObject({ path: 'notes.md', content: 'from the agent', writer: { kind: 'agent' } })
      expect(events[1].payload).toMatchObject({ content: '# Written by the agent', writer: { kind: 'agent' } })
      // The document's revision is what a read returns now; note.md moved on with Studio's write.
      expect((events[1].payload as { revision: number }).revision).toBe(documentRevision(agent.workspace).revision)
      expect(fileRevision(agent.workspace, 'notes.md').revision).toBeGreaterThan((events[0].payload as { revision: number }).revision)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('W5-D2: a write through the Studio client session is `system:studio` and still raises file_updated (other clients follow it); other API writers stay system:runtime-api', async () => {
    expect(runAsWriter({ kind: 'client', client: 'studio' }, apiWriteSource)).toBe('system:studio')
    expect(runAsWriter({ kind: 'client', client: 'tui' }, apiWriteSource)).toBe('system:runtime-api')
    expect(runAsWriter({ kind: 'cli' }, apiWriteSource)).toBe('system:runtime-api')
    expect(apiWriteSource()).toBe('system:runtime-api')

    const dir = mkdtempSync(join(tmpdir(), 'adf-write-events-'))
    dirs.push(dir)
    const agent = createHeadlessAgent({ filePath: join(dir, 'agent-1.adf'), name: 'agent-1', provider: new WritingProvider() })
    const events: AgentExecutionEvent[] = []
    agent.attachHost({ onEvent: (event) => { if (event.type === 'file_updated') events.push(event) } })
    try {
      const id = agent.workspace.getAgentConfig().id
      // Embedded Studio (its IPC write: Studio's writer and source): no echo, as before.
      runAsWriter({ kind: 'client', client: 'studio' }, () => withSource('system:studio', id, () => agent.workspace.writeFile('notes.md', 'embedded')))
      expect(events).toEqual([])
      // The daemon's route for Studio's session: same source, the event is kept with its writer.
      runAsWriter({ kind: 'client', client: 'studio' }, () => runAsApiWrite(id, () => agent.workspace.writeFile('notes.md', 'through the daemon')))
      expect(events.map((e) => e.payload)).toEqual([expect.objectContaining({ path: 'notes.md', content: 'through the daemon', writer: { kind: 'client', client: 'studio' } })])
    } finally {
      await agent.disposeAsync()
    }
  })
})
