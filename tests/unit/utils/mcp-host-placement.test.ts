/**
 * "Runs on" as Studio shows it (mcp-host-placement.ts) is the runtime's own
 * routing (container-routing.ts): every combination of the agent's choice,
 * its host access, the runtime switch and the approval list agrees. The
 * agent's chip changes only the agent; Allow is the one write to the
 * runtime's approval, and it records the package.
 */
import { describe, expect, it } from 'vitest'
import { shouldContainerize, shouldIsolate } from '../../../src/main/services/container-routing'
import { agentServerPlacement, allowHostPatch, allowHostTip, registrationPlacement } from '../../../src/shared/utils/mcp-host-placement'
import type { AgentConfig, McpServerConfig } from '../../../src/shared/types/adf-v02.types'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

const server = (over: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ name: 'files', transport: 'stdio', command: 'npx', npm_package: '@scope/files', ...over }) as McpServerConfig

describe('an agent server\'s Runs on', () => {
  it('matches container-routing for every combination', () => {
    for (const run_location of [undefined, 'shared', 'host'] as const) {
      for (const enabled of [false, true]) {
        for (const host_access of [false, true]) {
          for (const hostAccessEnabled of [false, true]) {
            for (const approved of [[], ['files']]) {
              for (const sources of [undefined, { files: 'npm:@scope/files' }, { files: 'npm:@other/files' }]) {
                const s = server({ run_location })
                const agent = { compute: { enabled, host_access } } as unknown as AgentConfig
                const runtime = { hostAccessEnabled, hostApproved: approved, hostApprovedSources: sources }
                const got = agentServerPlacement(s, agent, runtime)
                const onHost = !shouldContainerize(s.name, s, agent, runtime)
                const expected = onHost ? 'Host' : run_location === 'shared' || !shouldIsolate(agent) ? 'Shared' : 'Isolated'
                expect(got.runsOn, JSON.stringify({ run_location, enabled, host_access, runtime })).toBe(expected)
                expect(got.gap === null, 'gap only while a host choice is held back').toBe(run_location !== 'host' || onHost)
              }
            }
          }
        }
      }
    }
  })

  it('says which approval is missing', () => {
    const s = server({ run_location: 'host' })
    expect(agentServerPlacement(s, { compute: { host_access: true } }, { hostAccessEnabled: false, hostApproved: [] }).gap).toBe('host-access')
    expect(agentServerPlacement(s, {}, { hostAccessEnabled: true, hostApproved: [] }).gap).toBe('server')
    expect(allowHostTip('host-access')).toMatch(/Settings → Compute/)
    expect(allowHostTip('server')).toMatch(/Settings → Compute/)
  })
})

describe('Allow', () => {
  it('turns the switch on, and approves the server for its package only when the agent has no host access', () => {
    const runtime = { hostAccessEnabled: false, hostApproved: ['other'], hostApprovedSources: { other: 'npm:other' } }
    expect(allowHostPatch('files', 'npm:@scope/files', false, runtime)).toEqual({ hostAccessEnabled: true })
    expect(allowHostPatch('files', 'npm:@scope/files', true, runtime)).toEqual({
      hostAccessEnabled: true,
      hostApproved: ['other', 'files'],
      hostApprovedSources: { other: 'npm:other', files: 'npm:@scope/files' },
    })
  })
})

describe('a Settings → MCP registration\'s Runs on', () => {
  const reg = (over: Partial<McpServerRegistration> = {}): McpServerRegistration =>
    ({ id: 'reg-1', name: 'files', type: 'npm', npmPackage: '@scope/files', runLocation: 'host', ...over }) as McpServerRegistration

  it('host only when chosen, switched on, and approved for its package', () => {
    expect(registrationPlacement(reg({ runLocation: undefined }), { hostAccessEnabled: true, hostApproved: ['files'] })).toEqual({ runsOnHost: false, gap: null })
    expect(registrationPlacement(reg(), { hostAccessEnabled: false, hostApproved: ['files'] })).toEqual({ runsOnHost: false, gap: 'host-access' })
    expect(registrationPlacement(reg(), { hostAccessEnabled: true, hostApproved: [] })).toEqual({ runsOnHost: false, gap: 'server' })
    expect(registrationPlacement(reg(), { hostAccessEnabled: true, hostApproved: ['files'], hostApprovedSources: { files: 'npm:@other/files' } }).runsOnHost).toBe(false)
    expect(registrationPlacement(reg(), { hostAccessEnabled: true, hostApproved: ['files'], hostApprovedSources: { files: 'npm:@scope/files' } })).toEqual({ runsOnHost: true, gap: null })
    expect(registrationPlacement(reg({ type: 'http', url: 'https://mcp.example.com' }), { hostAccessEnabled: true, hostApproved: ['files'] }).runsOnHost).toBe(false)
  })
})

describe('the agent Config chip', () => {
  it('writes only the agent; the runtime approval changes only through a confirmed Allow', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../../../src/renderer/components/agent/AgentConfig.tsx'), 'utf-8')
    expect(src).not.toContain('Auto-update Settings host approval list')
    expect(src).not.toContain('compute.hostApproved = approved')
    expect(src).toContain('await confirmHost({')
    expect(src).toContain('agentServerPlacement(s, local, runtimeApproval)')
  })
})
