// Render cost of the chat view while the focused agent streams tokens over a
// client session (W2-B review): 30 s of delta batches at the executor's 50 ms
// flush, through clientFrameEffects and the store, rendered by ink the way
// the app renders (maxFps 30, incremental). Opt-in: ADF_BENCH=1. Prints CPU
// time, stdout writes (an incremental frame is one or more writes) and bytes;
// asserts only a loose CPU bound.

import { EventEmitter } from 'node:events'
import React from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore } from '../../src/main/tui/state/store'
import { clientFrameEffects } from '../../src/main/tui/state/client-stream'
import type { ClientFrame } from '../../src/main/tui/api/types'

const RUN = !!process.env.ADF_BENCH
const SECONDS = Number(process.env.ADF_BENCH_SECONDS ?? 30)
const AGENT = '7d3c2f4e-1b8a-4c1e-9f00-000000000002'

class Stdout extends EventEmitter {
  isTTY = true
  columns = 120
  rows = 34
  frames = 0
  bytes = 0
  write = (chunk: string) => { this.frames++; this.bytes += chunk.length; return true }
}
class Stdin extends EventEmitter {
  isTTY = true
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null
}

describe.skipIf(!RUN)('chat streaming render cost', () => {
  it(`renders ${SECONDS} s of streamed tokens`, async () => {
    const store = createTuiStore({ client: new DaemonClient({ baseUrl: 'http://127.0.0.1:9' }), live: false, initialView: 'chat' })
    store.dispatch({ type: 'agents/loaded', agents: [{ id: AGENT, filePath: null, name: 'agent-1', handle: 'agent-1', autostart: false }] })
    store.actions.selectAgent(AGENT)
    const stdout = new Stdout()
    const instance = render(<App store={store} theme={createTheme({ mono: true })} reserveRows={0} reserveColumns={1} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new Stdin() as unknown as NodeJS.ReadStream,
      stderr: new Stdout() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
      incrementalRendering: true,
    })
    await new Promise(r => setTimeout(r, 300))
    const idleFrames = stdout.frames

    const measure = async (stream: boolean) => {
      const framesBefore = stdout.frames
      const bytesBefore = stdout.bytes
      const cpuBefore = process.cpuUsage()
      const started = performance.now()
      let cursor = 0
      while (performance.now() - started < SECONDS * 1000) {
        if (stream) {
          const frame = { kind: 'executor', cursor: ++cursor, agentId: AGENT, filePath: null, event: { type: 'text_delta_batch', payload: { deltas: ['streaming ', 'words ', `#${cursor} `, 'into the chat view. '] }, timestamp: Date.now() } } as ClientFrame
          // Every 80 batches a paragraph ends, as a long answer would.
          const effects = clientFrameEffects(cursor % 80 === 0 ? { ...frame, event: { ...(frame as { event: object }).event, payload: { deltas: ['\n\n'] } } } as ClientFrame : frame)
          store.dispatch({ type: 'events', frames: effects.frames })
        }
        await new Promise(r => setTimeout(r, 50))
      }
      const cpu = process.cpuUsage(cpuBefore)
      const wall = performance.now() - started
      return { frames: stdout.frames - framesBefore, bytes: stdout.bytes - bytesBefore, cpuMs: (cpu.user + cpu.system) / 1000, wall }
    }

    const idle = await measure(false)
    const streaming = await measure(true)
    instance.unmount()
    store.stop()
    const line = (label: string, r: { frames: number; bytes: number; cpuMs: number; wall: number }) =>
      `${label}: ${r.frames} stdout writes (${(r.frames / (r.wall / 1000)).toFixed(1)}/s), ${(r.bytes / 1024).toFixed(0)} KiB written, CPU ${r.cpuMs.toFixed(0)} ms (${((r.cpuMs / r.wall) * 100).toFixed(1)}% of one core) over ${(r.wall / 1000).toFixed(1)} s`
    process.stderr.write(`[tui stream bench] initial frames ${idleFrames}\n[tui stream bench] ${line('idle', idle)}\n[tui stream bench] ${line('streaming', streaming)}\n`)
    // Loose bound: streaming 20 batches/s stays well under one core.
    expect(streaming.cpuMs / streaming.wall).toBeLessThan(0.8)
  }, (SECONDS * 2 + 30) * 1000)
})
