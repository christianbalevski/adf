import { describe, expect, it, vi, beforeEach } from 'vitest'

// No process may be spawned from this file: the fake podman answers every
// call, and anything that slips past it fails here instead of reaching a
// real podman (podman safety rule, incident 2026-10-14).
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  const refuse = () => { throw new Error('test tried to spawn a process') }
  return { ...real, execFile: refuse, spawn: refuse, execFileSync: refuse }
})

const { PodmanService } = await import('../../../src/main/services/podman.service')
const { FakePodman, installFakePodman } = await import('./fake-podman')

function sharedAndAgents(): InstanceType<typeof FakePodman> {
  return new FakePodman()
    .add({ name: 'adf-mcp' })
    .add({ name: 'adf-agent-1-11111111', agentId: '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111', agentName: 'agent-1' })
    .add({ name: 'adf-agent-2-22222222', agentId: '0b6a3c58-2222-4a40-9c55-3f0e0c3d2222', agentName: 'agent-2', running: false })
    .add({ name: 'adf-legacy', kind: 'legacy' })
}

describe('PodmanService shutdown, single runtime (characterization)', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  })

  it('stopAll stops every running managed container and leaves unmanaged ones', async () => {
    const svc = new PodmanService()
    const fake = installFakePodman(svc, sharedAndAgents())
    const statuses: string[] = []
    svc.on('status-changed', (s) => statuses.push(s.status))
    await svc.registerAgent('0b6a3c58-3333-4a40-9c55-3f0e0c3d3333').catch(() => {})

    await svc.stopAll()

    expect(fake.stopped().sort()).toEqual(['adf-agent-1-11111111', 'adf-mcp'])
    expect(fake.running()).toEqual(['adf-legacy'])
    expect(svc.getStatus()).toMatchObject({ status: 'stopped', activeAgents: [] })
    expect(statuses.at(-1)).toBe('stopped')
    expect(logs.some((l) => l.includes('adf-mcp') && l.includes('adf-agent-1-11111111'))).toBe(true)
  })

  it('stopAll marks every stopped container as stopped for the UI', async () => {
    const svc = new PodmanService()
    installFakePodman(svc, sharedAndAgents())
    const phases: Array<[string, string]> = []
    svc.on('container-phase', (e) => phases.push([e.containerName, e.phase]))

    await svc.stopAll()

    expect(phases.filter(([, p]) => p === 'stopped').map(([n]) => n).sort()).toEqual(['adf-agent-1-11111111', 'adf-mcp'])
  })

  it('stopAll with nothing running issues no stop', async () => {
    const svc = new PodmanService()
    const fake = installFakePodman(svc, new FakePodman().add({ name: 'adf-mcp', running: false }))
    await svc.stopAll()
    expect(fake.stopped()).toEqual([])
  })

  it('stopAll without podman is a no-op', async () => {
    const svc = new PodmanService()
    ;(svc as unknown as { findPodman: () => Promise<null> }).findPodman = async () => null
    await expect(svc.stopAll()).resolves.toBeUndefined()
  })

  it('stop() stops the shared container and clears active agents', async () => {
    const svc = new PodmanService()
    const fake = installFakePodman(svc, sharedAndAgents())
    await svc.registerAgent('0b6a3c58-3333-4a40-9c55-3f0e0c3d3333').catch(() => {})

    await svc.stop()

    expect(fake.stopped()).toEqual(['adf-mcp'])
    expect(fake.running()).toEqual(['adf-agent-1-11111111', 'adf-legacy'])
    expect(svc.getStatus()).toMatchObject({ status: 'stopped', activeAgents: [] })
  })
})
