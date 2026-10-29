import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Box, renderToString } from 'ink'
import { ThemeContext, createTheme } from '../../src/main/tui/app/theme'
import * as markdownModule from '../../src/main/tui/ui/Markdown'
import { Markdown } from '../../src/main/tui/ui/Markdown'
import { measuredBlockWindow } from '../../src/main/tui/ui/markdown-window'
import { displayWidth } from '../../src/main/tui/ui/text'
import { TranscriptItemView } from '../../src/main/tui/views/chat/Transcript'
import { App } from '../../src/main/tui/app/App'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore } from '../../src/main/tui/state/store'
import { transcriptKey } from '../../src/main/tui/state/types'
import { INITIAL_CHAT_STATE } from '../../src/main/tui/views/chat/model'
import { renderTui } from './fixtures/render'
import { itemText } from '../../src/main/tui/views/chat/model'
import { mountMarkdown, type MarkdownFrame } from './fixtures/markdown-window'
import type { AssistantItem, ToolItem } from '../../src/main/tui/state/types'

const theme = createTheme({ mono: true })
const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: **bold words**, *emphasis*, \`code\`, and [a link](https://example.test/long-path). More words wrap over several terminal rows.`).join('\n\n')
const mixed = Array.from({ length: 15 }, (_, i) => `# Heading ${i}\n\n中文🙂 é **styled words** are followed by prose.\n\n> quoted line ${i}\n> second quoted line with more words\n\n1. ordered list item ${i}\n2. next entry\n  - nested entry\n\n\`\`\`ts\nconst example = "${'long '.repeat(15)}"\nconsole.log(example)\n\`\`\`\n\n---`).join('\n\n')
function markdownFrame(text: string, width: number, clip: number, windowed: boolean) {
  return renderToString(<ThemeContext.Provider value={theme}><Box width={width} height={12} overflow="hidden" justifyContent="flex-end" flexDirection="column"><Box flexDirection="column" flexShrink={0} marginBottom={-clip}><Markdown text={text} viewport={windowed ? { width, height: 12, clipBottom: clip } : undefined} /></Box></Box></ThemeContext.Provider>, { columns: width })
}

describe('measured Markdown windows', () => {
  it('never hides unknown or rewritten blocks, and does not guess heights below them', () => {
    const signatures = ['a', 'changed', 'c', 'd']
    const heights = new Map([[0, { signature: 'a', height: 10 }], [1, { signature: 'old', height: 20 }], [2, { signature: 'c', height: 10 }], [3, { signature: 'd', height: 10 }]])
    expect(measuredBlockWindow(signatures, heights, { width: 80, height: 5, clipBottom: 0 })).toEqual([true, false, true, false])
    expect(measuredBlockWindow(signatures, heights, { width: 80, height: 5, clipBottom: 30 })).toEqual([false, false, true, true])
  })

  it('omits only offscreen blocks while preserving their measured space', () => {
    const signatures = Array.from({ length: 200 }, (_, i) => String(i))
    const heights = new Map(signatures.map((signature, i) => [i, { signature, height: 4 }]))
    const hidden = measuredBlockWindow(signatures, heights, { width: 80, height: 28, clipBottom: 200 })
    expect(hidden.filter(value => !value)).toHaveLength(7)
    expect(hidden.slice(143, 150)).toEqual(Array(7).fill(false))
  })

  for (const width of [24, 48, 100]) for (const clip of [0, 17, 60, 150]) {
    it(`matches full Ink output at width ${width}, bottom clip ${clip}`, () => {
      for (const text of [paragraphs, mixed, '```\n' + 'a very long code line '.repeat(400) + '\n```', '> ' + 'one long quote '.repeat(400)]) {
        const full = markdownFrame(text, width, clip, false)
        expect(full).not.toContain('ERROR')
        expect(markdownFrame(text, width, clip, true)).toBe(full)
      }
    })
  }

  it('matches full rendering after streaming, scrolling, resizing, theme changes and source rewrites', async () => {
    const sequence: MarkdownFrame[] = [
      { text: mixed, width: 70 },
      { text: mixed + '\n\nnew streamed **suffix**', width: 70 },
      { text: mixed + '\n\nnew streamed **suffix**', width: 70, clip: 60, selected: true },
      { text: mixed + '\n\nnew streamed **suffix**', width: 36, clip: 60, selected: true },
      { text: mixed + '\n\nnew streamed **suffix**', width: 36, clip: 150, mono: false },
      { text: paragraphs, width: 100, clip: 100 },
      { text: 'entire source rewritten to a short reply', width: 100 },
      { text: mixed, width: 70 },
    ]
    const full = mountMarkdown(sequence[0], false)
    const windowed = mountMarkdown(sequence[0], true)
    try {
      await full.ready()
      await windowed.ready()
      const top = { ...sequence[0], clip: Math.max(0, full.height() - 28) }
      expect(await windowed.update(top)).toBe(await full.update(top))
      for (const frame of sequence) {
        const expected = await full.update(frame)
        expect(expected).not.toContain('ERROR')
        expect(await windowed.update(frame)).toBe(expected)
      }
    } finally { full.unmount(); windowed.unmount() }
  })

  it('keeps earlier-item rows visible when ChatView clipping crosses a markup-heavy final item', async () => {
    const store = createTuiStore({ client: new DaemonClient({ baseUrl: 'http://127.0.0.1:9', fetch: async () => { throw new Error('no network in fixture') } }), live: false, initialView: 'chat' })
    const key = transcriptKey('fixture', 'main')
    store.dispatch({ type: 'agents/loaded', agents: [{ id: 'fixture', name: 'fixture', handle: 'fixture', filePath: null, autostart: false }] })
    store.dispatch({ type: 'transcript/history', key, entries: [], total: 0, offset: 0, mode: 'replace' })
    store.dispatch({ type: 'transcript/append', key, item: { id: 'earlier', at: 1, kind: 'assistant', streaming: false, text: Array.from({ length: 60 }, (_, i) => `EARLIER-ITEM paragraph ${i}: ` + 'words fill several terminal rows to exercise partial item scrolling. '.repeat(4)).join('\n\n') } })
    store.dispatch({ type: 'transcript/append', key, item: { id: 'last', at: 2, kind: 'assistant', streaming: false, text: '**x** '.repeat(600) } })
    store.dispatch({ type: 'viewState/set', view: 'chat', value: { ...INITIAL_CHAT_STATE, scroll: { [key]: { bottomKey: 'last', clip: 40 } } } })
    const OriginalMarkdown = markdownModule.Markdown
    const fullRendering = vi.spyOn(markdownModule, 'Markdown').mockImplementation(({ viewport: _viewport, ...props }) => <OriginalMarkdown {...props} />)
    let expected: string
    const baselineUi = renderTui(<App store={store} theme={theme} reserveColumns={0} reserveRows={0} />, { columns: 100, rows: 36 })
    try {
      await baselineUi.waitFor('newer rows')
      await baselineUi.press('')
      expected = baselineUi.lastFrame()
      expect(expected).toContain('EARLIER-ITEM')
    } finally { baselineUi.unmount(); fullRendering.mockRestore() }
    const ui = renderTui(<App store={store} theme={theme} reserveColumns={0} reserveRows={0} />, { columns: 100, rows: 36 })
    try {
      await ui.waitFor('newer rows')
      await ui.press('')
      expect(ui.lastFrame()).not.toContain('ERROR')
      expect(ui.lastFrame()).toBe(expected!)
    } finally { ui.unmount(); store.stop() }
  })

  it('preserves say-tool selection, failed footer and scrolling with full copy text', () => {
    for (const status of ['ok', 'error'] as const) for (const clip of [0, 19, 90]) {
      const item: ToolItem = { id: 'say', kind: 'tool', at: 1, name: 'say', input: { message: paragraphs }, status, result: status === 'error' ? 'delivery failed' : 'delivered' }
      const frame = (windowed: boolean) => renderToString(<ThemeContext.Provider value={theme}><Box width={70} height={14} overflow="hidden" justifyContent="flex-end" flexDirection="column"><Box flexShrink={0} flexDirection="column" marginBottom={-clip}><TranscriptItemView item={item} width={70} selected expanded={false} showThinking={false} queued={false} viewportHeight={windowed ? 14 : undefined} clipBottom={clip} /></Box></Box></ThemeContext.Provider>, { columns: 70 })
      expect(frame(true)).toBe(frame(false))
      if (status === 'error' && clip === 0) expect(frame(true)).toContain('say failed: delivery failed')
      expect(itemText(item)).toBe(paragraphs)
    }
  })

  it('preserves the selection gutter, interruption footer, and full copy text', () => {
    const item: AssistantItem = { id: 'a', kind: 'assistant', at: 1, text: paragraphs, streaming: false, interrupted: true }
    const frame = (windowed: boolean) => renderToString(<ThemeContext.Provider value={theme}><Box width={70} height={14} overflow="hidden" justifyContent="flex-end" flexDirection="column"><Box flexShrink={0} flexDirection="column" marginBottom={-19}><TranscriptItemView item={item} width={70} selected expanded={false} showThinking={false} queued={false} viewportHeight={windowed ? 14 : undefined} clipBottom={19} /></Box></Box></ThemeContext.Provider>, { columns: 70 })
    expect(frame(true)).toBe(frame(false))
    expect(itemText(item)).toBe(paragraphs)
  })
})

describe('ASCII terminal-width fast path', () => {
  it('does not iterate ASCII code points on the terminal layout hot path', () => {
    const iterator = vi.spyOn(String.prototype, Symbol.iterator)
    let calls: number
    try {
      displayWidth('ASCII prose '.repeat(5000))
      calls = iterator.mock.calls.length
    } finally { iterator.mockRestore() }
    expect(calls!).toBe(0)
  })

  it('keeps existing ASCII control, wide, combining, and emoji width semantics', () => {
    expect(displayWidth(Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join(''))).toBe(128)
    expect(displayWidth('ordinary ASCII code and prose')).toBe(29)
    expect(displayWidth('中文')).toBe(4)
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('a\u200bb\u200dc\ufe0f')).toBe(3)
    expect(displayWidth('🙂')).toBe(2)
    expect(displayWidth('')).toBe(0)
  })
})
