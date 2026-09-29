import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { BUILTIN_COMMANDS } from '../../src/main/tui/commands/builtin'
import { barFill, barText, contextRows, loopContextPercent, pressureOf, thresholdText, windowStart } from '../../src/main/tui/context/model'
import { contextCategories, contextTotal, resolveCompactThreshold } from '../../src/shared/utils/context-breakdown'
import { formatCount } from '../../src/main/tui/ui/text'
import type { AgentConfig } from '../../src/shared/types/adf-v02.types'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { mockBreakdown } from './fixtures/context-mock'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A', right: '\u001b[C', ctrlRight: '\u001b[1;5C' }

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

async function mount(options: { view?: 'chat' | 'fleet'; columns?: number; rows?: number } = {}) {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: options.view ?? 'fleet' })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: options.columns ?? 120, rows: options.rows ?? 34 })
  await store.start()
  await ui.waitFor(() => store!.getState().selectedAgentId === AGENT_1_ID)
  return { tui: ui, store, mock }
}

async function slash(tui: RenderedTui, text: string) {
  store!.actions.prefillPrompt('')
  await tui.waitFor(() => store!.getState().focus === 'input')
  await new Promise(resolve => setTimeout(resolve, 40))
  await tui.type(text)
  await tui.waitFor(text)
  await tui.press(KEY.enter)
}

const cfg = (extra: Partial<AgentConfig>) => ({ model: { provider: 'p', model_id: 'm' }, ...extra }) as unknown as AgentConfig

describe('context model', () => {
  it('resolves the compact threshold in the executor’s order, with its source', () => {
    expect(resolveCompactThreshold(cfg({}))).toEqual({ value: 100000, source: 'default' })
    expect(resolveCompactThreshold(cfg({ model: { provider: 'p', model_id: 'm', compact_threshold: 50000 } as never }))).toEqual({ value: 50000, source: 'model' })
    const withLoops = cfg({ context: { compact_threshold: 80000 } as never, loops: [{ name: 'a', goal: '', enabled: true, compact_threshold: 30000 }, { name: 'b', goal: '', enabled: true, model: { provider: 'p', model_id: 'x', compact_threshold: 20000 } }] as never })
    expect(resolveCompactThreshold(withLoops)).toEqual({ value: 80000, source: 'agent' })
    expect(resolveCompactThreshold(withLoops, 'a')).toEqual({ value: 30000, source: 'loop' })
    // The host's context value shadows a per-loop model's threshold (derive-loop-config).
    expect(resolveCompactThreshold(withLoops, 'b')).toEqual({ value: 80000, source: 'agent' })
    expect(resolveCompactThreshold(cfg({ loops: [{ name: 'b', goal: '', enabled: true, model: { provider: 'p', model_id: 'x', compact_threshold: 20000 } }] as never }), 'b')).toEqual({ value: 20000, source: 'model' })
    expect(resolveCompactThreshold(withLoops, 'unknown').value).toBe(80000)
  })

  it('splits a breakdown into non-overlapping categories that sum to the total, biggest first', () => {
    const b = mockBreakdown(10)
    const cats = contextCategories(b, 5)
    expect(cats.reduce((n, c) => n + c.tokens, 0)).toBe(contextTotal(b))
    expect(cats.map(c => c.id).sort()).toEqual(['dynamic', 'files', 'mcp:github', 'messages', 'system', 'tools'])
    expect([...cats].map(c => c.tokens)).toEqual([...cats].map(c => c.tokens).sort((x, y) => y - x))
    const mcp = cats.find(c => c.id === 'mcp:github')!
    expect(mcp.count).toBe(26)
    expect(mcp.items).toHaveLength(5)
    expect(mcp.items[0]!.tokens).toBeGreaterThanOrEqual(mcp.items[4]!.tokens)
    expect(cats.find(c => c.id === 'system')!.tokens).toBe(b.system_prompt_tokens - 1840)
    expect(cats.find(c => c.id === 'files')!.items).toEqual([{ name: 'mind.md', tokens: 1840 }])
  })

  it('rows, bars, windows, pressure and the footer gauge', () => {
    const cats = contextCategories(mockBreakdown(0), 3)
    const rows = contextRows(cats, 'mcp:github')
    const i = rows.findIndex(r => r.kind === 'category' && r.category.id === 'mcp:github')
    expect(rows.slice(i + 1, i + 5).map(r => r.kind)).toEqual(['item', 'item', 'item', 'more'])
    expect(rows.find(r => r.kind === 'more')).toMatchObject({ hidden: 23 })
    expect(contextRows(cats, null).every(r => r.kind === 'category')).toBe(true)
    expect(barFill(0, 100, 10)).toBe(0)
    expect(barFill(1, 1000, 10)).toBe(0)
    expect(barFill(60, 1000, 10)).toBe(1)
    expect(barFill(500, 100, 10)).toBe(10)
    expect(barText(50, 100, 4, true)).toEqual({ filled: '##', empty: '..' })
    expect(windowStart(20, 0, 5, 0)).toBe(0)
    expect(windowStart(20, 12, 5, 0)).toBe(8)
    expect(windowStart(20, 3, 5, 8)).toBe(3)
    expect(pressureOf(10)).toBe('ok')
    expect(pressureOf(75)).toBe('warn')
    expect(pressureOf(95)).toBe('high')
    expect(thresholdText({ compactThreshold: 60000, compactThresholdSource: 'loop' }, formatCount)).toBe('auto-compacts at 60k (this loop’s own setting)')
    expect(loopContextPercent(cfg({}), 'main', undefined)).toBeNull()
    expect(loopContextPercent(cfg({}), 'main', 42000)).toBe(42)
    expect(loopContextPercent(cfg({ loops: [{ name: 'a', goal: '', enabled: true, compact_threshold: 20000 }] as never }), 'a', 5000)).toBe(25)
  })

  it('registers /context and the palette action', () => {
    expect(BUILTIN_COMMANDS.commands!.some(c => c.name === 'context')).toBe(true)
    expect(BUILTIN_COMMANDS.actions!.some(a => a.id === 'context.show')).toBe(true)
  })
})

describe('context dialog', () => {
  it('shows the total against the threshold and the categories; Enter expands; esc closes', async () => {
    const { tui } = await mount()
    await slash(tui, '/context')
    let frame = await tui.waitFor('Conversation')
    expect(frame).toContain('Context')
    expect(frame).toContain('loop main')
    expect(frame).toMatch(/\/ 100k +\d+%/)
    expect(frame).toContain('auto-compacts at 100k (the default)')
    expect(frame).toContain('MCP github (26)')
    expect(frame).toContain('Tools (18)')
    expect(frame).toContain('Injected files (1)')
    // Biggest first: the MCP server outweighs the built-in tools.
    expect(frame.indexOf('MCP github')).toBeLessThan(frame.indexOf('Tools (18)'))
    expect(frame).not.toContain('mcp_github_tool_')
    await tui.press(KEY.enter)
    frame = await tui.waitFor('mcp_github_tool_')
    expect(frame).toContain('14 smaller not shown')
    await tui.press(KEY.enter)
    await tui.waitFor(f => !f.includes('mcp_github_tool_'))
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('auto-compacts at'))
    expect(store!.getState().overlays).toHaveLength(0)
  })

  it('switches loops with ←/→ and shows a loop’s own threshold', async () => {
    const { tui } = await mount()
    await slash(tui, '/context consolidator')
    let frame = await tui.waitFor(f => f.includes('loop consolidator') && f.includes('auto-compacts at'))
    expect(frame).toContain('auto-compacts at 60k (this loop’s own setting)')
    expect(frame).toContain('agent: 100k')
    await tui.press(KEY.right)
    frame = await tui.waitFor(f => !f.includes('loop consolidator') && f.includes('loop ') && f.includes('auto-compacts at'))
    expect(frame).not.toContain('loop consolidator')
  })

  it('compacts after a confirm and re-measures', async () => {
    const { tui, mock } = await mount()
    await slash(tui, '/context')
    await tui.waitFor('Conversation')
    const before = mock.requests.filter(r => r.startsWith('GET /agents/') && r.includes('/context')).length
    await tui.press('c')
    await tui.waitFor('Compact now')
    await tui.press('y')
    await tui.waitFor('Conversation')
    await tui.waitFor(() => mock.requests.some(r => r.startsWith('POST /agents/') && r.includes('/compact')))
    await tui.waitFor(() => mock.requests.filter(r => r.startsWith('GET /agents/') && r.includes('/context')).length > before)
    await tui.waitFor('Compacted main')
  })

  it('fits 80x24', async () => {
    const { tui } = await mount({ columns: 80, rows: 24 })
    await slash(tui, '/context')
    const frame = await tui.waitFor('Conversation')
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    expect(frame).toMatch(/esc close/i)
    expect(frame).toContain('Dynamic instructions')
  })
})

describe('chat footer gauge', () => {
  it('shows ctx N% after a call, against the loop’s threshold', async () => {
    const { tui } = await mount({ view: 'chat' })
    await tui.waitFor('consolidator')
    await tui.press(KEY.ctrlRight)
    for (const ch of 'hi') await tui.press(ch)
    await tui.press(KEY.enter)
    // 1200 input tokens of 100k.
    const frame = await tui.waitFor(f => f.includes('last turn') && f.includes('ctx 1%'))
    expect(frame).toContain('ctx 1%')
  })
})
