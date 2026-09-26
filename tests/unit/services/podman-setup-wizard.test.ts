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

import { PodmanService, machineSize } from '../../../src/main/services/podman.service'
import {
  PODMAN_MACOS_INSTALL_DOCS_URL,
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

  it('finds Homebrew in a custom prefix on PATH', () => {
    const exists = (p: string) => p === '/Users/me/homebrew/bin/brew'
    expect(findHomebrew(exists, '/usr/bin:/Users/me/homebrew/bin')).toBe('/Users/me/homebrew/bin/brew')
    expect(getInstallMethods('darwin', exists, '/usr/bin:/Users/me/homebrew/bin')[0]).toMatchObject({
      command: '/Users/me/homebrew/bin/brew install podman',
      autoRunnable: true,
    })
  })

  it('offers the installer as a link, not a command, when Homebrew is missing', () => {
    expect(getInstallMethods('darwin', () => false, '')).toEqual([
      { command: '', url: PODMAN_MACOS_INSTALL_DOCS_URL, label: 'Download the Podman installer', autoRunnable: false },
    ])
  })
})

describe('getInstallMethods (Windows, Linux)', () => {
  it('offers winget on Windows', () => {
    expect(getInstallMethods('win32', () => false, '')).toEqual([
      { command: 'winget install -e --id RedHat.Podman', label: 'Install via winget', autoRunnable: true },
    ])
  })

  it('lists the Linux package managers present, as manual commands', () => {
    const exists = (p: string) => p === '/usr/bin/dnf' || p === '/usr/bin/pacman'
    expect(getInstallMethods('linux', exists, '').map((m) => [m.command, m.autoRunnable])).toEqual([
      ['sudo dnf install -y podman', false],
      ['sudo pacman -S --noconfirm podman', false],
    ])
  })
})

describe('machineSize', () => {
  it('uses valid settings and falls back on missing or bogus values', () => {
    expect(machineSize({ machineMemoryMb: 8192, machineCpus: 6 })).toEqual({ memoryMb: 8192, cpus: 6 })
    expect(machineSize({ machineMemoryMb: '4096' as never, machineCpus: 4 })).toEqual({ memoryMb: 4096, cpus: 4 })
    const defaults = machineSize({ machineMemoryMb: 0, machineCpus: 0 })
    expect(machineSize({ machineMemoryMb: 'abc' as never, machineCpus: -2 })).toEqual(defaults)
    expect(machineSize({ machineMemoryMb: 1.5, machineCpus: undefined as never })).toEqual(defaults)
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
    availabilityMock.mockResolvedValue({
      available: false, binPath: null, prerequisites: [],
      installMethods: [{ command: '/opt/homebrew/bin/brew install podman', label: 'Install via Homebrew', autoRunnable: true }],
    })
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      const err = Object.assign(new Error('spawn /opt/homebrew/bin/brew ENOENT'), { code: 'ENOENT' })
      cb(err, '', '')
    })
    const result = await new PodmanService().setup('install', '/opt/homebrew/bin/brew install podman')
    expect(result).toEqual({ success: false, error: '`/opt/homebrew/bin/brew` was not found' })
  })

  it('refuses an install command the runtime did not offer', async () => {
    availabilityMock.mockResolvedValue({
      available: false, binPath: null, prerequisites: [],
      installMethods: [{ command: '/opt/homebrew/bin/brew install podman', label: 'Install via Homebrew', autoRunnable: true }],
    })
    const result = await new PodmanService().setup('install', '/bin/sh -c touch /tmp/pwned')
    expect(result).toEqual({ success: false, error: 'Install command is not one this runtime offers' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('starts the machine, treating a capitalised "already running" as success', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error('exit 125')), '', 'Error: Machine "podman-machine-default" Already Running'))
    const result = await new PodmanService().setup('machine_start')
    expect(result.success).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith('/opt/podman/bin/podman', ['machine', 'start'], expect.anything(), expect.any(Function))
  })

  it('rejects an unknown step before probing for Podman', async () => {
    execSucceeds()
    const result = await new PodmanService().setup('bogus' as never)
    expect(result).toEqual({ success: false, error: 'Unknown step: bogus' })
    expect(availabilityMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
