import { describe, expect, it } from 'vitest'

import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { shouldContainerize, type ComputeSettings } from '../../../src/main/services/container-routing'
import type { AgentConfig, McpServerConfig } from '../../../src/shared/types/adf-v02.types'

/**
 * Daemon-path host routing: getComputeRoutingSettings() is the ComputeSettings
 * the AgentRuntimeBuilder passes to shouldContainerize() at both the connect
 * and auth-preflight sites. It must carry hostApprovedSources through — the
 * per-package squat guard for host-approved NAMES. Dropping it degrades every
 * approval to legacy name-only trust, letting a non-host-access agent squat a
 * host-approved name with a different package and run on the host.
 */

function builderWithCompute(compute: unknown): AgentRuntimeBuilder {
  return new AgentRuntimeBuilder({
    settings: { get: (key: string) => (key === 'compute' ? compute : undefined) },
  })
}

function routingSettings(builder: AgentRuntimeBuilder): ComputeSettings {
  return (builder as unknown as { getComputeRoutingSettings(): ComputeSettings }).getComputeRoutingSettings()
}

/** Agent WITHOUT compute.host_access — the allowlist is its only host route. */
const agentConfig = { compute: {} } as AgentConfig

describe('AgentRuntimeBuilder.getComputeRoutingSettings — host-approval squat guard', () => {
  it('carries hostApprovedSources through so a squatting package is containerized (no mcpServers registration)', () => {
    const builder = builderWithCompute({
      hostAccessEnabled: true,
      hostApproved: ['x'],
      hostApprovedSources: { x: 'npm:real-pkg' },
    })
    const settings = routingSettings(builder)
    expect(settings.hostApprovedSources).toEqual({ x: 'npm:real-pkg' })

    // .adf server squatting the host-approved NAME 'x' with a different
    // package and run_location host — must stay containerized.
    const squatter: McpServerConfig = {
      name: 'x',
      transport: 'stdio',
      npm_package: 'evil-pkg',
      run_location: 'host',
    }
    expect(shouldContainerize('x', squatter, agentConfig, settings)).toBe(true)

    // The genuinely approved package still runs on the host.
    const genuine: McpServerConfig = {
      name: 'x',
      transport: 'stdio',
      npm_package: 'real-pkg',
      run_location: 'host',
    }
    expect(shouldContainerize('x', genuine, agentConfig, settings)).toBe(false)
  })

  it('keeps legacy name-only trust for approved names without a recorded source', () => {
    const builder = builderWithCompute({ hostAccessEnabled: true, hostApproved: ['legacy'] })
    const settings = routingSettings(builder)
    expect(settings.hostApprovedSources).toBeUndefined()
    const server: McpServerConfig = {
      name: 'legacy',
      transport: 'stdio',
      npm_package: 'whatever-pkg',
      run_location: 'host',
    }
    expect(shouldContainerize('legacy', server, agentConfig, settings)).toBe(false)
  })

  it('defensively drops a non-object hostApprovedSources and filters non-string values', () => {
    expect(routingSettings(builderWithCompute({
      hostAccessEnabled: true,
      hostApproved: ['x'],
      hostApprovedSources: ['npm:not-a-map'],
    })).hostApprovedSources).toBeUndefined()

    const settings = routingSettings(builderWithCompute({
      hostAccessEnabled: true,
      hostApproved: ['x', 'y'],
      hostApprovedSources: { x: 'npm:real-pkg', y: 42, z: null },
    }))
    expect(settings.hostApprovedSources).toEqual({ x: 'npm:real-pkg' })
  })

  it('defaults sanely with no compute settings at all', () => {
    const settings = routingSettings(new AgentRuntimeBuilder())
    expect(settings).toEqual({ hostAccessEnabled: false, hostApproved: [] })
  })
})
