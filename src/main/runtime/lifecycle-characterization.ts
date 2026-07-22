import type {
  AgentCapability,
  AgentProfileName,
} from './agent-capability-profiles'

/**
 * A characterization may leave the migration only after the observed
 * difference is either removed or made explicit in the capability profile
 * table. There is intentionally no `pending` member in this production data
 * or its status type.
 */
export const LIFECYCLE_CHARACTERIZATION_TERMINAL_STATUSES = [
  'fixed',
  'declaredByProfile',
] as const

export type LifecycleCharacterizationStatus =
  (typeof LIFECYCLE_CHARACTERIZATION_TERMINAL_STATUSES)[number]

interface LifecycleCharacterizationBase {
  readonly id: string
  readonly observation: string
  readonly profiles: readonly AgentProfileName[]
  readonly reason: string
}

export type LifecycleCharacterizationEntry =
  | (LifecycleCharacterizationBase & {
      readonly status: 'fixed'
    })
  | (LifecycleCharacterizationBase & {
      readonly status: 'declaredByProfile'
      readonly capabilities: readonly AgentCapability[]
    })

/**
 * Terminal resolutions from the pre-unification path characterization.
 *
 * Keep differences here as data rather than weakening conformance assertions.
 * A genuine path difference belongs in AGENT_PROFILES; an accidental one must
 * be fixed before it can be recorded as terminal here.
 */
export const LIFECYCLE_CHARACTERIZATION_LEDGER = [
  {
    id: 'studio-foreground-construction',
    observation: 'Studio foreground constructed and wired its own executor.',
    profiles: ['studioForeground'],
    status: 'fixed',
    reason: 'Foreground fresh startup now uses the canonical assembled-agent recipe.',
  },
  {
    id: 'studio-background-construction',
    observation: 'Studio background construction maintained an independent lifecycle recipe.',
    profiles: ['studioBackground'],
    status: 'fixed',
    reason: 'Background fresh startup now uses the canonical assembled-agent recipe.',
  },
  {
    id: 'studio-host-handoff',
    observation: 'Foreground/background movement reconstructed or rewired runtime components.',
    profiles: ['studioForeground', 'studioBackground'],
    status: 'fixed',
    reason: 'Handoff transfers one stable assembled handle by detaching and attaching its host.',
  },
  {
    id: 'runtime-fallback-construction',
    observation: 'The RuntimeService fallback behaved like another construction path.',
    profiles: ['headlessLive'],
    status: 'fixed',
    reason: 'The compatibility fallback delegates to the same headlessLive assembler profile.',
  },
  {
    id: 'startup-once-semantics',
    observation: 'Startup evaluation and the default startup turn were owned by individual hosts.',
    profiles: ['studioForeground', 'studioBackground', 'daemon', 'headlessLive'],
    status: 'fixed',
    reason: 'The assembled handle owns startup once-semantics and pending-user-message suppression.',
  },
  {
    id: 'stale-turn-checkpoint-recovery',
    observation: 'Checkpoint recovery coverage differed between construction paths.',
    profiles: ['studioForeground', 'studioBackground', 'daemon', 'headlessLive', 'benchmark'],
    status: 'fixed',
    reason: 'Every executor created by the canonical assembler runs stale-checkpoint recovery.',
  },
  {
    id: 'daemon-umbilical-taps',
    observation: 'Daemon agents do not install Studio umbilical taps.',
    profiles: ['daemon'],
    status: 'declaredByProfile',
    capabilities: ['umbilicalTaps'],
    reason: 'The daemon profile explicitly disables the Studio-only tap subsystem.',
  },
  {
    id: 'headless-live-surface',
    observation: 'Live headless agents expose timers but omit host-integrated subsystems.',
    profiles: ['headlessLive'],
    status: 'declaredByProfile',
    capabilities: [
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
    ],
    reason: 'The exhaustive headlessLive profile declares its sync-safe compatibility surface.',
  },
  {
    id: 'benchmark-timer-policy',
    observation: 'Benchmarks omit timer polling that is enabled for live headless agents.',
    profiles: ['benchmark'],
    status: 'declaredByProfile',
    capabilities: ['timers'],
    reason: 'The benchmark profile explicitly disables timers to avoid polling overhead.',
  },
] as const satisfies readonly LifecycleCharacterizationEntry[]
