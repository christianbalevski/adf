import { describe, expect, it } from 'vitest'
import { computeSetupPlan } from '../../../src/renderer/components/mcp/compute-setup-plan'
import type { PodmanAvailability } from '../../../src/shared/types/compute.types'

const avail = (over: Partial<PodmanAvailability> = {}): PodmanAvailability =>
  ({ available: true, machineRequired: true, machineExists: true, machineRunning: true, platform: 'darwin', installMethods: [], prerequisites: [], ...over })

describe('computeSetupPlan', () => {
  it('installs with the first method ADF can run itself', () => {
    const plan = computeSetupPlan(avail({
      available: false,
      installMethods: [
        { command: '', url: 'https://podman.io/docs/installation', label: 'Download', autoRunnable: false },
        { command: 'brew install podman', label: 'Homebrew', autoRunnable: true },
      ],
    }))
    expect(plan).toEqual({ kind: 'step', next: { step: 'install', installCommand: 'brew install podman', label: 'Installing Podman' } })
  })

  it('an installer that needs the user (a .pkg, an admin password) is manual, with its link', () => {
    const plan = computeSetupPlan(avail({ available: false, installMethods: [{ command: '', url: 'https://podman.io/docs/installation', label: 'Download', autoRunnable: false }] }))
    expect(plan).toMatchObject({ kind: 'manual', url: 'https://podman.io/docs/installation' })
  })

  it('a missing prerequisite (WSL) is manual and points at Settings → Compute', () => {
    const plan = computeSetupPlan(avail({ available: false, prerequisites: [{ id: 'wsl', name: 'WSL', installed: false, docsUrl: 'https://learn.microsoft.com/windows/wsl/install' }] }))
    expect(plan).toEqual({ kind: 'manual', reason: 'Podman needs WSL first. Set it up in Settings → Compute.', url: 'https://learn.microsoft.com/windows/wsl/install' })
  })

  it('then the machine: set up, then started', () => {
    expect(computeSetupPlan(avail({ machineExists: false, machineRunning: false }))).toMatchObject({ kind: 'step', next: { step: 'machine_init' } })
    expect(computeSetupPlan(avail({ machineRunning: false }))).toMatchObject({ kind: 'step', next: { step: 'machine_start' } })
  })

  it('ready when installed and running, or when no machine is needed (Linux)', () => {
    expect(computeSetupPlan(avail())).toEqual({ kind: 'ready' })
    expect(computeSetupPlan(avail({ machineRequired: false, machineExists: undefined, machineRunning: undefined, platform: 'linux' }))).toEqual({ kind: 'ready' })
  })
})
