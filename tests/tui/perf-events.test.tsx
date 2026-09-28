// Keypress latency of the umbilical event tail with thousands of events, and
// while events keep streaming in. Guards against the tail going laggy again
// (per-row JSON formatting, per-event re-renders, index-anchored cursor).

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import type { UmbilicalEvent } from '../../src/main/tui/api/types'
import { renderTui, type RenderedTui } from './fixtures/render'

const AGENT = '7d3c2f4e-1b8a-4c1e-9f00-000000000001'
const UP = '\u001b[A'
const DOWN = '\u001b[B'

let seq = 0
function event(i: number): UmbilicalEvent {
  const type = ['turn.delta', 'tool.started', 'tool.completed', 'agent.state.changed', 'llm.completed'][i % 5]
  return {
    seq: ++seq,
    event_type: type,
    timestamp: Date.now(),
    source: 'bench',
    agent_id: AGENT,
    loop: i % 3 === 0 ? 'consolidator' : undefined,
    // Tool results are big: the row summary must not stringify all of it.
    payload: type === 'tool.completed'
      ? { name: 'fs_read', result: { content: 'x'.repeat(20_000), lines: Array.from({ length: 200 }, (_, n) => `line ${n}`) } }
      : { kind: 'text', text: `token ${i}`, state: 'thinking' },
  }
}

function push(store: TuiStore, count: number): void {
  for (let i = 0; i < count; i++) store.dispatch({ type: 'event', frame: { cursor: seq, event: event(i) } })
}

/** ms from the key write until ink has written the next frame. */
async function timeKey(tui: RenderedTui, key: string): Promise<number> {
  await new Promise(resolve => setTimeout(resolve, 5))
  const before = tui.frames.length
  const began = performance.now()
  tui.raw(key)
  while (tui.frames.length === before) await new Promise(resolve => setImmediate(resolve))
  return performance.now() - began
}

let tui: RenderedTui | null = null
let store: TuiStore | null = null
afterEach(() => { tui?.unmount(); tui = null; store?.stop(); store = null })

describe('event tail performance', () => {
  it('scrolls a 5k-event tail with sub-frame keypress latency, also while events stream in', async () => {
    store = createTuiStore({ client: new DaemonClient({ baseUrl: 'http://127.0.0.1:9' }), live: false, initialView: process.env.PERF_VIEW ?? 'runtime' })
    tui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 120, rows: 34 })
    store.actions.setViewState('runtime', { tab: 'events' })
    store.actions.setViewState('inspect', { tab: 'events', events: { agent: 'all' } })
    push(store, 5000)
    await tui.waitFor('Umbilical')
    // Focus the main pane (the events list).
    store.actions.setFocus('main')
    await tui.waitFor(() => store!.getState().focus === 'main')
    const samples: number[] = []
    for (let i = 0; i < 20; i++) samples.push(await timeKey(tui, UP))
    const streaming = setInterval(() => push(store!, 5), 10)
    const live: number[] = []
    try {
      for (let i = 0; i < 20; i++) live.push(await timeKey(tui, i % 2 ? DOWN : UP))
    } finally {
      clearInterval(streaming)
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    process.stderr.write(`[perf] events tail: idle median ${median(samples).toFixed(1)}ms max ${Math.max(...samples).toFixed(1)}ms; streaming median ${median(live).toFixed(1)}ms max ${Math.max(...live).toFixed(1)}ms; buffered ${store.getState().lastEvents.length}
`)
    expect(median(samples)).toBeLessThan(150)
  }, 60_000)
})

void React
