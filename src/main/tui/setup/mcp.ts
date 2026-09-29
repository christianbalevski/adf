// /mcp: the selected agent's MCP servers. Sources and the curated catalog are
// Studio's (shared/constants/mcp-registry.ts, the same /mcp-registry.json);
// the server config is built by Studio's builder
// (buildMcpServerConfigFromRegistration) from a registration with
// credentialStorage 'agent', so env values are the agent's own credentials:
// stored sealed in its identity store (`mcp:<package or name>:<KEY>`), never
// in the config. The daemon installs the package (POST /admin/mcp/packages),
// the config write attaches the server, and POST .../restart connects it now.

import * as registryNs from '../../../shared/constants/mcp-registry'
import * as mcpConfigNs from '../../../shared/utils/mcp-config'
import type { McpRegistryEntry } from '../../../shared/constants/mcp-registry'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'
import type { McpServerConfig } from '../api/types'
import { cjs } from '../interop'

const { MCP_REGISTRY, registrationFromRegistryEntry, hasUnresolvedPlaceholderArgs, REGISTRY_ARG_PLACEHOLDER_RE } = cjs(registryNs)
const { buildMcpServerConfigFromRegistration, mcpCredentialNamespace } = cjs(mcpConfigNs)

export const MCP_OVERLAY = 'mcp'

export type McpSourceKind = 'catalog' | 'npm' | 'python' | 'http'

export interface McpOverlayProps {
  agentId?: string
  /** Open the add wizard: `npm:<pkg>`, `python:<pkg>`, a URL, a catalog name, or '' for the source list. */
  add?: string
  /** Open this server's details (`view`) or its logs. */
  server?: string
  view?: 'detail' | 'logs'
}

export interface McpSourceRow {
  kind: McpSourceKind
  /** Catalog entry for kind 'catalog'. */
  entry?: McpRegistryEntry
  label: string
  detail: string
}

/** Custom sources first, then the catalog (deprecated entries left out). */
export function mcpSourceRows(): McpSourceRow[] {
  const custom: McpSourceRow[] = [
    { kind: 'npm', label: 'npm package', detail: 'Any MCP server published to npm (e.g. @modelcontextprotocol/server-everything)' },
    { kind: 'python', label: 'Python package (uvx)', detail: 'Any MCP server on PyPI, run with uvx (e.g. mcp-server-fetch)' },
    { kind: 'http', label: 'Remote server (URL)', detail: 'A Streamable HTTP MCP endpoint; token from an env var' },
  ]
  const catalog = MCP_REGISTRY
    .filter(e => !e.deprecated)
    .map((entry): McpSourceRow => ({ kind: 'catalog', entry, label: entry.displayName, detail: entry.description }))
  return [...custom, ...catalog]
}

/** `/mcp add <x>`: a catalog name or package, `npm:`/`python:`/`uvx:` prefix, or a URL. */
export function parseAddTarget(arg: string | undefined): { row?: McpSourceRow; value?: string } {
  const raw = (arg ?? '').trim()
  if (!raw) return {}
  const rows = mcpSourceRows()
  if (/^https?:\/\//i.test(raw)) {
    const known = rows.find(r => r.entry?.url === raw)
    return known ? { row: known } : { row: rows.find(r => r.kind === 'http'), value: raw }
  }
  const prefixed = raw.match(/^(npm|python|uvx|pip):(.+)$/i)
  if (prefixed) {
    const kind = prefixed[1].toLowerCase() === 'npm' ? 'npm' : 'python'
    return { row: rows.find(r => r.kind === kind), value: prefixed[2].trim() }
  }
  const wanted = raw.toLowerCase()
  const entry = rows.find(r => r.entry && (r.entry.name === wanted || r.entry.npmPackage === raw || r.entry.pypiPackage === raw || r.entry.displayName.toLowerCase() === wanted))
  if (entry) return { row: entry }
  // A bare package: scoped or containing a slash is npm; otherwise guess npm too (the common case).
  return { row: rows.find(r => r.kind === 'npm'), value: raw }
}

/** Server names become tool prefixes (`mcp_<name>_<tool>`): lowercase letters, digits, - and _. */
export function sanitizeServerName(value: string): string {
  return value.toLowerCase().replace(/^@[^/]+\//, '').replace(/^mcp-server-|-mcp-server$|^server-|-mcp$|^mcp-/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export function defaultServerName(row: McpSourceRow, value = ''): string {
  if (row.entry) return row.entry.name
  if (row.kind === 'http') {
    try { return sanitizeServerName(new URL(value).hostname.split('.').slice(-2, -1)[0] ?? '') } catch { return '' }
  }
  return sanitizeServerName(value.split('/').pop() ?? value)
}

/** Env keys the source asks for, with which are required. */
export function envKeysOf(row: McpSourceRow): Array<{ key: string; required: boolean }> {
  const e = row.entry
  if (!e) return row.kind === 'http' ? [{ key: 'MCP_TOKEN', required: false }] : []
  const keys = [
    ...e.requiredEnvKeys.map(key => ({ key, required: true })),
    ...(e.optionalEnvKeys ?? []).map(key => ({ key, required: false })),
    ...(e.bearerTokenEnvVar ? [{ key: e.bearerTokenEnvVar, required: !!e.url && !e.oauth }] : []),
    ...(e.headerEnv ?? []).map(h => ({ key: h.env, required: true })),
  ]
  return keys.filter((k, i) => keys.findIndex(x => x.key === k.key) === i)
}

/**
 * What the terminal cannot do for this source, or null. OAuth-only remote
 * servers and servers with a sign-in step (auth subcommand, credential
 * files) need ADF Studio's browser flow.
 */
export function studioOnlyReason(row: McpSourceRow): string | null {
  const e = row.entry
  if (!e) return null
  if (e.url && e.oauth && !e.bearerTokenEnvVar && !(e.headerEnv?.length)) {
    return `${e.displayName} signs in with OAuth in the browser, which only ADF Studio runs today. Add it in Studio (Settings → MCP → ${e.displayName}, Connect), then it shows up here.`
  }
  if (e.auth || (e.credentialFiles?.length ?? 0) > 0) {
    return `${e.displayName} needs a one-time sign-in step (it writes a credential file), which ADF Studio runs. Add it in Studio (Settings → MCP), then it shows up here.`
  }
  return null
}

export interface McpAddForm {
  name: string
  /** npm / PyPI package, or the URL for a remote server. */
  source: string
  /** Space-separated; `{placeholders}` from the catalog must be filled in. */
  args: string
  /** 'container' (the default: the shared container, or the agent's own) or 'host'. */
  runOn: 'container' | 'host'
  env: Record<string, string>
}

export function validateMcpForm(row: McpSourceRow, form: McpAddForm, taken: string[]): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.name) errors.name = 'Give it a name (letters, digits, - and _).'
  else if (form.name !== sanitizeServerName(form.name) || !/^[a-z0-9][a-z0-9_-]*$/.test(form.name)) errors.name = 'Lowercase letters, digits, - and _ only.'
  else if (taken.includes(form.name)) errors.name = `This agent already has a server named ${form.name}.`
  if (!row.entry) {
    const source = form.source.trim()
    if (!source) errors.source = row.kind === 'http' ? 'The server URL.' : 'The package name.'
    else if (row.kind === 'http') {
      try { if (!/^https?:$/.test(new URL(source).protocol)) errors.source = 'Use an http(s) URL.' } catch { errors.source = 'Not a URL.' }
    } else if (/\s/.test(source)) errors.source = 'One package name, no spaces.'
  }
  if (hasUnresolvedPlaceholderArgs(splitArgs(form.args))) errors.args = 'Fill in the {placeholders}.'
  for (const { key, required } of envKeysOf(row)) {
    if (required && !(form.env[key] ?? '').trim()) errors[`env:${key}`] = `${key} is required.`
  }
  return errors
}

export function splitArgs(text: string): string[] {
  const out: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3])
  return out
}

export function joinArgs(args: string[] | undefined): string {
  return (args ?? []).map(a => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

/** The registration Studio would build for this form (credentials per agent, never inline). */
export function registrationFor(row: McpSourceRow, form: McpAddForm): McpServerRegistration {
  const envKeys = envKeysOf(row).map(k => k.key)
  const base: McpServerRegistration = row.entry
    ? registrationFromRegistryEntry(row.entry, `tui:${form.name}`)
    : row.kind === 'http'
      ? { id: `tui:${form.name}`, name: form.name, type: 'http', url: form.source.trim(), ...(form.env.MCP_TOKEN?.trim() ? { bearerTokenEnvVar: 'MCP_TOKEN' } : {}) }
      : row.kind === 'python'
        ? { id: `tui:${form.name}`, name: form.name, type: 'uvx', pypiPackage: form.source.trim(), managed: true }
        : { id: `tui:${form.name}`, name: form.name, type: 'npm', npmPackage: form.source.trim(), managed: true }
  const isHttp = base.type === 'http'
  const args = splitArgs(form.args)
  const keysWithValues = envKeys.filter(k => (form.env[k] ?? '').trim())
  return {
    ...base,
    name: form.name,
    credentialStorage: 'agent',
    // Keys only: values go to the agent's identity store.
    env: (row.entry ? envKeys : keysWithValues).map(key => ({ key, value: '' })),
    // Remote catalog entries that also take a token: the token path (OAuth runs in Studio only).
    ...(isHttp && base.oauth && base.bearerTokenEnvVar ? { oauth: false } : {}),
    ...(!isHttp ? { args: args.length ? args : undefined } : {}),
    // Container unless the user picked the host (a catalog entry's host default is only a preselection).
    runLocation: !isHttp && form.runOn === 'host' ? 'host' : undefined,
  }
}

export function serverConfigFor(row: McpSourceRow, form: McpAddForm): McpServerConfig {
  return buildMcpServerConfigFromRegistration(registrationFor(row, form))
}

/** Where `mcp:<namespace>:<KEY>` credentials of this server live. */
export function credentialNamespace(server: Pick<McpServerConfig, 'name' | 'npm_package' | 'pypi_package'>): string {
  return mcpCredentialNamespace(server)
}

/** The package to install before attaching, if any. */
export function packageToInstall(server: McpServerConfig): { kind: 'npm' | 'python'; name: string } | null {
  if (server.transport === 'http') return null
  if (server.npm_package) return { kind: 'npm', name: server.npm_package }
  if (server.pypi_package) return { kind: 'python', name: server.pypi_package }
  return null
}

/** Env keys a configured server takes (for editing its credentials). */
export function serverEnvKeys(server: McpServerConfig): string[] {
  return [...new Set([
    ...(server.env_keys ?? []),
    ...(server.env_schema ?? []).map(e => e.key),
    ...(server.bearer_token_env_var ? [server.bearer_token_env_var] : []),
    ...(server.header_env ?? []).map(h => h.env),
  ])]
}

/** Where a server runs, in words. */
export function runsOnText(server: Pick<McpServerConfig, 'transport' | 'run_location'> | undefined, location?: string): string {
  if (location) return location
  if (!server) return ''
  if (server.transport === 'http') return 'remote'
  return server.run_location === 'host' ? 'host' : server.run_location === 'shared' ? 'shared container' : 'container'
}

export const PLACEHOLDER_RE = REGISTRY_ARG_PLACEHOLDER_RE

/** The agent's MCP tool declarations for one server (`mcp_<server>_<tool>`). */
export function serverToolDecls(tools: Array<{ name: string; enabled?: boolean }> | undefined, server: string): Array<{ name: string; tool: string; enabled: boolean }> {
  const prefix = `mcp_${server}_`
  return (tools ?? []).filter(t => t.name.startsWith(prefix)).map(t => ({ name: t.name, tool: t.name.slice(prefix.length), enabled: t.enabled !== false }))
}
