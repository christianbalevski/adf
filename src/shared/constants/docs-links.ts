/**
 * Canonical URLs for the feature guides in `docs/guides/`, so the UI can point
 * at an explanation instead of carrying paragraphs of it.
 *
 * The rule the config panels follow:
 *   - a control's *units* or a one-clause hint stay inline next to the field
 *   - anything longer becomes an `InfoHint` tooltip on the label
 *   - the full story lives in the guide, reachable from the section header
 *
 * Anchors are GitHub's slugs for the guide's `##` headings (lowercased,
 * spaces to dashes, punctuation dropped). A wrong anchor still lands on the
 * right page, so prefer a specific one.
 */

export const REPO_URL = 'https://github.com/christianbalevski/adf'

const GUIDES_BASE = `${REPO_URL}/blob/main/docs/guides`

/** Build a guide URL: `guideUrl('tools', 'tool-locking')`. */
export function guideUrl(guide: string, anchor?: string): string {
  return anchor ? `${GUIDES_BASE}/${guide}.md#${anchor}` : `${GUIDES_BASE}/${guide}.md`
}

/**
 * Every docs target the UI links to, keyed by the surface that links to it.
 * Keep keys named after the panel section, not the guide — sections move
 * between guides more often than they get renamed.
 */
export const DOCS = {
  // Agent config sections
  index: guideUrl('index'),
  identity: guideUrl('security-and-identity', 'the-three-identities'),
  model: guideUrl('creating-agents', 'model-configuration'),
  recovery: guideUrl('agent-states'),
  instructions: guideUrl('creating-agents', 'instructions-system-prompt'),
  context: guideUrl('memory-management'),
  tools: guideUrl('tools'),
  toolAccess: guideUrl('tools', 'enabling-and-disabling-tools'),
  authorizedCode: guideUrl('authorized-code'),
  codeExecution: guideUrl('code-execution'),
  packages: guideUrl('code-execution', 'custom-packages'),
  compute: guideUrl('compute'),
  mcp: guideUrl('mcp-integration'),
  mcpAttach: guideUrl('mcp-integration', 'per-agent-server-attachment'),
  channels: guideUrl('channels'),
  messaging: guideUrl('messaging'),
  visibility: guideUrl('messaging', 'visibility-tiers'),
  contacts: guideUrl('contacts'),
  security: guideUrl('security-and-identity'),
  envelopes: guideUrl('security-and-identity', 'envelope-protection'),
  attestations: guideUrl('security-and-identity', 'attestations'),
  sharingAgents: guideUrl('security-and-identity', 'sharing-an-agent'),
  messageSecurity: guideUrl('security-and-identity', 'message-security'),
  triggers: guideUrl('triggers'),
  timers: guideUrl('timers'),
  tasks: guideUrl('tasks'),
  serving: guideUrl('serving'),
  websocket: guideUrl('websocket'),
  streamBindings: guideUrl('tools', 'stream-binding-tools'),
  umbilical: guideUrl('umbilical'),
  umbilicalEvents: guideUrl('umbilical-events'),
  logging: guideUrl('logging'),
  metadata: guideUrl('creating-agents', 'metadata'),
  limits: guideUrl('creating-agents', 'limits'),
  skills: guideUrl('skills'),
  memory: guideUrl('agent-memory'),
  files: guideUrl('documents-and-files'),
  browser: guideUrl('browser'),
  middleware: guideUrl('middleware'),
  fleetMap: guideUrl('fleet-map'),
  agentStates: guideUrl('agent-states'),
  lanDiscovery: guideUrl('lan-discovery'),

  // Settings tabs
  settings: guideUrl('settings'),
  settingsGeneral: guideUrl('settings', 'application-settings'),
  settingsSystemPrompt: guideUrl('settings', 'system-prompt'),
  settingsUsage: guideUrl('settings', 'token-usage'),
  settingsIdentity: guideUrl('settings', 'identity'),
  settingsProviders: guideUrl('settings', 'providers'),
  settingsPackages: guideUrl('code-execution', 'standard-library-packages'),
  settingsMcp: guideUrl('settings', 'mcp-servers'),
  settingsSkills: guideUrl('skills'),
  settingsChannels: guideUrl('settings', 'channel-adapters'),
  settingsNetworking: guideUrl('settings', 'web-mesh-server'),
  settingsCompute: guideUrl('compute', 'environments'),
  settingsGuard: guideUrl('settings', 'security-guard--locked-fields')
} as const

export type DocsKey = keyof typeof DOCS
