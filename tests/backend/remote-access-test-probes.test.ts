/**
 * The fenced test seam ADF_TEST_REMOTE_ACCESS_PROBES (src/main/daemon/remote-access/test-probes.ts):
 * honoured only with the variable, the test-seam gate and the parity fence's
 * mark; it replaces the network probes with "nothing found" and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { PARITY_FENCE_MARK, REMOTE_ACCESS_PROBES_ENV, remoteAccessTestProbes } from '../../src/main/daemon/remote-access/test-probes'

describe('the remote-access probe seam', () => {
  it('is not honoured without the variable, without ADF_TEST_SEAMS=1, or outside the fence; each refusal is logged', () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    expect(remoteAccessTestProbes({}, log, true)).toEqual({})
    expect(lines).toEqual([])
    expect(remoteAccessTestProbes({ [REMOTE_ACCESS_PROBES_ENV]: '1' }, log, true)).toEqual({})
    expect(remoteAccessTestProbes({ [REMOTE_ACCESS_PROBES_ENV]: '1', ADF_TEST_SEAMS: '1' }, log, false)).toEqual({})
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.includes(`Ignoring ${REMOTE_ACCESS_PROBES_ENV}`))).toBe(true)
    // The mark is the fence's, unset here.
    expect((globalThis as Record<symbol, unknown>)[PARITY_FENCE_MARK]).toBeUndefined()
    expect(remoteAccessTestProbes({ [REMOTE_ACCESS_PROBES_ENV]: '1', ADF_TEST_SEAMS: '1' }, log)).toEqual({})
  })

  it('fenced: no interface, no Tailscale, no announcement, the firewall not checked; nothing else is replaced', async () => {
    const lines: string[] = []
    const probes = remoteAccessTestProbes({ [REMOTE_ACCESS_PROBES_ENV]: '1', ADF_TEST_SEAMS: '1' }, (l) => lines.push(l), true)
    expect(Object.keys(probes).sort()).toEqual(['announcer', 'firewall', 'gateways', 'interfaces', 'osCategories', 'tailscale', 'wifiNames'])
    expect(probes.interfaces!()).toEqual({})
    expect(await probes.tailscale!.self()).toEqual({ state: 'absent', ips: [], dnsName: null })
    expect(await probes.tailscale!.whois('100.64.0.1')).toBeNull()
    await expect(probes.tailscale!.setServe(7385, true)).rejects.toThrow()
    expect(probes.announcer!.announcing).toBe(false)
    expect(await probes.firewall!({ port: 1 })).toMatchObject({ state: 'unknown' })
    expect([...(await probes.gateways!([], {}))]).toEqual([])
    expect(lines).toEqual([expect.stringContaining('Test seam')])
  })
})
