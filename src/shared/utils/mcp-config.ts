import type { McpEnvKeySchema, McpHeaderEnvSchema, McpServerConfig } from '../types/adf-v02.types'
import type { McpServerRegistration } from '../types/ipc.types'

type McpCredentialSource = Pick<McpServerConfig, 'name' | 'npm_package' | 'pypi_package'> | {
  name: string
  npmPackage?: string
  pypiPackage?: string
}

function sourcePackage(source: McpCredentialSource): string | undefined {
  return 'npm_package' in source
    ? source.npm_package ?? source.pypi_package
    : source.npmPackage ?? source.pypiPackage
}

export function mcpCredentialNamespace(source: McpCredentialSource): string {
  return sourcePackage(source) ?? source.name
}

export function mcpCredentialRef(source: McpCredentialSource, key: string): string {
  return `mcp:${mcpCredentialNamespace(source)}:${key}`
}

export function isSensitiveMcpHeader(header: string): boolean {
  const normalized = header.trim().toLowerCase()
  return normalized === 'authorization' ||
    normalized === 'proxy-authorization' ||
    normalized === 'x-api-key' ||
    normalized === 'api-key' ||
    normalized === 'apikey' ||
    normalized === 'x-auth-token' ||
    normalized === 'x-access-token' ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('credential')
}

export function buildEnvSchemaFromKeys(
  source: McpCredentialSource,
  keys: string[],
  scope: 'agent' | 'app',
  requiredKeys: string[] = keys
): McpEnvKeySchema[] {
  const required = new Set(requiredKeys)
  return [...new Set(keys.filter(Boolean))].map((key) => ({
    key,
    scope,
    required: required.has(key) || undefined,
    credential_ref: scope === 'app' ? mcpCredentialRef(source, key) : undefined,
  }))
}

export function buildHeaderEnvSchemaFromEntries(
  source: McpCredentialSource,
  entries: Array<{ header: string; env: string }>,
  appScoped = true
): McpHeaderEnvSchema[] {
  return entries
    .filter((entry) => entry.header && entry.env)
    .map((entry) => ({
      header: entry.header,
      env: entry.env,
      required: true,
      credential_ref: appScoped ? mcpCredentialRef(source, entry.env) : undefined,
    }))
}

export function getMcpRegistrationEnvKeys(registration: McpServerRegistration): string[] {
  return [...new Set([
    ...(registration.env ?? []).map((entry) => entry.key).filter(Boolean),
    ...(registration.bearerTokenEnvVar ? [registration.bearerTokenEnvVar] : []),
    ...(registration.headerEnv ?? []).map((entry) => entry.value).filter(Boolean),
  ])]
}

export function buildMcpServerConfigFromRegistration(registration: McpServerRegistration): McpServerConfig {
  const isHttp = registration.type === 'http' || !!registration.url
  const serverCfg: McpServerConfig = {
    name: registration.name,
    transport: isHttp ? 'http' : 'stdio',
  }

  if (isHttp) {
    serverCfg.url = registration.url
    serverCfg.source = registration.url ? `http:${registration.url}` : 'http'
    const staticHeaders: Record<string, string> = {}
    for (const { key, value } of registration.headers ?? []) {
      if (key && value && !isSensitiveMcpHeader(key)) staticHeaders[key] = value
    }
    if (Object.keys(staticHeaders).length) serverCfg.headers = staticHeaders
    if (registration.headerEnv?.length) {
      serverCfg.header_env = buildHeaderEnvSchemaFromEntries(
        registration,
        registration.headerEnv.map(({ key, value }) => ({ header: key, env: value })),
        (registration.credentialStorage ?? 'app') !== 'agent'
      )
    }
    if (registration.bearerTokenEnvVar) {
      serverCfg.bearer_token_env_var = registration.bearerTokenEnvVar
    }
  } else if (registration.npmPackage) {
    serverCfg.source = `npm:${registration.npmPackage}`
    serverCfg.npm_package = registration.npmPackage
  } else if (registration.pypiPackage) {
    serverCfg.source = `uvx:${registration.pypiPackage}`
    serverCfg.pypi_package = registration.pypiPackage
  } else {
    serverCfg.source = 'custom'
    serverCfg.command = registration.command
    serverCfg.args = registration.args
  }

  if (!isHttp) {
    if (registration.command) serverCfg.command = registration.command
    if (registration.args?.length) serverCfg.args = registration.args
  }

  const envKeys = getMcpRegistrationEnvKeys(registration)
  if (envKeys.length) {
    const scope = (registration.credentialStorage ?? 'app') === 'agent' ? 'agent' : 'app'
    if (scope === 'agent') serverCfg.env_keys = envKeys
    serverCfg.env_schema = buildEnvSchemaFromKeys(registration, envKeys, scope)
  }

  if (registration.toolCallTimeout) {
    serverCfg.tool_call_timeout_ms = registration.toolCallTimeout * 1000
  }

  // Registration-level run location (Settings installs default to host —
  // the user's explicit Settings choice is the trust decision). Meaningless
  // for HTTP servers, which run nowhere locally.
  if (!isHttp && registration.runLocation) {
    serverCfg.run_location = registration.runLocation
  }

  // Credential-file declarations travel to the agent config so materialization
  // and write-back work for attached servers (content stays out of settings —
  // it is captured per-agent into the identity keystore at auth/attach time).
  if (registration.credentialFiles?.length) {
    serverCfg.credential_files = registration.credentialFiles.map((f) => ({
      path: f.path,
      ...(f.required !== undefined ? { required: f.required } : {}),
      ...(f.writeBack !== undefined ? { write_back: f.writeBack } : {}),
    }))
  }

  return serverCfg
}

/**
 * Pin a connecting server's EXECUTABLE IDENTITY to its Settings registration.
 *
 * SECURITY: attach-mode exempts a Settings-registered, agent-visible server
 * from the per-agent `compute.host_access` check because the user's Settings
 * choice (name + source, host-approved) is the trust decision. But the host
 * grant is keyed on the registration's *source* string, and the `.adf` copy of
 * the server config is agent-writable (via `sys_update_config`). Without this
 * pinning, an agent could attach a host-approved server and then swap its
 * `command`/`args` (keeping `name`+`source`) to run arbitrary code on the host
 * with no `host_access`. So for any server whose name matches a registration,
 * the executable identity comes from the REGISTRATION, never the `.adf`:
 *   command, args, npm_package, pypi_package, source, url, transport,
 *   run_location, tool_call_timeout_ms, credential_files, headers, header_env,
 *   bearer_token_env_var, and app-scoped env_schema declarations.
 *
 * Agent-owned, non-executable state is preserved from the `.adf` connCfg:
 *   env (resolved values are merged in later), env_keys, agent-scoped
 *   env_schema entries (credentials the agent added for itself),
 *   available_tools (discovered), restricted.
 *
 * Returns a new object; never mutates either input.
 */
export function pinServerConfigToRegistration(
  connCfg: McpServerConfig,
  registration: McpServerRegistration,
): McpServerConfig {
  const canonical = buildMcpServerConfigFromRegistration(registration)
  // Preserve the agent's own agent-scoped env declarations; the registration
  // owns the app-scoped ones. (canonical.env_schema is app-scoped by build.)
  const agentEnvSchema = (connCfg.env_schema ?? []).filter((e) => e.scope === 'agent')
  const mergedEnvSchema = [
    ...(canonical.env_schema ?? []),
    ...agentEnvSchema.filter(
      (a) => !(canonical.env_schema ?? []).some((c) => c.key === a.key && c.scope === a.scope),
    ),
  ]
  const pinned: McpServerConfig = {
    ...canonical,
    // Agent-owned state kept from the .adf copy:
    env: connCfg.env,
    env_keys: connCfg.env_keys,
    available_tools: connCfg.available_tools,
    restricted: connCfg.restricted,
    ...(mergedEnvSchema.length ? { env_schema: mergedEnvSchema } : {}),
  }
  return pinned
}

/**
 * Suggested "Available to agents" default by location: container/http servers
 * are attachable by default; host servers are not — a host server attachable
 * by any autonomous agent is the bigger grant, so enabling it is a conscious
 * act.
 */
export function suggestedAgentVisible(reg: Pick<McpServerRegistration, 'type' | 'url' | 'runLocation'>): boolean {
  const isHttp = reg.type === 'http' || !!reg.url
  if (isHttp) return true
  return reg.runLocation !== 'host'
}

/** Effective agent-attachability of a registration (explicit choice wins, else the suggested default). */
export function isRegistrationAgentVisible(reg: McpServerRegistration): boolean {
  return reg.agentVisible ?? suggestedAgentVisible(reg)
}

/**
 * Executable-identity fields of a registration — the fields that determine
 * WHAT actually launches. A "verified" stamp (lastVerifiedAt/version) must
 * never vouch for a config whose executable identity changed after the test,
 * so every stamp site guards on these: the modal's patch() clears the stamp
 * when one changes, and the async stamp paths (Connect success, Reconnect
 * success, managed-install version patch) compare against the tested identity
 * via sameExecutableIdentity before applying.
 */
export const MCP_EXECUTABLE_IDENTITY_FIELDS = ['type', 'url', 'command', 'args', 'npmPackage', 'pypiPackage'] as const

export type McpExecutableIdentity = Pick<McpServerRegistration, (typeof MCP_EXECUTABLE_IDENTITY_FIELDS)[number]>

/** Do two registrations launch the same thing? Args compared by value (absent ≡ empty). */
export function sameExecutableIdentity(a: McpExecutableIdentity, b: McpExecutableIdentity): boolean {
  const argsA = a.args ?? []
  const argsB = b.args ?? []
  return a.type === b.type &&
    a.url === b.url &&
    a.command === b.command &&
    a.npmPackage === b.npmPackage &&
    a.pypiPackage === b.pypiPackage &&
    argsA.length === argsB.length &&
    argsA.every((arg, i) => arg === argsB[i])
}

// Dirty-state contract for the Add/Configure form: keep `agentVisible`
// undefined until the user touches the toggle. The displayed value is
// `isRegistrationAgentVisible(draft)`, so a location flip re-suggests the
// default automatically while an explicit choice (defined) always sticks.

export interface RegistrationTestPlan {
  /** Where the connect test runs. */
  location: 'host' | 'shared container' | 'remote http'
  /** Whether the auth preflight runs during the Settings test. */
  authMode: 'run' | 'skip' | 'none'
  /** Whether provided credential-file contents are written during the test. */
  materializeFiles: boolean
  /** Human-readable caveats surfaced alongside the test result. */
  notes: string[]
}

/**
 * What the Settings "Connect" test can meaningfully verify for a registration.
 *
 * Host-located servers get the full pipeline: credential files land in the
 * real host home (the server's actual runtime store) and auth tokens persist
 * there durably. Container-located servers connect inside the shared
 * container under an ephemeral test home, so auth and credential capture are
 * deferred to per-agent attach — running them in the test would store tokens
 * in a home that is cleaned up afterwards.
 */
export function deriveRegistrationTestPlan(
  reg: McpServerRegistration,
  opts?: { hostAccessEnabled?: boolean },
): RegistrationTestPlan {
  const isHttp = reg.type === 'http' || !!reg.url
  if (isHttp) {
    return { location: 'remote http', authMode: 'none', materializeFiles: false, notes: [] }
  }
  if (reg.runLocation === 'host') {
    // The Connect test must honor the app-wide host-access disable, exactly
    // like actual routing does — otherwise it would spawn on the host while
    // the modal tells the user the server "will be containerized until host
    // access is enabled". Any falsy value (absent key included) counts as
    // disabled, matching shouldContainerize's `!settings.hostAccessEnabled`.
    // When disabled, the test runs in the shared container instead.
    if (!opts?.hostAccessEnabled) {
      const notes = ['Host access is disabled app-wide — this test ran in the shared container. Enable host access in Settings → Compute to test on the host.']
      if (reg.auth) notes.push('Authorization for containerized servers happens per-agent when an agent attaches this server.')
      return { location: 'shared container', authMode: reg.auth ? 'skip' : 'none', materializeFiles: false, notes }
    }
    return {
      location: 'host',
      authMode: reg.auth ? 'run' : 'none',
      materializeFiles: true,
      notes: [],
    }
  }
  const notes: string[] = []
  if (reg.auth) notes.push('Authorization for containerized servers happens per-agent when an agent attaches this server.')
  if (reg.credentialFiles?.length) notes.push('Credential files for containerized servers are captured per-agent at attach; this test verifies the package launches and lists tools.')
  return { location: 'shared container', authMode: reg.auth ? 'skip' : 'none', materializeFiles: false, notes }
}

/**
 * Transition-based sync of compute.hostApproved with Settings registrations.
 *
 * The user's explicit run-location choice in Settings IS the host-trust
 * decision, so:
 *  - a registration that appears with (or switches to) runLocation 'host'
 *    adds its name to the approved list;
 *  - a registration that switches away from 'host' — or is deleted while
 *    host-located — removes its name.
 *
 * Only *transitions* are acted on: names the user added or removed manually
 * in Settings → Compute are left alone (manual edits win).
 */
/** The recorded source identity of a registration (mirrors buildMcpServerConfigFromRegistration). */
export function registrationSourceIdentity(reg: McpServerRegistration): string {
  if (reg.type === 'http' || reg.url) return reg.url ? `http:${reg.url}` : 'http'
  if (reg.npmPackage) return `npm:${reg.npmPackage}`
  if (reg.pypiPackage) return `uvx:${reg.pypiPackage}`
  return 'custom'
}

export interface HostApprovalState {
  approved: string[]
  /** name → source identity recorded at approval time (host-grant squat guard). */
  sources: Record<string, string>
}

export function reconcileHostApprovedRegistrations(
  prev: McpServerRegistration[],
  next: McpServerRegistration[],
  approved: string[],
  approvedSources?: Record<string, string>,
): HostApprovalState {
  const result = [...approved]
  const sources: Record<string, string> = { ...(approvedSources ?? {}) }
  const prevByName = new Map(prev.filter((r) => r.name).map((r) => [r.name, r]))
  const nextByName = new Map(next.filter((r) => r.name).map((r) => [r.name, r]))

  const add = (name: string, reg: McpServerRegistration) => {
    if (!result.includes(name)) result.push(name)
    sources[name] = registrationSourceIdentity(reg)
  }
  const remove = (name: string) => {
    const i = result.indexOf(name)
    if (i >= 0) result.splice(i, 1)
    delete sources[name]
  }

  for (const [name, reg] of nextByName) {
    const before = prevByName.get(name)
    const wasHost = before?.runLocation === 'host'
    const isHost = reg.runLocation === 'host' && reg.type !== 'http'
    if (isHost && !wasHost) add(name, reg)
    else if (!isHost && wasHost) remove(name)
    // Still-host registration whose package changed: refresh the recorded source
    else if (isHost && wasHost && result.includes(name)) sources[name] = registrationSourceIdentity(reg)
  }
  for (const [name, reg] of prevByName) {
    if (!nextByName.has(name) && reg.runLocation === 'host') remove(name)
  }
  return { approved: result, sources }
}
