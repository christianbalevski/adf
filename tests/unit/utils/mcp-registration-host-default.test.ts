import { describe, expect, it } from 'vitest'
import {
  buildMcpServerConfigFromRegistration,
  reconcileHostApprovedRegistrations,
} from '../../../src/shared/utils/mcp-config'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

function reg(partial: Partial<McpServerRegistration>): McpServerRegistration {
  return { id: `mcp:${partial.name ?? 'x'}`, name: 'x', ...partial }
}

describe('buildMcpServerConfigFromRegistration run location', () => {
  it('maps registration runLocation host to run_location host', () => {
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'gh', type: 'npm', npmPackage: '@x/gh', runLocation: 'host' }))
    expect(cfg.run_location).toBe('host')
  })

  it('maps registration runLocation shared to run_location shared', () => {
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'gh', type: 'npm', npmPackage: '@x/gh', runLocation: 'shared' }))
    expect(cfg.run_location).toBe('shared')
  })

  it('leaves run_location unset for legacy registrations (containerized default at routing time)', () => {
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'gh', type: 'npm', npmPackage: '@x/gh' }))
    expect(cfg.run_location).toBeUndefined()
  })

  it('ignores runLocation for http servers (remote — no local run location)', () => {
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'remote', type: 'http', url: 'https://mcp.example.com/x', runLocation: 'host' }))
    expect(cfg.transport).toBe('http')
    expect(cfg.run_location).toBeUndefined()
  })
})

describe('reconcileHostApprovedRegistrations', () => {
  const host = (name: string) => reg({ name, type: 'npm', npmPackage: `@x/${name}`, runLocation: 'host' })
  const shared = (name: string) => reg({ name, type: 'npm', npmPackage: `@x/${name}`, runLocation: 'shared' })

  it('adds a newly added host registration and records its source', () => {
    expect(reconcileHostApprovedRegistrations([], [host('gh')], []))
      .toEqual({ approved: ['gh'], sources: { gh: 'npm:@x/gh' } })
  })

  it('adds on transition to host', () => {
    expect(reconcileHostApprovedRegistrations([shared('gh')], [host('gh')], []).approved).toEqual(['gh'])
  })

  it('removes name and source on transition away from host', () => {
    expect(reconcileHostApprovedRegistrations([host('gh')], [shared('gh')], ['gh', 'other'], { gh: 'npm:@x/gh' }))
      .toEqual({ approved: ['other'], sources: {} })
  })

  it('removes when a host registration is deleted', () => {
    expect(reconcileHostApprovedRegistrations([host('gh')], [], ['gh'], { gh: 'npm:@x/gh' }))
      .toEqual({ approved: [], sources: {} })
  })

  it('keeps manual approvals untouched when no transition involves them', () => {
    expect(reconcileHostApprovedRegistrations([host('gh')], [host('gh')], ['manual', 'gh']).approved).toEqual(['manual', 'gh'])
  })

  it('does not re-add a manually removed name without a fresh transition', () => {
    // User removed 'gh' in Settings → Compute; registration stays host-located.
    expect(reconcileHostApprovedRegistrations([host('gh')], [host('gh')], []).approved).toEqual([])
  })

  it('refreshes the recorded source when a still-approved host registration changes package', () => {
    const before = host('gh')
    const after = reg({ name: 'gh', type: 'npm', npmPackage: '@y/gh-next', runLocation: 'host' })
    expect(reconcileHostApprovedRegistrations([before], [after], ['gh'], { gh: 'npm:@x/gh' }).sources)
      .toEqual({ gh: 'npm:@y/gh-next' })
  })

  it('never treats http registrations as host', () => {
    const httpReg = reg({ name: 'remote', type: 'http', url: 'https://mcp.example.com/x', runLocation: 'host' })
    expect(reconcileHostApprovedRegistrations([], [httpReg], [])).toEqual({ approved: [], sources: {} })
  })

  it('deleting a non-host registration leaves the list alone', () => {
    expect(reconcileHostApprovedRegistrations([shared('gh')], [], ['gh']).approved).toEqual(['gh'])
  })
})
