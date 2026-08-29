import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'

/**
 * `AdfWorkspace.addTimer` decides which cognition stream a timer wakes.
 *
 * Main-bound: the caller may name a loop (this is what lets main build the
 * reflector pattern — schedule a wake AT a side loop).
 * Side-loop-bound: the stamp is FORCED from the binding and the override is
 * ignored, so a loop can never address a wake at a sibling (SEC-2).
 */

const testFile = join(tmpdir(), `adf-timer-loop-stamp-${Date.now()}.adf`)
let ws: AdfWorkspace | undefined
let skipAll = false

try {
  ws = AdfWorkspace.create(testFile, { name: 'timer-loop-stamp-test' })
} catch {
  skipAll = true
}

function cleanup(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
}

describe.skipIf(skipAll)('addTimer loop stamp', () => {
  afterAll(() => {
    ws?.close()
    cleanup()
  })

  const soon = (): number => Date.now() + 3_600_000

  function loopOf(id: number): string | undefined {
    return ws!.getTimers().find(t => t.id === id)?.loop
  }

  it('main may stamp a timer with another loop', () => {
    const id = ws!.addTimer({ mode: 'once', at: soon() }, soon(), 'p', ['agent'], undefined, undefined, undefined, 'reflector')
    expect(loopOf(id)).toBe('reflector')
  })

  it('main without an override still stamps main', () => {
    const id = ws!.addTimer({ mode: 'once', at: soon() }, soon(), 'p', ['agent'])
    expect(loopOf(id)).toBe('main')
  })

  it('a side-loop view forces its own stamp and ignores an override', () => {
    const scoped = ws!.forLoop('reflector')
    const id = scoped.addTimer({ mode: 'once', at: soon() }, soon(), 'p', ['agent'], undefined, undefined, undefined, 'critic')
    expect(loopOf(id)).toBe('reflector')
  })

  it('a side-loop view stamps itself with no override at all', () => {
    const scoped = ws!.forLoop('critic')
    const id = scoped.addTimer({ mode: 'once', at: soon() }, soon(), 'p', ['agent'])
    expect(loopOf(id)).toBe('critic')
  })
})
