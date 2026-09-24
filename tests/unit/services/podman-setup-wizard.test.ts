import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const availabilityMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: execFileMock }
})

vi.mock('../../../src/main/services/podman-bootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/services/podman-bootstrap')>()
  return { ...actual, checkPodmanAvailability: availabilityMock }
})

import { PodmanService } from '../../../src/main/services/podman.service'
import {
  PODMAN_MACOS_INSTALLER_URL,
  findHomebrew,
  getInstallMethods,
} from '../../../src/main/services/podman-bootstrap'
import { DEFAULT_COMPUTE_SETTINGS } from '../../../src/shared/constants/compute-defaults'

type ExecCallback = (error: (Error & { code?: string }) | null, stdout: string, stderr: string) => void

function execSucceeds(): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => cb(null, '', ''))
}

beforeEach(() => {
  execFileMock.mockReset()
  availabilityMock.mockReset()
  availabilityMock.mockResolvedValue({ available: true, binPath: '/opt/podman/bin/podman', prerequisites: [], installMethods: [] })
})

describe('getInstallMethods (macOS)', () => {
  it('runs Homebrew by absolute path when it is installed', () => {
    const exists = (p: string) => p === '/usr/local/bin/brew'
    expect(findHomebrew(exists)).toBe('/usr/local/bin/brew')
    expect(getInstallMethods('darwin', exists)).toEqual([
      { command: '/usr/local/bin/brew install podman', label: 'Install via Homebrew', autoRunnable: true },
    ])
  })

  it('prefers the Apple Silicon Homebrew prefix', () => {
    expect(findHomebrew(() => true)).toBe('/opt/homebrew/bin/brew')
  })

  it('points at the official installer when Homebrew is missing', () => {
    expect(getInstallMethods('darwin', () => false)).toEqual([
      { command: PODMAN_MACOS_INSTALLER_URL, label: 'Download the Podman installer', autoRunnable: false },
    ])
  })
})

describe('PodmanService.setup', () => {
  it('initializes the machine with the configured size', async () => {
    execSucceeds()
    const service = new PodmanService()
    service.setSettingsAccessor(() => ({ ...DEFAULT_COMPUTE_SETTINGS, machineCpus: 6, machineMemoryMb: 8192 }))

    const result = await service.setup('machine_init')

    expect(result.success).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      '/opt/podman/bin/podman',
      ['machine', 'init', '--memory', '8192', '--cpus', '6'],
      expect.anything(),
      expect.any(Function),
    )
  })

  it('names the missing binary when the install command is not found', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      const err = Object.assign(new Error('spawn brew ENOENT'), { code: 'ENOENT' })
      cb(err, '', '')
    })
    const result = await new PodmanService().setup('install', 'brew install podman')
    expect(result).toEqual({ success: false, error: '`brew` was not found' })
  })

  it('rejects an unknown step instead of starting the machine', async () => {
    execSucceeds()
    const result = await new PodmanService().setup('bogus' as never)
    expect(result).toEqual({ success: false, error: 'Unknown step: bogus' })
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
