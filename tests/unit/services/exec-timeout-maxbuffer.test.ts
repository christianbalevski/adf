/**
 * Only execFile's own `timeout` is a timeout — output over `maxBuffer` is not.
 * podman's exec0 and the external container runner both report `timedOut`
 * through killedByTimeout. (Node 22/24 already leave `killed` unset on the
 * maxBuffer error; these tests pin the behaviour either way.)
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { killedByTimeout } from '../../../src/main/utils/exec-timeout'
import { PodmanService } from '../../../src/main/services/podman.service'

const run = (args: string[], opts: { timeout?: number; maxBuffer?: number }) =>
  new Promise<Error | null>((resolve) => { execFile(process.execPath, args, opts, (error) => resolve(error)) })

/** Reaches the protected exec0 — the real one, no podman needed for a plain binary. */
class ExecProbe extends PodmanService {
  probe(cmd: string, args: string[], timeout: number) { return this.exec0(cmd, args, timeout) }
}

describe('timeout vs maxBuffer on execFile', () => {
  it('a timeout is a timeout', async () => {
    const error = await run(['-e', 'setTimeout(() => {}, 5000)'], { timeout: 200 })
    expect(killedByTimeout(error)).toBe(true)
  })

  it('output over maxBuffer is not a timeout', async () => {
    const error = await run(['-e', 'process.stdout.write("x".repeat(64 * 1024))'], { timeout: 10_000, maxBuffer: 1024 })
    expect((error as { code?: unknown } | null)?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(killedByTimeout(error)).toBe(false)
    // Even if a Node release marked that error killed, it stays a non-timeout.
    expect(killedByTimeout(Object.assign(error!, { killed: true }))).toBe(false)
  })

  it('podman exec0 does not report output over its default maxBuffer (1 MiB) as a timeout', async () => {
    const result = await new ExecProbe().probe(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'], 10_000)
    expect(result.code).toBe(1)
    expect(result.timedOut).toBe(false)
  })

  it('podman exec0 still reports its own timeout', async () => {
    const result = await new ExecProbe().probe(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], 200)
    expect(result.timedOut).toBe(true)
  })
})
