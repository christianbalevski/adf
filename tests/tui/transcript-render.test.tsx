import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Box, Text } from 'ink'
import { App } from '../../src/main/tui/app/App'
import { ThemeContext, createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { applyEventToItems, historyToItems, mergeHistory } from '../../src/main/tui/state/transcript'
import { transcriptKey, type ToolItem, type TranscriptItem } from '../../src/main/tui/state/types'
import type { UmbilicalEvent } from '../../src/main/tui/api/types'
import { TranscriptItemView } from '../../src/main/tui/views/chat/Transcript'
import { isExpandable, itemHeight, itemText, lastReply, toolArgs, toolView } from '../../src/main/tui/views/chat/model'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'
import { TASK_REF, pushRow, pushToolCall, seedToolHistory, toolItem } from './fixtures/transcript-fixtures'

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
})

async function mount(before?: (m: MockDaemon) => void, ready = 'What did we decide') {
  mock = await startMockDaemon({ stepMs: 15 })
  before?.(mock)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: 'chat' })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 120, rows: 60 })
  await store.start()
  await ui.waitFor(ready)
  return { tui: ui, mock, store }
}

function mainItems(): TranscriptItem[] {
  return store!.getState().transcripts[transcriptKey(AGENT_1_ID, 'main')]?.items ?? []
}

function tools(): ToolItem[] {
  return mainItems().filter((item): item is ToolItem => item.kind === 'tool')
}

function ev(event_type: string, payload: Record<string, unknown>, seq = 1): UmbilicalEvent {
  return { seq, event_type, timestamp: Date.now(), agent_id: AGENT_1_ID, payload } as UmbilicalEvent
}

describe('tool calls in history', () => {
  it('renders _reason, async, say, status lines and ask like Studio', async () => {
    const { tui } = await mount(m => seedToolHistory(m, AGENT_1_ID), 'Ship the release today?')
    const frame = tui.lastFrame()
    // _reason leads the row, the tool name follows; the flags are not in the args.
    expect(frame).toMatch(/✓ Reconcile delivery state {2}msg_read/)
    expect(frame).toContain('→ 3 messages')
    // No reason: name + compact args.
    expect(frame).toMatch(/✓ fs_list \{"prefix":"notes\/"\}/)
    // Async: badge, task reference as the result for now.
    expect(frame).toMatch(/✓ Fetch the docs in the background {2}sys_fetch \[async\]/)
    expect(frame).toContain('→ {"task_id":"task_bg1"')
    expect(frame).not.toContain('_reason')
    expect(frame).not.toContain('_async')
    // say: a plain assistant message, no tool row.
    expect(frame).toContain('The weekly report is ready.')
    expect(frame).not.toMatch(/✓ say/)
    expect(frame).not.toContain('Message delivered')
    // Status / state changes: one quiet line each.
    expect(frame).toMatch(/─ status · Reconciling inbox/)
    expect(frame).toMatch(/─ state → idle {2}Nothing left to do/)
    expect(frame).not.toContain('sys_set_meta')
    expect(frame).not.toContain('sys_set_state')
    // ask: the ask card with the owner's answer.
    expect(frame).toContain('? the agent asked')
    expect(frame).toContain('› yes, after lunch')
  })

  it('expands a reason row to the full input, _reason and _async included', async () => {
    const { tui } = await mount(m => seedToolHistory(m, AGENT_1_ID), 'Ship the release today?')
    await tui.press('\u001b[Z') // Shift+Tab: the transcript
    // Newest first: ask, state, status, say, then the async call.
    for (let i = 0; i < 5; i++) await tui.press('\u001b[A')
    await tui.press('\r')
    const frame = await tui.waitFor('"_reason": "Fetch the docs in the background"')
    expect(frame).toContain('"_async": true')
    expect(frame).toContain('"url": "https://example.com/docs"')
  })
})

describe('async tool results', () => {
  it('attaches a late tool.completed to the call and keeps it across a history refetch', async () => {
    const { tui, mock } = await mount(m => seedToolHistory(m, AGENT_1_ID), 'Ship the release today?')
    mock.emit({ event_type: 'tool.completed', agent_id: AGENT_1_ID, payload: { id: 'tu_async', name: 'sys_fetch', input: { url: 'https://example.com/docs', _reason: 'Fetch the docs in the background' }, result: { content: 'fetched 12 KB of docs', isError: false }, isError: false } })
    await tui.waitFor('→ fetched 12 KB of docs')
    expect(tools().filter(t => t.toolUseId === 'tu_async')).toHaveLength(1)
    // A refetch (turn.completed) re-reads the task reference from the loop: the live result stays.
    pushRow(mock, AGENT_1_ID, 'main', 'assistant', [{ type: 'text', text: 'Background fetch is done.' }])
    mock.emit({ event_type: 'turn.completed', agent_id: AGENT_1_ID, payload: { content: 'Background fetch is done.' } })
    await tui.waitFor('Background fetch is done.')
    const call = tools().find(t => t.toolUseId === 'tu_async')!
    expect(call.result).toBe('fetched 12 KB of docs')
    expect(call.taskRef).toBe(TASK_REF)
    expect(tui.lastFrame()).toContain('→ fetched 12 KB of docs')
  })

  it('live: a running async call settles on the refetch and takes the result that arrives after it', async () => {
    const { tui, mock } = await mount()
    // Live input carries no _async (the runtime strips it from tool.* payloads).
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { id: 'tu_live', name: 'sys_fetch', input: { url: 'https://example.com/a', _reason: 'Warm the cache' } } })
    await tui.waitFor('Warm the cache  sys_fetch')
    expect(tools().find(t => t.toolUseId === 'tu_live')!.status).toBe('running')
    pushToolCall(mock, AGENT_1_ID, 'main', { id: 'tu_live', name: 'sys_fetch', input: { url: 'https://example.com/a', _async: true, _reason: 'Warm the cache' }, result: TASK_REF })
    pushRow(mock, AGENT_1_ID, 'main', 'assistant', [{ type: 'text', text: 'Started the fetch.' }])
    mock.emit({ event_type: 'turn.completed', agent_id: AGENT_1_ID, payload: { content: 'Started the fetch.' } })
    await tui.waitFor(f => f.includes('Started the fetch.') && f.includes('sys_fetch [async]'))
    let calls = tools().filter(t => t.toolUseId === 'tu_live')
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('ok')
    mock.emit({ event_type: 'tool.failed', agent_id: AGENT_1_ID, payload: { id: 'tu_live', name: 'sys_fetch', input: {}, result: { content: 'HTTP 503', isError: true }, isError: true } })
    await tui.waitFor('→ HTTP 503')
    calls = tools().filter(t => t.toolUseId === 'tu_live')
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('error')
  })
})

describe('live tool events', () => {
  it('renders say, status lines and reason rows from events', async () => {
    const { tui, mock } = await mount()
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { id: 'tu_s', name: 'say', input: { message: 'Heads up: **deploy** at noon.' } } })
    mock.emit({ event_type: 'tool.completed', agent_id: AGENT_1_ID, payload: { id: 'tu_s', name: 'say', result: { content: 'ok', isError: false }, isError: false } })
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { id: 'tu_m', name: 'sys_set_meta', input: { key: 'status', value: 'Deploying' } } })
    mock.emit({ event_type: 'tool.completed', agent_id: AGENT_1_ID, payload: { id: 'tu_m', name: 'sys_set_meta', result: { content: 'ok', isError: false }, isError: false } })
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { id: 'tu_r', name: 'fs_write', input: { path: 'out.md', content: 'x', _reason: 'Save the plan' } } })
    mock.emit({ event_type: 'tool.completed', agent_id: AGENT_1_ID, payload: { id: 'tu_r', name: 'fs_write', result: { content: 'written', isError: false }, isError: false } })
    const frame = await tui.waitFor('Save the plan')
    expect(frame).toContain('Heads up: deploy at noon.')
    expect(frame).not.toMatch(/✓ say/)
    expect(frame).toMatch(/─ status · Deploying/)
    expect(frame).toMatch(/✓ Save the plan {2}fs_write/)
    expect(frame).not.toContain('_reason')
  })

  it('an answered ask becomes the ask call in place: one card, live and after the refetch', async () => {
    const { tui, mock } = await mount()
    mock.emit({ event_type: 'ask.requested', agent_id: AGENT_1_ID, payload: { request_id: 'ask_1', question: 'Which region?' } })
    await tui.waitFor('the agent asks you')
    mock.emit({ event_type: 'ask.resolved', agent_id: AGENT_1_ID, payload: { request_id: 'ask_1', preview: 'eu-west' } })
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { id: 'tu_ask', name: 'ask', input: { question: 'Which region?' } } })
    mock.emit({ event_type: 'tool.completed', agent_id: AGENT_1_ID, payload: { id: 'tu_ask', name: 'ask', result: { content: 'Human answered: eu-west', isError: false }, isError: false } })
    let frame = await tui.waitFor('› eu-west')
    expect(frame.split('Which region?').length - 1).toBe(1)
    pushToolCall(mock, AGENT_1_ID, 'main', { id: 'tu_ask', name: 'ask', input: { question: 'Which region?' }, result: 'Human answered: eu-west' })
    pushRow(mock, AGENT_1_ID, 'main', 'assistant', [{ type: 'text', text: 'Going with eu-west.' }])
    mock.emit({ event_type: 'turn.completed', agent_id: AGENT_1_ID, payload: { content: 'Going with eu-west.' } })
    frame = await tui.waitFor('Going with eu-west.')
    expect(frame.split('Which region?').length - 1).toBe(1)
    expect(mainItems().filter(i => i.kind === 'ask')).toHaveLength(0)
  })
})

describe('transcript model (pure)', () => {
  it('keeps the flags out of the args preview only', () => {
    expect(toolArgs({ _reason: 'r', _async: true, path: 'a' })).toEqual({ path: 'a' })
    expect(toolArgs('raw')).toBe('raw')
  })

  it('classifies say / ask / status / row and their copy text + expandability', () => {
    const say = toolItem({ name: 'say', input: { message: 'hi **there**' } })
    const failedSay = toolItem({ name: 'say', input: { message: 'x' }, status: 'error', result: 'boom' })
    const ask = toolItem({ name: 'ask', input: { question: 'Q?' }, result: 'Human answered: A' })
    const meta = toolItem({ name: 'sys_set_meta', input: { key: 'status', value: 'busy' }, result: 'ok' })
    const metaFailed = toolItem({ name: 'sys_set_meta', input: { key: 'status', value: 'busy' }, status: 'error', result: 'no' })
    const metaOther = toolItem({ name: 'sys_set_meta', input: { key: 'mood', value: 'ok' }, result: 'ok' })
    const state = toolItem({ name: 'sys_set_state', input: { state: 'hibernate' }, result: 'ok' })
    expect([say, ask, meta, metaFailed, metaOther, state].map(toolView)).toEqual(['say', 'ask', 'status', 'row', 'row', 'status'])
    expect(isExpandable(say)).toBe(false)
    expect(isExpandable(failedSay)).toBe(true)
    expect(isExpandable(meta)).toBe(true)
    expect(itemText(say)).toBe('hi **there**')
    expect(itemText(ask)).toBe('Q?\n\nA')
    expect(lastReply([say])).toBe('hi **there**')
  })

  it('history marks async calls and their task reference', () => {
    const items = historyToItems([
      { seq: 1, role: 'assistant', content_json: [{ type: 'tool_use', id: 'a', name: 'sys_fetch', input: { url: 'u', _async: true } }], created_at: 1 },
      { seq: 2, role: 'user', content_json: [{ type: 'tool_result', tool_use_id: 'a', content: TASK_REF }], created_at: 2 },
    ] as never)
    const call = items.find((i): i is ToolItem => i.kind === 'tool')!
    expect(call).toMatchObject({ async: true, taskRef: TASK_REF, status: 'ok', result: TASK_REF })
    // A later live result attaches by tool_use id and survives the next merge.
    const live = applyEventToItems(items, ev('tool.completed', { id: 'a', name: 'sys_fetch', result: { content: 'done', isError: false } }))
    const merged = mergeHistory(live, historyToItems([
      { seq: 1, role: 'assistant', content_json: [{ type: 'tool_use', id: 'a', name: 'sys_fetch', input: { url: 'u', _async: true } }], created_at: 1 },
      { seq: 2, role: 'user', content_json: [{ type: 'tool_result', tool_use_id: 'a', content: TASK_REF }], created_at: 2 },
    ] as never))
    const after = merged.filter((i): i is ToolItem => i.kind === 'tool')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ status: 'ok', result: 'done', taskRef: TASK_REF })
  })
})

// --- itemHeight == rendered rows ------------------------------------------------------

function renderedRows(item: TranscriptItem, width: number, expanded: boolean, ascii = false): number {
  const theme = createTheme({ mono: true, ascii })
  const probe = renderTui(
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column" width={width}>
        <TranscriptItemView item={item} width={width} selected={false} expanded={expanded} showThinking={false} queued={false} />
        <Text>@@END@@</Text>
      </Box>
    </ThemeContext.Provider>,
    { columns: width, rows: 200 },
  )
  const frame = probe.lastFrame()
  probe.unmount()
  // Rows above the end marker = the item, its gap included.
  return frame.split('\n').findIndex(line => line.includes('@@END@@'))
}

const HEIGHT_CASES: Array<[string, ToolItem]> = [
  ['reason row', toolItem({ name: 'msg_read', input: { _reason: 'Reconcile delivery state', status: 'unread' }, result: 'line one\nline two' })],
  ['plain row, running', toolItem({ name: 'fs_list', input: { prefix: 'notes/' }, status: 'running' })],
  ['async row', toolItem({ name: 'sys_fetch', input: { url: 'u', _async: true, _reason: 'bg' }, async: true, taskRef: TASK_REF, result: 'fetched' })],
  ['say', toolItem({ name: 'say', input: { message: `Paragraph one ${'x'.repeat(90)}\n\n- bullet a\n- bullet b` } })],
  ['say failed', toolItem({ name: 'say', input: { message: 'short' }, status: 'error', result: 'no channel' })],
  ['ask answered', toolItem({ name: 'ask', input: { question: `Q${'y'.repeat(130)}` }, result: 'Human answered: yes' })],
  ['ask pending', toolItem({ name: 'ask', input: { question: 'Which region?' }, status: 'running' })],
  ['status line', toolItem({ name: 'sys_set_meta', input: { key: 'status', value: 'Reconciling inbox' }, result: 'ok' })],
  ['state line', toolItem({ name: 'sys_set_state', input: { state: 'idle', _reason: 'done' }, result: 'ok' })],
]

describe('itemHeight matches the rendered rows', () => {
  for (const width of [48, 100]) {
    for (const [name, item] of HEIGHT_CASES) {
      it(`${name} @${width}`, () => {
        expect(renderedRows(item, width, false)).toBe(itemHeight(item, width, { expanded: false, showThinking: false }))
        if (isExpandable(item)) {
          expect(renderedRows(item, width, true)).toBe(itemHeight(item, width, { expanded: true, showThinking: false }))
        }
      })
    }
  }

  it('ASCII glyphs keep the same heights', () => {
    for (const [, item] of HEIGHT_CASES) {
      expect(renderedRows(item, 60, false, true)).toBe(itemHeight(item, 60, { expanded: false, showThinking: false }))
    }
  })

  it('an ask card (ask.requested) at its real text width', () => {
    const ask: TranscriptItem = { id: 'k', at: 1, kind: 'ask', requestId: 'r', question: 'z'.repeat(70), status: 'answered', answer: 'ok' }
    for (const width of [48, 100]) expect(renderedRows(ask, width, false)).toBe(itemHeight(ask, width, { expanded: false, showThinking: false }))
  })
})
