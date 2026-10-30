import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { parseLoopToDisplay, providerContextCategory } from '../../../src/shared/utils/loop-parser'
import type { LLMMessage } from '../../../src/shared/types/provider.types'

/**
 * Claude Code writes assistant messages of its own (model `<synthetic>`): the
 * "No response requested." that closes an unanswered prompt on resume, and
 * API errors. They reach ADF through the transcript mirror and/or the SDK
 * stream. Only real model output may become the reply; the filler is reported
 * as provider context. The SDK is mocked: these are fixtures, not a live CLI.
 */

type Options = { sessionStore: { append: (key: unknown, batch: unknown[]) => Promise<void>; load: () => Promise<unknown> }; resume?: string }

const sdk = vi.hoisted(() => ({ turns: [] as Array<(o: unknown) => Promise<unknown[]> | unknown[]>, onResume: null as null | ((o: unknown) => Promise<void>) }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    const gen = (async function* () {
      if (options.resume) {
        await options.sessionStore.load()
        await sdk.onResume?.(options)
      }
      const inputs = prompt[Symbol.asyncIterator]()
      while (!(await inputs.next()).done) {
        const turn = sdk.turns.shift()
        if (!turn) return
        for (const m of await turn(options)) yield m
      }
    })()
    return Object.assign(gen, { close: () => { void gen.return(undefined) } })
  },
}))

vi.mock('../../../src/main/providers/claude-subscription/claude-code', () => ({
  requireClaudeCode: async () => ({ path: '/fake/claude', version: '2.1.312' }),
  claudeCodeEnv: (extra?: Record<string, string>) => ({ ...extra }),
}))

const { ClaudeSubscriptionProvider, closeAllClaudeSessions } = await import('../../../src/main/providers/claude-subscription/provider')

const MODEL = 'claude-opus-5-5'
const NO_RESPONSE = 'No response requested.'

const syntheticMessage = (id = 'msg_synth_1', text = NO_RESPONSE) => ({
  id, type: 'message', role: 'assistant', model: '<synthetic>',
  content: [{ type: 'text', text }],
  stop_reason: 'stop_sequence', stop_sequence: '',
  usage: { input_tokens: 0, output_tokens: 0 },
})
const transcriptRow = (message: Record<string, unknown>, uuid = 'uuid-synth-1') => ({ type: 'assistant', uuid, parentUuid: null, message })
const sdkAssistant = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'assistant', parent_tool_use_id: null, uuid: 'sdk-uuid', session_id: 's', message, ...extra })

/** A real model response, streamed. */
function streamed(id: string, text: string, stop = 'end_turn'): unknown[] {
  const ev = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event })
  return [
    ev({ type: 'message_start', message: { id, usage: { input_tokens: 10 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 3 } }),
    ev({ type: 'message_stop' }),
    sdkAssistant({ id, role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: stop }),
  ]
}
const success = { type: 'result', subtype: 'success', is_error: false, result: '' }

// History ending in an unanswered user message: a cold start resumes it and
// sends the last message as the prompt.
const unanswered: LLMMessage[] = [
  { role: 'user', content: 'Remember the word: walnut.' },
  { role: 'user', content: 'Reply with OK.' },
]

const injections = (r: { providerMetadata?: Record<string, unknown> }) =>
  ((r.providerMetadata?.adf as { contextInjections?: string[] } | undefined)?.contextInjections ?? [])
const replyText = (r: { content: Array<{ type: string; text?: string }> }) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('')

function provider() {
  return new ClaudeSubscriptionProvider({ providerId: 'test', displayName: 'Claude', modelId: MODEL })
}

afterEach(() => {
  closeAllClaudeSessions()
  sdk.turns = []
  sdk.onResume = null
})

describe('claude-subscription synthetic assistant messages', () => {
  it('reports a resume-repair synthetic row from the transcript as Claude Code context, not the reply', async () => {
    sdk.onResume = async (o) => {
      await (o as Options).sessionStore.append({}, [
        { type: 'attachment', attachment: { type: 'date_change' }, rendered: [{ content: "Today's date is 2026-10-30." }] },
        transcriptRow(syntheticMessage()),
      ])
    }
    sdk.turns.push(() => [...streamed('msg_real_1', 'OK'), success])
    const deltas: string[] = []
    const r = await provider().createMessage({ system: 's', messages: unanswered, onTextDelta: (d) => deltas.push(d) })

    expect(r.id).toBe('msg_real_1')
    expect(replyText(r)).toBe('OK')
    expect(deltas.join('')).toBe('OK')
    expect(r.providerMetadata?.adf).toMatchObject({ contextSource: 'Claude Code' })
    const added = injections(r)
    // Original attachments are still captured.
    expect(added).toContain("Today's date is 2026-10-30.")
    const synth = added.filter((t) => t.includes(NO_RESPONSE))
    expect(synth).toEqual([
      'Synthetic assistant message added by Claude Code (not a model reply; model <synthetic>, stop_reason stop_sequence): No response requested.',
    ])
  })

  it('never completes the turn with a synthetic SDK assistant message, and records it once when the transcript also has it', async () => {
    const message = syntheticMessage()
    sdk.turns.push(async (o) => {
      await (o as Options).sessionStore.append({}, [transcriptRow(message)])
      return [sdkAssistant(message), ...streamed('msg_real_2', 'OK'), success]
    })
    const r = await provider().createMessage({ system: 's', messages: [{ role: 'user', content: 'hi' }] })

    expect(r.id).toBe('msg_real_2')
    expect(replyText(r)).toBe('OK')
    expect(r.stop_reason).toBe('end_turn')
    expect(injections(r).filter((t) => t.includes(NO_RESPONSE))).toHaveLength(1)
  })

  it('persists the synthetic row as provider context that is shown as context and never replayed to the model', async () => {
    sdk.onResume = async (o) => { await (o as Options).sessionStore.append({}, [transcriptRow(syntheticMessage())]) }
    sdk.turns.push(() => [...streamed('msg_real_4', 'OK'), success])
    const r = await provider().createMessage({ system: 's', messages: unanswered })

    const rootDir = mkdtempSync(join(tmpdir(), 'adf-claude-synthetic-'))
    const ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'synthetic' })
    try {
      // What the executor does with the response: the trigger and reply are
      // messages, provider context is a context row.
      const session = new AgentSession(ws)
      session.addMessage({ role: 'user', content: 'Reply with OK.' })
      session.addMessage({ role: 'assistant', content: r.content })
      const addedBy = (r.providerMetadata?.adf as { contextSource: string }).contextSource
      for (const content of injections(r)) session.appendContextEntry(providerContextCategory(addedBy), content)

      const loop = ws.getLoop()
      const display = parseLoopToDisplay(loop)
      const synth = display.filter((d) => d.content.includes(NO_RESPONSE))
      expect(synth).toHaveLength(1)
      expect(synth[0]).toMatchObject({ type: 'context', metadata: { category: 'provider_context', addedBy: 'Claude Code' } })
      expect(display.filter((d) => d.type === 'text').map((d) => d.content)).toEqual(['OK'])

      const restored = new AgentSession(ws)
      restored.restoreMessages(loop.map((e) => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq })))
      const messages = restored.getMessages()
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(JSON.stringify(messages[0].content)).toContain('Reply with OK.')
      expect(replyText({ content: messages[1].content as Array<{ type: string; text?: string }> })).toBe('OK')
      expect(JSON.stringify(messages)).not.toContain(NO_RESPONSE)
    } finally {
      ws.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('keeps a real model reply that says the same words', async () => {
    sdk.turns.push(() => [...streamed('msg_real_3', NO_RESPONSE), success])
    const r = await provider().createMessage({ system: 's', messages: [{ role: 'user', content: 'Say: No response requested.' }] })

    expect(replyText(r)).toBe(NO_RESPONSE)
    expect(injections(r)).toEqual([])
  })

  it('keeps a real non-streamed model reply', async () => {
    const whole = { id: 'msg_whole', role: 'assistant', model: MODEL, content: [{ type: 'text', text: NO_RESPONSE }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    sdk.turns.push(() => [sdkAssistant(whole), success])
    const r = await provider().createMessage({ system: 's', messages: [{ role: 'user', content: 'hi' }] })

    expect(r.id).toBe('msg_whole')
    expect(replyText(r)).toBe(NO_RESPONSE)
  })

  it('still reports a synthetic API error as an error', async () => {
    const err = { ...syntheticMessage('msg_err', 'Rate limited'), stop_reason: 'stop_sequence' }
    sdk.turns.push(async (o) => {
      await (o as Options).sessionStore.append({}, [{ ...transcriptRow(err, 'uuid-err'), isApiErrorMessage: true }])
      return [
      sdkAssistant(err, { error: 'rate_limit' }),
      { type: 'result', subtype: 'success', is_error: true, result: 'Rate limited' },
      ]
    })
    await expect(provider().createMessage({ system: 's', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ status: 429 })
  })

  it('keeps the tool bridge working when a synthetic row precedes a tool call', async () => {
    const tool = { name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }
    const ev = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event })
    sdk.onResume = async (o) => { await (o as Options).sessionStore.append({}, [transcriptRow(syntheticMessage())]) }
    sdk.turns.push(() => [
      ev({ type: 'message_start', message: { id: 'msg_tool' } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__adf__get_weather' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Oslo"}' } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      ev({ type: 'message_stop' }),
    ])
    const r = await provider().createMessage({ system: 's', messages: unanswered, tools: [tool] })

    expect(r.stop_reason).toBe('tool_use')
    expect(r.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } }])
    expect(injections(r).filter((t) => t.includes(NO_RESPONSE))).toHaveLength(1)
  })
})
