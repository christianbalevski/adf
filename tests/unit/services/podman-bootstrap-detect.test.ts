import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: execFileMock }
})
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: () => 'darwin' as NodeJS.Platform }
})

import { checkPodmanAvailability } from '../../../src/main/services/podman-bootstrap'

type ExecCallback = (error: (Error & { code?: string }) | null, stdout: string, stderr: string) => void

beforeEach(() => {
  execFileMock.mockReset()
})

describe('checkPodmanAvailability (macOS)', () => {
  it('finds Podman installed by the podman.io .pkg at /opt/podman/bin', async () => {
    execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (cmd === 'which') return cb(Object.assign(new Error('not found'), { code: 1 as never }), '', '')
      if (cmd !== '/opt/podman/bin/podman') return cb(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }), '', '')
      if (args[0] === '--version') return cb(null, 'podman version 5.2.0', '')
      if (args[0] === 'machine') return cb(null, 'podman-machine-default\ttrue', '')
      return cb(null, '', '')
    })

    const info = await checkPodmanAvailability()

    expect(info.available).toBe(true)
    expect(info.binPath).toBe('/opt/podman/bin/podman')
    expect(info.version).toBe('5.2.0')
  })
})
