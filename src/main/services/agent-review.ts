import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type {
  AgentConfigSummary,
  ReviewEnvelopeState,
  ReviewIdentitySummary,
} from '../../shared/types/ipc.types'

type ReviewedAgentMap = Record<string, string>

/**
 * Read reviewedAgents from settings, handling both the array form and the
 * legacy Record<string, string> form (values were previously config hashes).
 */
export function getReviewedIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.keys(raw as ReviewedAgentMap)
  }
  return []
}

/**
 * An agent is reviewed if the user has ever accepted its review. Subsequent
 * config changes do not re-trigger review — accepting a foreign ADF once is
 * enough.
 */
export function isConfigReviewed(raw: unknown, config: AgentConfig): boolean {
  return getReviewedIds(raw).includes(config.id)
}

export function markConfigReviewed(raw: unknown, config: AgentConfig): ReviewedAgentMap {
  const existing = Array.isArray(raw)
    ? Object.fromEntries(raw.map((id) => [String(id), 'accepted']))
    : raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as ReviewedAgentMap
      : {}
  return {
    ...existing,
    [config.id]: 'accepted',
  }
}

export interface ReviewIdentityInput {
  agentDid: string | null
  fileOwnerDid: string | null
  fileRuntimeDid: string | null
  localOwnerDid: string
  localRuntimeDid: string
  identityEnvelope: ReviewEnvelopeState
  credentialsEnvelope: ReviewEnvelopeState
  sharePasswordSet: boolean
  /** Owner encryption key is derivable (seed phrase present on this install). */
  ownerKeyAvailable: boolean
}

/**
 * Classify how a file's identity relates to the local owner (spec D10/D11).
 *
 * A file without identity keys is 'unclaimed' even when its adf_owner_did
 * meta matches the local owner: meta alone is forgeable, and the owner
 * attestation that would prove it cannot exist without an agent DID to be
 * its subject. Stripping identity must never shortcut review.
 */
export function deriveReviewIdentity(input: ReviewIdentityInput): ReviewIdentitySummary {
  const credentialsLocked =
    input.credentialsEnvelope === 'locked' || input.credentialsEnvelope === 'foreign'

  let scenario: ReviewIdentitySummary['scenario']
  let seedUnavailable = false

  if (!input.agentDid) {
    scenario = 'unclaimed'
  } else if (input.fileOwnerDid && input.fileOwnerDid === input.localOwnerDid) {
    const identityLocked =
      input.identityEnvelope === 'locked' || input.identityEnvelope === 'foreign'
    scenario =
      identityLocked || (input.fileRuntimeDid && input.fileRuntimeDid !== input.localRuntimeDid)
        ? 'recognized'
        : 'mine'
    seedUnavailable = identityLocked && !input.ownerKeyAvailable
  } else {
    scenario = 'foreign'
  }

  return {
    agentDid: input.agentDid,
    fileOwnerDid: input.fileOwnerDid,
    ownerIsYou: !!input.fileOwnerDid && input.fileOwnerDid === input.localOwnerDid,
    scenario,
    needsClaim: scenario === 'foreign' || scenario === 'unclaimed',
    sharePasswordSet: input.sharePasswordSet,
    credentialsLocked,
    seedUnavailable,
  }
}

/** Tools that warrant amber highlight in the review screen. */
const NOTABLE_TOOLS = new Set([
  'compute_exec', 'sys_code', 'sys_lambda', 'fs_transfer',
  'mcp_install', 'mcp_restart', 'mcp_uninstall', 'sys_fetch', 'db_execute',
  'sys_create_adf', 'adf_shell',
])

/**
 * Build a flattened, presentation-oriented summary of an agent config
 * for the review dialog.
 */
export function buildConfigSummary(
  config: AgentConfig,
  identity: ReviewIdentitySummary
): AgentConfigSummary {
  // Determine compute tier
  let computeTier: AgentConfigSummary['computeTier'] = 'shared'
  if (config.compute?.enabled) {
    computeTier = config.compute.host_access ? 'host' : 'isolated'
  }

  // Tools
  const tools = (config.tools ?? []).map((t) => ({
    name: t.name,
    enabled: t.enabled,
    notable: NOTABLE_TOOLS.has(t.name),
  }))

  // MCP servers
  const mcpServers = (config.mcp?.servers ?? []).map((s) => ({
    name: s.name,
    npmPackage: s.npm_package,
    pypiPackage: s.pypi_package,
    runLocation: s.run_location ?? (s.host_requested ? 'host' : undefined),
  }))

  // Triggers
  const triggers = Object.entries(config.triggers ?? {}).map(([type, cfg]) => ({
    type,
    enabled: !!cfg?.enabled,
    targetCount: cfg?.targets?.length ?? 0,
  }))

  // Code execution
  const enabledTools = new Set((config.tools ?? []).filter((t) => t.enabled).map((t) => t.name))
  const codeExecution = enabledTools.has('sys_code') || enabledTools.has('sys_lambda')

  // Messaging
  const messaging = {
    mode: config.messaging?.mode ?? 'proactive',
  }

  // Network
  const wsConnections = (config.ws_connections ?? []).map((ws) => ({
    url: ws.url,
    did: ws.did,
    id: ws.id,
  }))

  const serving = config.serving?.api?.length
    ? { routeCount: config.serving.api.length }
    : null

  const adapters = config.adapters
    ? Object.keys(config.adapters)
    : []

  const tableProtections = Object.entries(config.security?.table_protections ?? {})
    .flatMap(([table, protection]) => protection && protection !== 'none'
      ? [{ table, protection }]
      : []
    )
    .sort((a, b) => a.table.localeCompare(b.table))

  return {
    name: config.name,
    description: config.description,
    identity,
    computeTier,
    autostart: config.autostart ?? false,
    tools,
    mcpServers,
    triggers,
    codeExecution,
    messaging,
    network: {
      wsConnections,
      serving,
      adapters,
    },
    security: {
      tableProtections,
    },
  }
}

/**
 * Determine which fields to auto-lock when the user accepts a review.
 * Always locks compute; conditionally locks ws_connections and adapters.
 */
export function autoLockFields(config: AgentConfig): string[] {
  const fields = ['compute']

  if (config.ws_connections?.length) {
    fields.push('ws_connections')
  }

  if (config.adapters && Object.keys(config.adapters).length > 0) {
    fields.push('adapters')
  }

  if (Object.keys(config.security?.table_protections ?? {}).length > 0) {
    fields.push('security.table_protections')
  }

  return fields
}
