// Deterministic ink renderer for TUI tests: fixed columns × rows (ink's
// testing library leaves rows to the host terminal), TTY stdin for keys.

import { EventEmitter } from 'node:events'
import type { ReactElement } from 'react'
import { render } from 'ink'

class FakeStdout extends EventEmitter {
  isTTY = true
  frames: string[] = []
  constructor(public columns: number, public rows: number) {
    super()
  }
  write = (frame: string) => {
    // Bare control writes (bracketed paste on/off from usePaste, cursor
    // show/hide after suspendTerminal) are not frames.
    if (!isControlOnly(frame)) this.frames.push(frame)
    return true
  }
  lastFrame = () => this.frames[this.frames.length - 1] ?? ''
}

// eslint-disable-next-line no-control-regex
const CONTROL_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Za-z0-9]|\u001b[=>78]/g

export function isControlOnly(write: string): boolean {
  return write.length > 0 && write.replace(CONTROL_SEQUENCE, '').length === 0
}

class FakeStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write = (data: string) => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const data = this.data
    this.data = null
    return data
  }
}

/**
 * A frame matcher for text an input may wrap (a long path: macOS temp dirs are
 * ~50 chars before the test's own folder). Compares with whitespace and box
 * borders removed, so `…/team-age│\n│ nts/` still reads `…/team-agents/`.
 */
export function wrapped(text: string): (frame: string) => boolean {
  const flat = (s: string) => s.replace(/[\s│╭╮╰╯─]/g, '')
  const want = flat(text)
  return frame => frame.includes(text) || flat(frame).includes(want)
}

export interface RenderedTui {
  lastFrame(): string
  frames: string[]
  /** Send raw input (keys: '\r' enter, '\t' tab, '\u001b' esc, '\u000b' ctrl+k, '\u001b[B' down). */
  press(input: string): Promise<void>
  /** Write raw input without waiting (timing tests). */
  raw(input: string): void
  /** Type text in one chunk (arrives like a fast burst of keys). */
  type(text: string): Promise<void>
  /** Wait until the latest frame satisfies `test` (string = substring). */
  waitFor(test: string | ((frame: string) => boolean), timeoutMs?: number): Promise<string>
  resize(columns: number, rows: number): void
  unmount(): void
}

export function renderTui(node: ReactElement, size: { columns?: number; rows?: number } = {}): RenderedTui {
  const stdout = new FakeStdout(size.columns ?? 110, size.rows ?? 32)
  const stdin = new FakeStdin()
  const stderr = new FakeStdout(size.columns ?? 110, size.rows ?? 32)
  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
  return {
    lastFrame: () => stdout.lastFrame(),
    frames: stdout.frames,
    raw(input) {
      stdin.write(input)
    },
    async press(input) {
      stdin.write(input)
      await tick(30)
    },
    async type(text) {
      stdin.write(text)
      await tick(40)
    },
    async waitFor(test, timeoutMs = 3000) {
      const match = typeof test === 'string' ? (frame: string) => frame.includes(test) : test
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const frame = stdout.lastFrame()
        if (match(frame)) return frame
        await tick()
      }
      throw new Error(`Timed out waiting for frame. Last frame:\n${stdout.lastFrame()}`)
    },
    resize(columns, rows) {
      stdout.columns = columns
      stdout.rows = rows
      stdout.emit('resize')
    },
    unmount: () => instance.unmount(),
  }
}
