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
  loops: guideUrl('inner-loops'),
  authorizedCode: guideUrl('authorized-code'),
  codeExecution: guideUrl('code-execution'),
  packages: guideUrl('code-execution', 'custom-packages'),
  compute: guideUrl('compute'),
  mcp: guideUrl('mcp-integration'),
  mcpAttach: guideUrl('mcp-integration', 'per-agent-server-attachment'),
  mcpRunLocation: guideUrl('mcp-integration', 'run-location'),
  mcpAgentAccess: guideUrl('mcp-integration', 'making-settings-servers-available-to-agents'),
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
  preLlmHook: guideUrl('pre-llm-hook'),
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
  commands: guideUrl('commands'),
  skills: guideUrl('skills'),
  memory: guideUrl('agent-memory'),
  files: guideUrl('documents-and-files'),
  browser: guideUrl('browser'),
  middleware: guideUrl('middleware'),
  fleetMap: guideUrl('fleet-map'),
  agentStates: guideUrl('agent-states'),
  lanDiscovery: guideUrl('lan-discovery'),
  meshFirewall: guideUrl('lan-discovery', 'firewalls'),

  // Settings tabs
  settings: guideUrl('settings'),
  settingsGeneral: guideUrl('settings', 'studio'),
  settingsSystemPrompt: guideUrl('settings', 'system-prompt'),
  agentTemplates: guideUrl('agent-templates'),
  settingsUsage: guideUrl('settings', 'usage'),
  settingsIdentity: guideUrl('settings', 'identity'),
  settingsProviders: guideUrl('settings', 'providers'),
  settingsProviderCopies: guideUrl('settings', 'per-adf-provider-configurations'),
  settingsPackages: guideUrl('code-execution', 'standard-library-packages'),
  settingsMcp: guideUrl('settings', 'mcp-servers'),
  settingsSkills: guideUrl('skills'),
  settingsChannels: guideUrl('settings', 'channel-adapters'),
  settingsNetworking: guideUrl('settings', 'networking'),
  settingsCompute: guideUrl('compute', 'environments'),
  settingsGuard: guideUrl('settings', 'security-guard--locked-fields'),

  // Settings → Connections (docs/guides/studio-backend.md)
  backendConnection: guideUrl('studio-backend', 'connection'),
  backendAddConnection: guideUrl('studio-backend', 'add'),
  backendSwitch: guideUrl('studio-backend', 'switch-the-backend'),
  backendUpgrade: guideUrl('studio-backend', 'upgrading-from-07x'),
  backendStatus: guideUrl('studio-backend', 'local-server-status'),
  backendLocalServer: guideUrl('studio-backend', 'local-server'),
  backendRemoteServers: guideUrl('studio-backend', 'remote-servers'),
  backendQuit: guideUrl('studio-backend', 'quit-studio'),
  backendEmbedded: guideUrl('studio-backend', 'run-agents-inside-studio-when-the-daemon-does-not-work'),
  backendRemote: guideUrl('studio-backend', 'remote-computer'),

  // Remote access (Studio → Connections: Add → Share, Devices; the client side is Add → Connect)
  remoteAccess: guideUrl('studio-backend', 'remote-access'),
  remoteAccessPair: guideUrl('studio-backend', 'share'),
  remoteAccessDevices: guideUrl('studio-backend', 'devices'),
  networkingStatus: guideUrl('settings', 'network-status'),
  unidentifiedNetwork: guideUrl('settings', 'unidentified-network')
} as const

export type DocsKey = keyof typeof DOCS

/** docs/NETWORK.md, every connection Studio and the runtime make (Studio → Privacy). Not a guide, so not in DOCS. */
export const NETWORK_DOCS = `${REPO_URL}/blob/main/docs/NETWORK.md`

/**
 * Knowledge Base setup articles (docs/knowledge/) for curated MCP servers,
 * keyed by registry entry name. The Add MCP Server modal links the entry's
 * article in place of its generic guide.
 */
export const MCP_SETUP_DOCS: Record<string, string> = {
  gmail: `${REPO_URL}/blob/main/docs/knowledge/gmail-setup.md`,
}
