import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Capture execFile options; never run a real process.
const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
  cb(null, '', '')
})
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  const refuse = () => { throw new Error('test tried to spawn a process') }
  return { ...real, execFile, spawn: refuse, execFileSync: refuse }
})

const { PodmanService, podmanCwd } = await import('../../../src/main/services/podman.service')

describe('podman machine commands on Windows (stray NUL file)', () => {
  it('run machine subcommands from a private temp dir on Windows', async () => {
    const dir = await podmanCwd(['machine', 'ssh', 'date +%s'], 'win32')
    expect(dir).toBe(join(tmpdir(), 'adf-podman-machine'))
    expect(existsSync(dir!)).toBe(true)
  })

  it('leave every other call, and every other platform, in the inherited cwd', async () => {
    expect(await podmanCwd(['ps', '-a'], 'win32')).toBeUndefined()
    expect(await podmanCwd(['machine', 'ssh', 'date +%s'], 'darwin')).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('exec0 passes that cwd to the podman process', async () => {
    const svc = new PodmanService()
    await (svc as unknown as { exec0: (c: string, a: string[]) => Promise<unknown> }).exec0('/fake/podman', ['machine', 'ssh', 'date +%s'])
    await (svc as unknown as { exec0: (c: string, a: string[]) => Promise<unknown> }).exec0('/fake/podman', ['ps'])
    expect((execFile.mock.calls[0][2] as { cwd?: string }).cwd).toBe(join(tmpdir(), 'adf-podman-machine'))
    expect((execFile.mock.calls[1][2] as { cwd?: string }).cwd).toBeUndefined()
  })
})
