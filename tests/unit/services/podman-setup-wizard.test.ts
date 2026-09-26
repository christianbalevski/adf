import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  isExecutableFile,
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
    expect(findHomebrew(exists, '')).toBe('/usr/local/bin/brew')
    expect(getInstallMethods('darwin', () => false, '', exists)).toEqual([
      { command: '/usr/local/bin/brew install podman', label: 'Install via Homebrew', autoRunnable: true },
    ])
  })

  it('prefers the Apple Silicon Homebrew prefix', () => {
    expect(findHomebrew(() => true, '')).toBe('/opt/homebrew/bin/brew')
  })

  it('finds Homebrew in a custom prefix on PATH', () => {
    const exists = (p: string) => p === '/Users/me/homebrew/bin/brew'
    expect(findHomebrew(exists, '/usr/bin:/Users/me/homebrew/bin')).toBe('/Users/me/homebrew/bin/brew')
    expect(getInstallMethods('darwin', () => false, '/usr/bin:/Users/me/homebrew/bin', exists)[0]).toMatchObject({
      command: '/Users/me/homebrew/bin/brew install podman',
      autoRunnable: true,
    })
  })

  it('uses POSIX PATH rules on any host and skips relative entries', () => {
    // Runs the same on a Windows dev box: ':' separators and '/' joins.
    const seen: string[] = []
    const exists = (p: string) => { seen.push(p); return p === '/opt/brew/bin/brew' }
    expect(findHomebrew(exists, '.:bin:/opt/brew/bin')).toBe('/opt/brew/bin/brew')
    expect(seen.filter((p) => !p.startsWith('/'))).toEqual([])
  })

  it('offers the installer as a link, not a command, when Homebrew is missing', () => {
    expect(getInstallMethods('darwin', () => false, '', () => false)).toEqual([
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

describe('isExecutableFile', () => {
  it.skipIf(process.platform === 'win32')('accepts only executable regular files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-brew-probe-'))
    mkdirSync(join(dir, 'a-directory'))
    writeFileSync(join(dir, 'not-executable'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'executable'), '#!/bin/sh\n')
    chmodSync(join(dir, 'executable'), 0o755)
    expect(isExecutableFile(join(dir, 'a-directory'))).toBe(false)
    expect(isExecutableFile(join(dir, 'not-executable'))).toBe(false)
    expect(isExecutableFile(join(dir, 'missing'))).toBe(false)
    expect(isExecutableFile(join(dir, 'executable'))).toBe(true)
  })
})

describe('machineSize', () => {
  const host = { memoryMb: 16384, cpus: 8 }

  it('uses valid settings and falls back on missing or bogus values', () => {
    expect(machineSize({ machineMemoryMb: 8192, machineCpus: 6 }, host)).toEqual({ memoryMb: 8192, cpus: 6 })
    expect(machineSize({ machineMemoryMb: '4096' as never, machineCpus: 4 }, host)).toEqual({ memoryMb: 4096, cpus: 4 })
    const defaults = machineSize({ machineMemoryMb: 0, machineCpus: 0 }, host)
    expect(machineSize({ machineMemoryMb: 'abc' as never, machineCpus: -2 }, host)).toEqual(defaults)
    expect(machineSize({ machineMemoryMb: 1.5, machineCpus: undefined as never }, host)).toEqual(defaults)
  })

  it('falls back when a value exceeds what this host has', () => {
    const defaults = machineSize({ machineMemoryMb: 0, machineCpus: 0 }, host)
    expect(machineSize({ machineMemoryMb: 99_999_999, machineCpus: 64 }, host)).toEqual(defaults)
    expect(machineSize({ machineMemoryMb: 16384, machineCpus: 8 }, host)).toEqual({ memoryMb: 16384, cpus: 8 })
  })
})

describe('PodmanService.setup', () => {
  it('initializes the machine with the configured size', async () => {
    execSucceeds()
    const service = new PodmanService()
    service.setSettingsAccessor(() => ({ ...DEFAULT_COMPUTE_SETTINGS, machineCpus: 1, machineMemoryMb: 1024 }))

    const result = await service.setup('machine_init')

    expect(result.success).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      '/opt/podman/bin/podman',
      ['machine', 'init', '--memory', '1024', '--cpus', '1'],
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
    expect(result).toEqual({ success: false, error: 'Install command is not one this runtime can run automatically' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('starts the machine, treating a capitalised "already running" as success', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error('exit 125')), '', 'Error: Machine "podman-machine-default" Already Running'))
    const result = await new PodmanService().setup('machine_start')
    expect(result.success).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith('/opt/podman/bin/podman', ['machine', 'start'], expect.anything(), expect.any(Function))
  })

  it('explains a machine failure with empty stderr from the exec error, once', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error('spawn /opt/podman/bin/podman ENOENT'), { code: 'ENOENT' }), '', ''))
    const init = await new PodmanService().setup('machine_init')
    expect(init.error).toBe('podman machine init failed: `/opt/podman/bin/podman` was not found')

    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error(''), { code: 1 as never }), '', ''))
    const start = await new PodmanService().setup('machine_start')
    expect(start.error).toBe('podman machine start failed')
  })

  it('rejects an unknown step before probing for Podman', async () => {
    execSucceeds()
    const result = await new PodmanService().setup('bogus' as never)
    expect(result).toEqual({ success: false, error: 'Unknown step: bogus' })
    expect(availabilityMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
