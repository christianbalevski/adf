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
 * Build a Settings registration draft from a curated entry. User-initiated
 * Settings installs default to host (the explicit choice is the trust
 * decision; no Podman required) — shared by the Add-server modal and tests.
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
      ...(entry.bearerTokenEnvVar ? { bearerTokenEnvVar: entry.bearerTokenEnvVar } : {}),
      // Registration headerEnv rows are { key: headerName, value: envVarName }.
      ...(entry.headerEnv?.length ? { headerEnv: entry.headerEnv.map(({ header, env }) => ({ key: header, value: env })) } : {}),
    }
  }
  const isPython = entry.runtime === 'python'
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
    runLocation: 'host',
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
