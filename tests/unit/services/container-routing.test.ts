import { describe, it, expect } from 'vitest'
import { shouldContainerize, hostDenialReason, type ComputeSettings } from '../../../src/main/services/container-routing'
import type { AgentConfig, McpServerConfig } from '../../../src/shared/types/adf-v02.types'

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: 'resolve', transport: 'stdio', command: '/usr/local/bin/resolve-mcp', ...overrides }
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: 'editor', ...overrides } as AgentConfig
}

const settings = (overrides: Partial<ComputeSettings> = {}): ComputeSettings => ({
  hostAccessEnabled: true,
  hostApproved: [],
  ...overrides
})

describe('shouldContainerize', () => {
  it('containerizes by default when host is not requested', () => {
    expect(shouldContainerize('resolve', server(), agent(), settings())).toBe(true)
  })

  it('containerizes when the master host toggle is off, even with agent host_access', () => {
    const cfg = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
    expect(shouldContainerize('resolve', server({ run_location: 'host' }), cfg, settings({ hostAccessEnabled: false }))).toBe(true)
  })

  it('runs on host when the agent has compute.host_access without per-name approval', () => {
    const cfg = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
    expect(shouldContainerize('resolve', server({ run_location: 'host' }), cfg, settings())).toBe(false)
  })

  it('runs on host via the hostApproved list for agents without host_access', () => {
    expect(shouldContainerize('resolve', server({ run_location: 'host' }), agent(), settings({ hostApproved: ['resolve'] }))).toBe(false)
  })

  it('containerizes host-requested servers with neither host_access nor approval', () => {
    expect(shouldContainerize('resolve', server({ run_location: 'host' }), agent(), settings())).toBe(true)
  })

  it('honors legacy host_requested flag', () => {
    const cfg = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
    expect(shouldContainerize('resolve', server({ host_requested: true }), cfg, settings())).toBe(false)
  })

  describe('hostApproved source matching (name-squat guard)', () => {
    const approved = settings({
      hostApproved: ['resolve'],
      hostApprovedSources: { resolve: 'npm:@real/resolve-mcp' },
    })

    it('grants host when the package matches the recorded source', () => {
      const cfg = server({ run_location: 'host', npm_package: '@real/resolve-mcp', source: 'npm:@real/resolve-mcp' })
      expect(shouldContainerize('resolve', cfg, agent(), approved)).toBe(false)
    })

    it('grants host on derived identity when config lacks an explicit source', () => {
      const cfg = server({ run_location: 'host', npm_package: '@real/resolve-mcp' })
      expect(shouldContainerize('resolve', cfg, agent(), approved)).toBe(false)
    })

    it('containerizes a squatted name backed by a different package', () => {
      const squat = server({ run_location: 'host', npm_package: '@evil/other-mcp', source: 'npm:@evil/other-mcp' })
      expect(shouldContainerize('resolve', squat, agent(), approved)).toBe(true)
    })

    it('keeps legacy name-only semantics when no source was recorded', () => {
      const legacy = settings({ hostApproved: ['resolve'] })
      const cfg = server({ run_location: 'host', npm_package: '@any/package' })
      expect(shouldContainerize('resolve', cfg, agent(), legacy)).toBe(false)
    })

    it('agent host_access is unaffected by source matching', () => {
      const cfg = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
      const squat = server({ run_location: 'host', npm_package: '@evil/other-mcp' })
      expect(shouldContainerize('resolve', squat, cfg, approved)).toBe(false)
    })
  })
})

describe('hostDenialReason', () => {
  it('returns null when host was not requested', () => {
    expect(hostDenialReason('resolve', server(), agent(), settings())).toBeNull()
  })

  it('returns null when host was granted', () => {
    const cfg = agent({ compute: { host_access: true } } as Partial<AgentConfig>)
    expect(hostDenialReason('resolve', server({ run_location: 'host' }), cfg, settings())).toBeNull()
  })

  it('reports the disabled master toggle', () => {
    expect(hostDenialReason('resolve', server({ run_location: 'host' }), agent(), settings({ hostAccessEnabled: false })))
      .toMatch(/host access is disabled app-wide/)
  })

  it('reports missing host_access and approval', () => {
    expect(hostDenialReason('resolve', server({ run_location: 'host' }), agent(), settings()))
      .toMatch(/host_access.*not host-approved/)
  })

  it('reports a source mismatch when a squatted name misses the recorded package', () => {
    const approved = settings({
      hostApproved: ['resolve'],
      hostApprovedSources: { resolve: 'npm:@real/resolve-mcp' },
    })
    const squat = server({ run_location: 'host', npm_package: '@evil/other-mcp', source: 'npm:@evil/other-mcp' })
    expect(hostDenialReason('resolve', squat, agent(), approved))
      .toMatch(/host-approved for npm:@real\/resolve-mcp.*resolves to npm:@evil\/other-mcp.*does not transfer/s)
  })
})
