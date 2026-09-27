/**
 * Curated registry of well-known MCP servers.
 * Used by the "Add MCP Server" modal's Quick-add cards (McpAddServerModal),
 * which prefill the configuration form from an entry.
 *
 * The data itself lives in /mcp-registry.json at the repo root — the same
 * document is bundled here as the offline fallback, fetched from GitHub raw
 * by the app at runtime, and fetched directly over HTTP by ADF agents to
 * discover available servers.
 */

import bundledRegistryDocument from '../../../mcp-registry.json'
import { parseMcpRegistryDocument } from '../schemas/mcp-registry.schema'

export interface McpRegistryEntry {
  /** Short identifier used for tool prefixing */
  name: string
  /** Human-readable display name */
  displayName: string
  /** npm package name (for Node servers) */
  npmPackage?: string
  /** PyPI package name (for Python servers) */
  pypiPackage?: string
  /** Runtime — default 'node' for backward compat */
  runtime?: 'node' | 'python'
  /**
   * CLI args appended after the package. Tokens of the form `{placeholder-name}`
   * (matching REGISTRY_ARG_PLACEHOLDER_RE, i.e. /\{[a-z0-9-]+\}/) mark values
   * the user must fill in before install — the modal renders them as required
   * inputs and substitutes them before registration. Placeholders must never
   * be secrets: argv is world-readable on the host.
   */
  args?: string[]
  /**
   * Remote Streamable HTTP endpoint. Presence makes this a remote entry —
   * npmPackage/pypiPackage/runtime/args are ignored.
   */
  url?: string
  /** Header-name → env-key credential mapping for HTTP entries (e.g. Authorization ← GITHUB_PAT). */
  headerEnv?: { header: string; env: string }[]
  /** Shortcut for plain `Authorization: Bearer <env>` auth on HTTP entries. */
  bearerTokenEnvVar?: string
  /**
   * Remote HTTP endpoint uses interactive OAuth (browser sign-in) instead of a
   * static token. Only meaningful on `url` (remote) entries. Dual-mode entries
   * keep a `bearerTokenEnvVar` as the paste-token fallback (CI/daemon).
   */
  oauth?: boolean
  /** Optional pre-registered OAuth client id (endpoints that don't do dynamic client registration). */
  oauthClientId?: string
  /** Optional OAuth scopes to request during sign-in. */
  oauthScopes?: string[]
  /** Description of what the server provides */
  description: string
  /** Category for grouping */
  category: 'tools' | 'data' | 'dev' | 'communication' | 'web' | 'search' | 'productivity' | 'infra' | 'ai'
  /** Required environment variable keys */
  requiredEnvKeys: string[]
  /** Optional environment variable keys */
  optionalEnvKeys?: string[]
  /** Repository/docs URL */
  repo?: string
  /** Whether this is a verified/recommended server */
  verified: boolean
  /**
   * Brand-logo key for the quick-add card (see BrandIcon). Maps to a Simple
   * Icons mark rendered in the brand's official color. Omit for servers with
   * no brand mark — they fall back to a monochrome category glyph.
   */
  iconKey?: string
  /** Interactive auth preflight (OAuth etc.) this server needs before first use. */
  auth?: boolean
  /** Args passed to the server during the auth preflight (e.g. ["auth"]). */
  authArgs?: string[]
  /** File-shaped credentials the server reads/writes (declarations only). */
  credentialFiles?: { path: string; required?: boolean; writeBack?: boolean }[]
  /**
   * What the user must obtain/enable in their own account before this server
   * can work — rendered as a callout on the quick-add card and next to the
   * matching credential-file drop input.
   */
  prerequisite?: string
  /**
   * Human-readable reason the entry is deprecated. A deprecated entry stays
   * valid data — lookups for existing installs still resolve — but the
   * quick-add UI excludes it, and agents should not install it fresh.
   */
  deprecated?: string
  /** Short security/operational warning surfaced on the quick-add card. */
  advisory?: string
  /**
   * Where this server has to run. Omit it — the overwhelmingly common case:
   * a registration with no run location is routed into the shared compute
   * container by shouldContainerize, which is the default for every install.
   *
   * Set `'host'` ONLY when the server cannot do its job containerized, i.e.
   * one of:
   *  - the entry's own `prerequisite` says a host run is required/recommended
   *    (a host binary, a host daemon socket, a host localhost listener, host
   *    CLI login state);
   *  - its `args` take a host filesystem path the user fills in at install;
   *  - every one of its tools addresses the user's own files by host path
   *    (the container has no bind mount of the host filesystem — only an npm
   *    cache volume — so such a server sees nothing there);
   *  - a required env key names a host file path;
   *  - it declares `auth` or `credentialFiles`. The Settings "Connect" test
   *    only stores dropped credential files and runs the auth preflight for a
   *    HOST-located server (see deriveRegistrationTestPlan and the
   *    MCP_REGISTRATION_TEST handler); for a container-located one both are
   *    deferred to per-agent attach, so a Settings install would stamp the row
   *    verified while the OAuth key file the user picked went nowhere. Until
   *    Settings can store credential files for containerized servers, these
   *    entries stay on the host. (mcp-settings-modal.test.ts enforces this.)
   *
   * A `'host'` entry still passes through both host gates at routing time
   * (app-wide "Enable host access" + agent `compute.host_access` or the
   * approved-name list); it is a *request*, never a grant. `'shared'` is
   * accepted for completeness but should not be needed — it PINS the server
   * to the shared container, overriding an agent's own isolated container.
   * Meaningless on `url` (remote) entries, which run nowhere locally.
   */
  runLocation?: 'host' | 'shared'
}

/**
 * Name-squat blocklist — NEVER map an entry to these packages. They squat
 * well-known project names but are unrelated (or hostile) third parties:
 * PyPI `mcp-gmail`, PyPI `telegram-mcp`, PyPI `mcp-server-milvus`,
 * npm `mcp-filesystem-server`, npm `github-mcp-server`.
 * (Also recorded in the JSON document's top-level `$notes` field.)
 */
const parsedBundledRegistry = parseMcpRegistryDocument(bundledRegistryDocument)
if (!parsedBundledRegistry || parsedBundledRegistry.dropped > 0) {
  // A broken bundled registry is a build error, not a runtime condition.
  throw new Error('Bundled mcp-registry.json failed schema validation — fix /mcp-registry.json')
}

/** The curated registry, parsed from the bundled /mcp-registry.json document. */
export const MCP_REGISTRY: McpRegistryEntry[] = parsedBundledRegistry.entries

/** `updatedAt` stamp of the bundled registry document. */
export const BUNDLED_REGISTRY_UPDATED_AT = parsedBundledRegistry.updatedAt

/**
 * Matches a `{placeholder-name}` token in a registry `args` entry — a value
 * the user must fill in before install. Placeholders are never secrets
 * (argv is world-readable on the host).
 */
export const REGISTRY_ARG_PLACEHOLDER_RE = /\{[a-z0-9-]+\}/

/**
 * Whether any arg still carries an unresolved `{placeholder}` token — the
 * Add-server modal gates Connect/Save on this until the user fills them in.
 */
export function hasUnresolvedPlaceholderArgs(args: string[] | undefined): boolean {
  return (args ?? []).some((arg) => REGISTRY_ARG_PLACEHOLDER_RE.test(arg))
}

/**
 * Curated entry names that must run on the HOST even when the live registry
 * document says nothing about a run location.
 *
 * Why a code-side copy of a JSON field: the document fetched from GitHub raw
 * OVERRIDES the bundled one (McpRegistryFetchService tries remote → cache →
 * bundled, with no version comparison). A build that ships before its
 * mcp-registry.json reaches `main` would therefore prefill Container for
 * servers that cannot work there — silently dropping the OAuth key file the
 * user picked, for instance. This set is the floor; an entry that DECLARES a
 * location always wins, so a later document can containerize one of these by
 * setting `"runLocation": "shared"` explicitly.
 *
 * Keep it in step with mcp-registry.json — mcp-settings-modal.test.ts asserts
 * the two agree exactly. See McpRegistryEntry.runLocation for the criteria.
 */
const HOST_ONLY_REGISTRY_ENTRIES = new Set([
  // Host binary, daemon, or loopback listener
  'pandoc', 'docker', 'kubernetes', 'blender', 'chrome-devtools',
  // Host CLI login state / in-flow browser sign-in the preflight can't drive
  'netlify', 'workspace',
  // Host filesystem paths (the container has no bind mount of the host FS)
  'filesystem', 'sqlite', 'duckdb', 'git', 'markitdown', 'excel', 'semgrep',
  'google-sheets',
  // Settings-side auth preflight + credential-file storage (host-only today)
  'gmail', 'google-drive', 'google-calendar', 'google-docs', 'teams',
])

/**
 * The run location a curated entry installs with: what it declares, else the
 * host floor above, else nothing — and nothing means the shared compute
 * container (shouldContainerize's default). Always undefined for remote (url)
 * entries, which run nowhere locally.
 */
export function registryEntryRunLocation(
  entry: Pick<McpRegistryEntry, 'name' | 'url' | 'runLocation'>,
): 'host' | 'shared' | undefined {
  if (entry.url) return undefined
  if (entry.runLocation) return entry.runLocation
  return HOST_ONLY_REGISTRY_ENTRIES.has(entry.name) ? 'host' : undefined
}

/** The host floor, for tests that keep it in step with the registry document. */
export const HOST_ONLY_REGISTRY_ENTRY_NAMES: readonly string[] = [...HOST_ONLY_REGISTRY_ENTRIES]

/**
 * Build a Settings registration draft from a curated entry. Shared by the
 * Add-server modal and tests.
 *
 * Run location: the draft carries NO `runLocation` unless the entry asks for
 * one (see registryEntryRunLocation), so a new install is routed into the
 * shared compute container (see shouldContainerize) — containment is the
 * default everywhere now, for a Settings install exactly as for an agent's
 * `mcp_install`. Host stays a deliberate click in the Add-server modal, and
 * the minority of curated entries that genuinely cannot run containerized
 * declare `runLocation: 'host'` themselves.
 *
 * Leaving it ABSENT rather than writing `'shared'` is deliberate: an explicit
 * `'shared'` PINS the server to the shared container (isServerForceShared),
 * which would break an agent that runs in its own isolated container — most
 * visibly the browser MCPs, whose managed Chromium lives in that isolated
 * container.
 *
 * HTTP entries (`url` present) become remote registrations: no runLocation,
 * no managed flag, no auth/credentialFiles. Their `env` is seeded with one
 * empty-value row per unique env key (required/optional/bearer/headerEnv) so
 * the modal shows a value input for each credential the endpoint needs.
 */
export function registrationFromRegistryEntry(entry: McpRegistryEntry, id: string): import('../types/ipc.types').McpServerRegistration {
  if (entry.url) {
    const envKeys = [...new Set([
      ...entry.requiredEnvKeys,
      ...(entry.optionalEnvKeys ?? []),
      ...(entry.bearerTokenEnvVar ? [entry.bearerTokenEnvVar] : []),
      ...(entry.headerEnv ?? []).map(({ env }) => env),
    ])]
    return {
      id,
      name: entry.name,
      type: 'http',
      url: entry.url,
      description: entry.description,
      repo: entry.repo,
      env: envKeys.map((k) => ({ key: k, value: '' })),
      ...(entry.oauth ? { oauth: true } : {}),
      // Dual-mode: even when oauth is the default, seed the bearer/header env so
      // the paste-token fallback stays available (CI/daemon users).
      ...(entry.bearerTokenEnvVar ? { bearerTokenEnvVar: entry.bearerTokenEnvVar } : {}),
      // Registration headerEnv rows are { key: headerName, value: envVarName }.
      ...(entry.headerEnv?.length ? { headerEnv: entry.headerEnv.map(({ header, env }) => ({ key: header, value: env })) } : {}),
    }
  }
  const isPython = entry.runtime === 'python'
  const runLocation = registryEntryRunLocation(entry)
  return {
    id,
    name: entry.name,
    type: isPython ? 'uvx' : 'npm',
    npmPackage: isPython ? undefined : entry.npmPackage,
    pypiPackage: isPython ? entry.pypiPackage : undefined,
    description: entry.description,
    managed: true,
    env: [...entry.requiredEnvKeys, ...(entry.optionalEnvKeys ?? [])].map((k) => ({ key: k, value: '' })),
    repo: entry.repo,
    // Only entries that ask for a run location carry one; absent = container.
    ...(runLocation ? { runLocation } : {}),
    // Placeholders are copied verbatim — the modal resolves them before install.
    ...(entry.args?.length ? { args: [...entry.args] } : {}),
    ...(entry.auth ? { auth: true } : {}),
    ...(entry.authArgs ? { authArgs: entry.authArgs } : {}),
    ...(entry.credentialFiles ? { credentialFiles: entry.credentialFiles.map((f) => ({ ...f })) } : {}),
  }
}

/**
 * Look up an entry in an arbitrary entry list (e.g. the runtime-fetched
 * registry) by exactly one identity field. Fields are tried in priority
 * order — npmPackage, pypiPackage, url, name — and the first one PROVIDED
 * decides the match, mirroring the static findRegistryEntry* helpers below
 * (which stay for call sites bound to the bundled MCP_REGISTRY).
 */
export function findEntryIn(
  entries: McpRegistryEntry[],
  lookup: { npmPackage?: string; pypiPackage?: string; url?: string; name?: string }
): McpRegistryEntry | undefined {
  if (lookup.npmPackage !== undefined) return entries.find((e) => e.npmPackage === lookup.npmPackage)
  if (lookup.pypiPackage !== undefined) return entries.find((e) => e.pypiPackage === lookup.pypiPackage)
  if (lookup.url !== undefined) return entries.find((e) => e.url === lookup.url)
  if (lookup.name !== undefined) return entries.find((e) => e.name === lookup.name)
  return undefined
}

/**
 * Look up a registry entry by npm package name.
 */
export function findRegistryEntry(npmPackage: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.npmPackage === npmPackage)
}

/**
 * Look up a registry entry by PyPI package name.
 */
export function findRegistryEntryByPypiPackage(pypiPackage: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.pypiPackage === pypiPackage)
}

/**
 * Look up a registry entry by short name.
 */
export function findRegistryEntryByName(name: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.name === name)
}

/**
 * Look up a remote registry entry by Streamable HTTP endpoint URL.
 */
export function findRegistryEntryByUrl(url: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.url === url)
}
