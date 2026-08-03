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
      .toMatch(/disabled in Studio settings/)
  })

  it('reports missing host_access and approval', () => {
    expect(hostDenialReason('resolve', server({ run_location: 'host' }), agent(), settings()))
      .toMatch(/host_access.*not host-approved/)
  })
})
