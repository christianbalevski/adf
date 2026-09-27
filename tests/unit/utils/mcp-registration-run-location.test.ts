import { describe, expect, it } from 'vitest'
import {
  buildMcpServerConfigFromRegistration,
  reconcileHostApprovedRegistrations,
} from '../../../src/shared/utils/mcp-config'
import {
  hostDenialReason,
  isServerForceShared,
  shouldContainerize,
  shouldIsolate,
  type ComputeSettings,
} from '../../../src/main/services/container-routing'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

function reg(partial: Partial<McpServerRegistration>): McpServerRegistration {
  return { id: `mcp:${partial.name ?? 'x'}`, name: 'x', ...partial }
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: 'editor', ...overrides } as AgentConfig
}

function computeSettings(overrides: Partial<ComputeSettings> = {}): ComputeSettings {
  return { hostAccessEnabled: false, hostApproved: [], ...overrides }
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

  it('leaves run_location unset when the registration records none (the install default — containerized at routing time)', () => {
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'gh', type: 'npm', npmPackage: '@x/gh' }))
    expect(cfg.run_location).toBeUndefined()
    expect(shouldContainerize('gh', cfg, agent(), computeSettings())).toBe(true)
  })

  it('containerizes a no-run-location server even when every host gate is open', () => {
    // The default is not a denied host request — there is no host request at
    // all, so neither the app-wide toggle nor agent host_access can move it.
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'gh', type: 'npm', npmPackage: '@x/gh' }))
    const wideOpen = computeSettings({ hostAccessEnabled: true, hostApproved: ['gh'] })
    const privileged = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
    expect(shouldContainerize('gh', cfg, privileged, wideOpen)).toBe(true)
    expect(hostDenialReason('gh', cfg, privileged, wideOpen)).toBeNull()
  })

  it('preserves an explicitly recorded run_location instead of re-defaulting it', () => {
    // Servers installed before the container default keep whatever the user's
    // Settings choice recorded — nothing migrates them.
    const host = buildMcpServerConfigFromRegistration(reg({ name: 'legacy-host', type: 'npm', npmPackage: '@x/legacy', runLocation: 'host' }))
    expect(host.run_location).toBe('host')
    const privileged = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
    expect(shouldContainerize('legacy-host', host, privileged, computeSettings({ hostAccessEnabled: true }))).toBe(false)

    const shared = buildMcpServerConfigFromRegistration(reg({ name: 'legacy-shared', type: 'npm', npmPackage: '@x/legacy', runLocation: 'shared' }))
    expect(shared.run_location).toBe('shared')
    expect(isServerForceShared(shared)).toBe(true)
  })

  it('does not force the shared container for a default (no-run-location) server', () => {
    // An explicit 'shared' pins the server to the SHARED container, overriding
    // an agent's own isolated container — which is why the default stays absent
    // (the browser MCPs' managed Chromium lives in that isolated container).
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'playwright', type: 'npm', npmPackage: '@playwright/mcp' }))
    expect(isServerForceShared(cfg)).toBe(false)
    expect(shouldIsolate(agent({ compute: { enabled: true, browser: true } } as Partial<AgentConfig>))).toBe(true)
  })

  it('still honours the legacy host_requested flag on an old config', () => {
    const cfg = buildMcpServerConfigFromRegistration(reg({ name: 'gh', type: 'npm', npmPackage: '@x/gh' }))
    const legacy = { ...cfg, host_requested: true }
    const privileged = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
    expect(shouldContainerize('gh', legacy, privileged, computeSettings({ hostAccessEnabled: true }))).toBe(false)
    // …and the app-wide toggle still overrides it.
    expect(shouldContainerize('gh', legacy, privileged, computeSettings({ hostAccessEnabled: false }))).toBe(true)
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
