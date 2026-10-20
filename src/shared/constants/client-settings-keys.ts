import type { AppSettings } from '../types/ipc.types'

/**
 * Settings key classes for Studio on the daemon backend
 * (docs/design/daemon-backend.md §4.1).
 *
 * In embedded mode every key lives in `adf-settings.json` and Studio main is
 * its only writer. In daemon mode (`local` or `remote`) each file has one
 * writer (§4.2):
 *
 * - **Client** keys are Studio presentation and Studio-host behaviour. They
 *   live in `studio-client-settings.json` in Studio's userData, written by
 *   Studio main only, and never reach the daemon.
 * - **Backend** keys are read by the runtime, providers, MCP, adapters, mesh,
 *   review, compute or tracked directories. They live in the daemon's
 *   settings file and are read and written through `GET/PATCH /settings` and
 *   the dedicated routes. Studio main MUST NOT cache a backend key across
 *   calls in daemon mode: the daemon (and the CLI) can change it at any time,
 *   so a cached copy goes stale without any signal.
 *
 * The third class of §4.1, backend selection (`mode`, `keepDaemonRunning`,
 * remote URL and token), is not an `adf-settings.json` key at all; it lives in
 * `studio-backend.json` (src/main/backend/backend-config.ts).
 *
 * Every key read anywhere in `src/` MUST be in exactly one of the two lists
 * (tests/backend/settings-key-classes.test.ts), and every `AppSettings` member
 * MUST be classified (the compile-time check at the bottom of this file).
 */

export const CLIENT_SETTINGS_KEYS = [
  'theme',
  'uiFont',
  'uiFontCustom',
  // One-shot marker of migrateUiFontSystemDefault (settings-migrations.ts:101-117).
  // In daemon mode that migration MUST run on studio-client-settings.json
  // (W2-C): the daemon's file never holds uiFont.
  'uiFontSystemDefaultApplied',
  'uiScale',
  'agentAvatars',
  // Carries `burnTotals`, which the fleet-burn service hydrates from at boot
  // (ipc/index.ts:5866). In daemon mode the fleet-burn handler reads it from
  // the client file and passes it to the daemon route as a parameter.
  'fleetMapState',
  // The renderer writes fleetGroups, fleetStewards and fleetMapState through
  // setSettings; all three are AppSettings members.
  'fleetGroups',
  'fleetStewards',
  // The fleet map's groups, stewards and world of each runtime other than
  // This computer, by runtime id (docs/design/multi-runtime.md §7.4). Paths
  // on those runtimes: never handed to embedded Studio (CLIENT_FILE_ONLY_KEYS).
  'runtimeFleet',
  'onboardingSharedAt',
  // GET /templates reports `migrated` from the daemon's view of this key,
  // which never changes in daemon mode: the daemon-mode TEMPLATES_LIST
  // handler MUST drop `migrated` when the client file has it set.
  'templatesMigrationSeen',
  'nativeNotificationsEnabled',
  'menuBarEnabled',
  'recentFiles',
  // Remote mode's Open Recent: paths on the remote daemon's machine, kept
  // apart from `recentFiles` (CLIENT_FILE_ONLY_KEYS) so they never reach
  // embedded Studio, whose boot sweep and menu touch the paths (W5-D3).
  'remoteRecentFiles',
  'updateChecksEnabled',
  'spellcheckDownloadsEnabled',
  // The agent windows open at the last quit, for the runtime they belong to
  // (docs/design/agent-windows.md). Daemon mode only (CLIENT_FILE_ONLY_KEYS).
  'agentWindows',
] as const

export const BACKEND_SETTINGS_KEYS = [
  // Providers and agent creation defaults
  'providers',
  'defaultProviderId',
  'agentTemplate',
  'agentTemplateForChildren',
  'childTemplateId',
  'defaultTemplateId',
  'templatesMigratedAt',
  'openrouterMandatoryReasoningModels',
  // Prompts. The daemon reads these three once at boot (daemon/index.ts:176-178);
  // §4.2 makes reading them at use a W1-A deliverable.
  'globalSystemPrompt',
  'compactionPrompt',
  'toolPrompts',
  'autoApplyPromptUpdates',
  'promptDefaultsApplied',
  'autoCompactThreshold',
  // Network opt-outs for traffic the backend starts on its own
  'remoteCatalogsEnabled',
  'providerChecksEnabled',
  // Sandbox. `sandboxMaxWorkers` is applied live by embedded SETTINGS_SET and
  // read once at boot by the daemon (daemon/index.ts:183).
  'sandboxPackages',
  'sandboxMaxWorkers',
  // Agent files
  'trackedDirectories',
  'agentsFolder',
  'maxDirectoryScanDepth',
  'reviewedAgents',
  // Mesh and discovery
  'meshEnabled',
  'meshLan',
  'meshPort',
  'meshServerEnabled',
  'tailnetDiscovery',
  'meshManualPeers',
  'runtimeId',
  'runtimeAlias',
  'ownerAlias',
  'shareOwnerIdentity',
  // MCP, skills, channels, compute
  'mcpServers',
  'mcpOauthCredentials',
  // The terminal app reads it too (src/main/tui/skills/catalog.ts).
  'skillCatalogSources',
  'adapters',
  'compute',
  // Owner and runtime identity (§5). Key material never crosses HTTP
  // (SETTINGS_SECRET_KEYS, SETTINGS_WRITE_DENY_KEYS in daemon/http-api.ts).
  'ownerMnemonic',
  'ownerDid',
  'ownerDidSeedDerived',
  'ownerEncPublicKey',
  'ownerSeedBackupConfirmed',
  'runtimePrivateKey',
  'runtimeEncPrivateKey',
  'runtimeEncPublicKey',
  'runtimeDid',
  'runtimeDelegation',
  'legacyOwnerDids',
  'legacyRuntimeDids',
  'daemonRuntimeDid',
  'daemonRuntimeDelegation',
  // RUNTIME_KEY_MAP in daemon/daemon-identity.ts maps legacyRuntimeDids here.
  'daemonLegacyRuntimeDids',
  'trustedDaemonEncKeys',
] as const

/** Remote mode's recent files (menu.ts); never `recentFiles`. */
export const REMOTE_RECENT_FILES_KEY = 'remoteRecentFiles'

/**
 * Client keys that stay in `studio-client-settings.json` when Studio
 * switches back to embedded (handover.ts moveClientSettings): embedded never
 * reads them, and a remote daemon's paths must not become paths embedded
 * Studio opens or sweeps.
 */
export const CLIENT_FILE_ONLY_KEYS: readonly string[] = [REMOTE_RECENT_FILES_KEY, 'agentWindows', 'runtimeFleet']

/** The settings key of Open Recent: `recentFiles`, or `remoteRecentFiles` in remote mode. */
export function recentFilesKey(remote: boolean): 'recentFiles' | typeof REMOTE_RECENT_FILES_KEY {
  return remote ? REMOTE_RECENT_FILES_KEY : 'recentFiles'
}

export type ClientSettingsKey = (typeof CLIENT_SETTINGS_KEYS)[number]
export type BackendSettingsKey = (typeof BACKEND_SETTINGS_KEYS)[number]
export type SettingsKeyClass = 'client' | 'backend'

const CLIENT_SET: ReadonlySet<string> = new Set(CLIENT_SETTINGS_KEYS)
const BACKEND_SET: ReadonlySet<string> = new Set(BACKEND_SETTINGS_KEYS)

/** The class of a settings key, or null for a key in neither list. */
export function settingsKeyClass(key: string): SettingsKeyClass | null {
  if (CLIENT_SET.has(key)) return 'client'
  if (BACKEND_SET.has(key)) return 'backend'
  return null
}

// Compile-time check: a new AppSettings member that is in neither list makes
// `UnclassifiedAppSettingsKey` non-never, and this assignment fails to compile.
type UnclassifiedAppSettingsKey = Exclude<keyof AppSettings, ClientSettingsKey | BackendSettingsKey>
const appSettingsKeysClassified: [UnclassifiedAppSettingsKey] extends [never] ? true : UnclassifiedAppSettingsKey = true
void appSettingsKeysClassified
