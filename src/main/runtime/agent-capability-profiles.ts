/**
 * Observable runtime subsystems controlled by an agent construction profile.
 *
 * Keep this list as the single capability inventory. The `satisfies` constraint
 * on AGENT_PROFILES deliberately makes adding an item here a compile error until
 * every construction path declares whether it supports the new subsystem.
 */
export const AGENT_CAPABILITIES = [
  'timers',
  'codeSystemScope',
  'compute',
  'mcp',
  'mcpManagementTools',
  'adapters',
  'npmTools',
  'shell',
  'streamBindings',
  'umbilicalTaps',
  'meshWebSocket',
] as const

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number]

export const AGENT_PROFILE_NAMES = [
  'studioForeground',
  'studioBackground',
  'daemon',
  'headlessLive',
  'benchmark',
] as const

export type AgentProfileName = (typeof AGENT_PROFILE_NAMES)[number]

export type AgentCapabilityProfile = Readonly<Record<AgentCapability, boolean>>

/**
 * Capabilities whose resources cannot be deterministically released by the
 * compatibility synchronous `dispose()` contract.
 */
export const ASYNC_TEARDOWN_CAPABILITIES: ReadonlySet<AgentCapability> = new Set([
  'compute',
  'mcp',
  'adapters',
  'streamBindings',
  'umbilicalTaps',
  'meshWebSocket',
])

export const AGENT_PROFILES = {
  studioForeground: {
    timers: true,
    codeSystemScope: true,
    compute: true,
    mcp: true,
    mcpManagementTools: true,
    adapters: true,
    npmTools: true,
    shell: true,
    streamBindings: true,
    umbilicalTaps: true,
    meshWebSocket: true,
  },
  studioBackground: {
    timers: true,
    codeSystemScope: true,
    compute: true,
    mcp: true,
    mcpManagementTools: true,
    adapters: true,
    npmTools: true,
    shell: true,
    streamBindings: true,
    umbilicalTaps: true,
    meshWebSocket: true,
  },
  daemon: {
    timers: true,
    codeSystemScope: true,
    compute: true,
    mcp: true,
    mcpManagementTools: true,
    adapters: true,
    npmTools: true,
    shell: true,
    streamBindings: true,
    umbilicalTaps: false,
    meshWebSocket: true,
  },
  headlessLive: {
    timers: true,
    codeSystemScope: false,
    compute: false,
    mcp: false,
    mcpManagementTools: false,
    adapters: false,
    npmTools: false,
    shell: false,
    streamBindings: false,
    umbilicalTaps: false,
    meshWebSocket: false,
  },
  benchmark: {
    timers: false,
    codeSystemScope: false,
    compute: false,
    mcp: false,
    mcpManagementTools: false,
    adapters: false,
    npmTools: false,
    shell: false,
    streamBindings: false,
    umbilicalTaps: false,
    meshWebSocket: false,
  },
} as const satisfies Record<AgentProfileName, Record<AgentCapability, boolean>>

export function profileHasAsyncTeardown(
  profile: AgentProfileName | AgentCapabilityProfile,
): boolean {
  const capabilities = typeof profile === 'string' ? AGENT_PROFILES[profile] : profile
  return AGENT_CAPABILITIES.some(
    capability => capabilities[capability] && ASYNC_TEARDOWN_CAPABILITIES.has(capability),
  )
}

export function isSyncSafeAgentProfile(
  profile: AgentProfileName | AgentCapabilityProfile,
): boolean {
  return !profileHasAsyncTeardown(profile)
}
