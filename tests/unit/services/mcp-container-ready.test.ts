import { describe, expect, it } from 'vitest'
import { ComputeUnavailableError, computeGap, prepareMcpContainer } from '../../../src/main/services/mcp-container-ready'
import type { PodmanAvailability } from '../../../src/shared/types/compute.types'

const avail = (over: Partial<PodmanAvailability> = {}): PodmanAvailability =>
  ({ available: true, machineRequired: true, machineExists: true, machineRunning: true, platform: 'darwin', installMethods: [], prerequisites: [], ...over })

describe('computeGap', () => {
  it('names the first missing piece of the compute environment', () => {
    expect(computeGap(avail({ available: false }))).toBe('Podman is not installed')
    expect(computeGap(avail({ prerequisites: [{ id: 'wsl', name: 'WSL', installed: false }] }))).toBe('WSL is not installed')
    expect(computeGap(avail({ machineExists: false, machineRunning: false }))).toBe("Podman's machine is not set up or not responding")
    expect(computeGap(avail({ machineRunning: false }))).toBe("Podman's machine is not running")
    expect(computeGap(avail())).toBeNull()
    expect(computeGap(avail({ machineRequired: false, machineExists: undefined, machineRunning: undefined }))).toBeNull()
  })
})

describe('prepareMcpContainer', () => {
  const podman = (bin: string | null) => ({ findPodman: async () => bin })

  it('starts the container and returns the podman binary', async () => {
    let started = false
    expect(await prepareMcpContainer(podman('/usr/bin/podman'), 'files', async () => { started = true }, async () => avail())).toBe('/usr/bin/podman')
    expect(started).toBe(true)
  })

  it('a missing compute environment is a ComputeUnavailableError naming the gap', async () => {
    const err = await prepareMcpContainer(podman(null), 'files', async () => { throw new Error('podman: not found') }, async () => avail({ available: false }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ComputeUnavailableError)
    // The container's own error is kept, for diagnosis.
    expect((err as Error).message).toBe('MCP server "files" runs in a container, and the compute environment is not ready: Podman is not installed (podman: not found). The owner can set it up, or let this server run on the host, in ADF Studio; then call mcp_restart("files") to reconnect.')
  })

  it('a stopped machine is a ComputeUnavailableError too', async () => {
    await expect(prepareMcpContainer(podman('/usr/bin/podman'), 'files', async () => { throw new Error('cannot connect') }, async () => avail({ machineRunning: false })))
      .rejects.toBeInstanceOf(ComputeUnavailableError)
  })

  it('any other container failure stays a plain error with its detail', async () => {
    const err = await prepareMcpContainer(podman('/usr/bin/podman'), 'files', async () => { throw new Error('image pull failed.') }, async () => avail())
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(ComputeUnavailableError)
    expect((err as Error).message).toBe('MCP container for "files" is not ready: image pull failed. Once the compute environment is fixed, call mcp_restart("files") to reconnect.')
  })

  it('an availability check that fails reports the container error', async () => {
    const err = await prepareMcpContainer(podman('/usr/bin/podman'), 'files', async () => { throw new Error('boom') }, async () => { throw new Error('no podman') })
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(ComputeUnavailableError)
  })

  it('no podman binary after a start is a ComputeUnavailableError', async () => {
    await expect(prepareMcpContainer(podman(null), 'files', async () => {}, async () => avail())).rejects.toBeInstanceOf(ComputeUnavailableError)
  })
})
