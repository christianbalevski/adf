import { describe, it, expect, vi, beforeEach } from 'vitest'

const check = vi.fn()
vi.mock('../../../src/main/services/podman-bootstrap', async (orig) => ({
  ...(await orig<object>()),
  checkPodmanAvailability: () => check(),
}))

const { PodmanService } = await import('../../../src/main/services/podman.service')

const missing = { available: false, binPath: null, prerequisites: [], installMethods: [] }

describe('PodmanService.findPodman', () => {
  beforeEach(() => { check.mockReset(); vi.useRealTimers() })

  it('caches a miss so a missing Podman is not re-probed on every call', async () => {
    check.mockResolvedValue(missing)
    const svc = new PodmanService()
    expect(await Promise.all([svc.findPodman(), svc.findPodman()])).toEqual([null, null])
    expect(await svc.findPodman()).toBeNull()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('re-probes after the miss expires', async () => {
    vi.useFakeTimers()
    check.mockResolvedValueOnce(missing).mockResolvedValueOnce({ ...missing, available: true, binPath: 'podman' })
    const svc = new PodmanService()
    expect(await svc.findPodman()).toBeNull()
    vi.advanceTimersByTime(61_000)
    expect(await svc.findPodman()).toBe('podman')
    expect(await svc.findPodman()).toBe('podman')
    expect(check).toHaveBeenCalledTimes(2)
  })
})
