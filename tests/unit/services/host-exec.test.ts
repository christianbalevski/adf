import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hostExec, killAllHostExecs } from '../../../src/main/services/host-exec.service'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('hostExec', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'host-exec-test-'))

  afterAll(async () => {
    await killAllHostExecs(2000)
    rmSync(workDir, { recursive: true, force: true })
  })

  it('returns stdout and exit code 0 for a successful command', async () => {
    const result = await hostExec(workDir, 'echo hello-host', 10_000)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello-host')
  })

  it('preserves nonzero exit codes', async () => {
    const result = await hostExec(workDir, 'exit 7', 10_000)
    expect(result.code).toBe(7)
  })

  it('reports timeout with code 124, a clear message, and kills the process tree', async () => {
    const marker = join(workDir, 'grandchild-alive.log').replace(/\\/g, '/')
    // Background grandchild appends forever; foreground sleeps past the timeout.
    const command = `(while true; do echo x >> "${marker}"; sleep 0.2; done) & sleep 30`
    const result = await hostExec(workDir, command, 1500)

    expect(result.code).toBe(124)
    expect(result.stderr).toContain('timed out after 1500ms')
    expect(result.stderr).toContain('process tree was terminated')

    // Tree-kill proof: the grandchild must stop appending to the marker file.
    await sleep(1500) // let taskkill /T (or SIGTERM->SIGKILL) finish
    const sizeAfterKill = statSync(marker).size
    await sleep(1000)
    expect(statSync(marker).size).toBe(sizeAfterKill)
  }, 20_000)

  it('killAllHostExecs terminates live children and their promises resolve', async () => {
    const pending = hostExec(workDir, 'sleep 30', 60_000)
    await sleep(500) // let the shell spawn
    await killAllHostExecs(5000)
    const result = await pending
    expect(result.code).not.toBe(0)
  }, 20_000)
})
