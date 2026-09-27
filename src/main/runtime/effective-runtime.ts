/**
 * Effective runtime snapshot.
 *
 * An agent runs with its `adf_config` PLUS app-level settings it inherits from
 * whichever runtime loaded it: the provider row (base URL, default model,
 * params, key), the global prompts, compute/host-access policy, MCP server
 * registrations, and mesh settings. None of that lives in the file, so an
 * owner inspecting the `.adf` alone could not tell what the agent actually ran
 * with.
 *
 * The runtime writes a snapshot of those inherited values to
 * `adf_meta['adf_effective_runtime']` (readonly) at start, and rewrites it
 * whenever the main loop's provider or the agent config changes. It records
 * WHAT applied and WHERE it came from — never key or env values: keys are
 * reported only as their source, env values only by name, prompts by hash
 * (their text reaches the loop as persisted entries), and URLs with any
 * userinfo, query string and fragment removed.
 *
 * Scope: the MAIN loop's provider. Side loops and model_invoke may build
 * providers for other model overrides; those are not described here. App
 * settings changed while the agent runs (MCP registrations, compute policy)
 * show up at the next rewrite.
 */

import { createHash } from 'crypto'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { McpServerRegistration } from '../../shared/types/ipc.types'
import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import type { LLMProvider } from '../providers/provider.interface'
import { describeProviderOrigin } from '../providers/provider-origin'
import type { ComputeAppSettings } from '../../shared/types/compute.types'
import { getEnabledAgentAdapterConfig, withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { pinServerConfigToRegistration } from '../../shared/utils/mcp-config'
import {
  DEFAULT_BASE_PROMPT,
  DEFAULT_COMPACTION_PROMPT,
  DEFAULT_DYNAMIC_PROMPTS,
  DEFAULT_TOOL_PROMPTS,
} from '../../shared/constants/adf-defaults'

export const EFFECTIVE_RUNTIME_META_KEY = 'adf_effective_runtime'

/** What a host hands assembleAgent so it can record the snapshot. */
export interface EffectiveRuntimeSources {
  settings: { get(key: string): unknown }
}

export interface EffectiveRuntimeSnapshot {
  schema: 1
  recorded_at: string
  host: string
  provider: {
    id: string
    /**
     * 'agent' = the file's own provider copy; 'app' = the runtime's settings
     * row; 'unknown' = a provider not built by createProvider (test mock,
     * embedder-supplied), whose settings origin the runtime cannot vouch for.
     */
    source: 'agent' | 'app' | 'unknown'
    type?: string
    name?: string
    /** Omitted for types with a fixed first-party endpoint (the base URL is not used). */
    base_url?: string
    model?: string
    params_source: 'agent_model' | 'provider' | 'none' | 'unknown'
    request_delay_ms?: number
    /** 'subscription' = app-level OAuth session; 'env' = the SDK's environment-variable fallback. */
    api_key_source: 'agent' | 'app' | 'subscription' | 'env' | 'none' | 'unknown'
  }
  prompts: {
    base_prompt: { applied: boolean; is_default: boolean; sha256: string }
    tool_prompts: { overridden: string[]; sha256: string }
    compaction_prompt: { is_default: boolean; sha256: string }
  }
  compute: {
    host_access_enabled: boolean
    host_approved: string[]
    execution_targets: string[]
    container_image?: string
    container_packages: string[]
  }
  mcp_servers: Array<{
    name: string
    /** true = executable identity (command/url/package) comes from the app registration, not the file. */
    pinned_to_app_registration: boolean
    transport?: string
    command?: string
    url?: string
    package?: string
    run_location?: string
    /** Names only — values are never recorded. */
    env_names: string[]
  }>
  /** Adapter types that start: enabled in the file AND registered on this runtime. */
  adapters: string[]
  /** Package modules visible to code execution (a process-wide sandbox setting). */
  sandbox_packages: string[]
  /**
   * forces_messaging_receive: on the mesh the runtime receives messages even
   * when `messaging.receive` is false in the file.
   */
  mesh: { enabled: boolean; lan: boolean; port: number; forces_messaging_receive: boolean }
}

/** Types whose builder ignores baseUrl — reporting one would name an endpoint that is not used. */
const FIXED_ENDPOINT_TYPES = new Set(['anthropic', 'openai', 'chatgpt-subscription', 'grok-subscription'])
const SUBSCRIPTION_TYPES = new Set(['chatgpt-subscription', 'grok-subscription'])

/** Drop userinfo, query string and fragment — the places credentials hide in URLs. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return url.replace(/\/\/[^/@]*@/, '//').split(/[?#]/)[0]
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? [...value] as T[] : []
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Stable serialization so equal prompt sets hash equally regardless of key order. */
function stableJson(record: Record<string, string>): string {
  return JSON.stringify(Object.keys(record).sort().map(k => [k, record[k]]))
}

export function buildEffectiveRuntime(args: {
  host: string
  config: AgentConfig
  /** The provider the executor actually uses — its recorded origin is the source of truth. */
  provider: LLMProvider
  basePrompt: string
  toolPrompts: Record<string, string>
  compactionPrompt?: string
  sources: EffectiveRuntimeSources
  /** Module names the (process-wide) code sandbox exposes, when there is one. */
  sandboxModules?: string[]
  now?: Date
}): EffectiveRuntimeSnapshot {
  const { config, sources } = args
  const { settings } = sources

  // Provider — read off the provider in use, as createProvider recorded it.
  const origin = describeProviderOrigin(args.provider)
  let provider: EffectiveRuntimeSnapshot['provider']
  if (origin) {
    const type = origin.config.type
    const baseUrl = FIXED_ENDPOINT_TYPES.has(type) ? undefined : redactUrl(origin.config.baseUrl)
    const keySource: EffectiveRuntimeSnapshot['provider']['api_key_source'] = SUBSCRIPTION_TYPES.has(type)
      ? 'subscription'
      // OpenRouter's SDK reads OPENROUTER_API_KEY when handed no key.
      : origin.apiKeySource === 'none' && type === 'openrouter' ? 'env' : origin.apiKeySource
    provider = {
      id: origin.config.id,
      source: origin.source,
      type,
      name: origin.config.name,
      ...(baseUrl ? { base_url: baseUrl } : {}),
      ...(origin.config.requestDelayMs ? { request_delay_ms: origin.config.requestDelayMs } : {}),
      model: args.provider.modelId || undefined,
      params_source: origin.paramsSource,
      api_key_source: keySource,
    }
  } else {
    provider = {
      id: args.provider.providerId ?? config.model.provider,
      source: 'unknown',
      ...(args.provider.providerType ? { type: args.provider.providerType } : {}),
      name: args.provider.name,
      model: args.provider.modelId || undefined,
      params_source: 'unknown',
      api_key_source: 'unknown',
    }
  }

  // Prompts — hashes, not text: the text itself is persisted to the loop.
  const defaultToolPrompts: Record<string, string> = { ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS }
  const overridden = Object.keys(args.toolPrompts)
    .filter(k => args.toolPrompts[k] !== defaultToolPrompts[k])
    .sort()
  const compaction = args.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT
  const prompts: EffectiveRuntimeSnapshot['prompts'] = {
    base_prompt: {
      applied: !config.bare_prompt && config.include_base_prompt !== false,
      is_default: args.basePrompt === DEFAULT_BASE_PROMPT,
      sha256: sha256(args.basePrompt),
    },
    tool_prompts: { overridden, sha256: sha256(stableJson(args.toolPrompts)) },
    compaction_prompt: { is_default: compaction === DEFAULT_COMPACTION_PROMPT, sha256: sha256(compaction) },
  }

  const computeSettings = (settings.get('compute') as Partial<ComputeAppSettings> | undefined) ?? {}
  const compute: EffectiveRuntimeSnapshot['compute'] = {
    host_access_enabled: !!computeSettings.hostAccessEnabled,
    host_approved: asArray<string>(computeSettings.hostApproved),
    execution_targets: asArray<{ id: string }>(computeSettings.executionTargets).map(t => t.id),
    ...(computeSettings.containerImage ? { container_image: computeSettings.containerImage } : {}),
    container_packages: asArray<string>(computeSettings.containerPackages),
  }

  // MCP — pinned exactly as the hosts pin (pinServerConfigToRegistration).
  // A server with no registration and no source is skipped at start by every
  // host, so it is not listed.
  const registrations = asArray<McpServerRegistration>(settings.get('mcpServers'))
  const mcpServers: EffectiveRuntimeSnapshot['mcp_servers'] = []
  for (const server of config.mcp?.servers ?? []) {
    const reg = registrations.find(r => r.name === server.name)
    if (!reg && !server.source) continue
    const effective = reg ? pinServerConfigToRegistration(server, reg) : server
    const envNames = new Set<string>([
      ...Object.keys(effective.env ?? {}),
      ...(effective.env_keys ?? []),
      ...(effective.env_schema ?? []).map(s => s.key),
      ...(reg?.env ?? []).map(e => e.key),
    ])
    const isHttp = effective.transport === 'http'
    const pkg = isHttp ? undefined : (effective.npm_package ?? effective.pypi_package)
    const url = isHttp ? redactUrl(effective.url) : undefined
    const command = isHttp ? undefined : effective.command
    const runLocation = isHttp ? undefined : effective.run_location
    mcpServers.push({
      name: server.name,
      pinned_to_app_registration: !!reg,
      transport: effective.transport,
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      ...(pkg ? { package: pkg } : {}),
      ...(runLocation ? { run_location: runLocation } : {}),
      env_names: [...envNames].filter(Boolean).sort(),
    })
  }

  // Adapters — a host starts one only when enabled === true AND registered.
  const registeredAdapters = new Set(
    withBuiltInAdapterRegistrations(settings.get('adapters') as AdapterRegistration[] | undefined).map(r => r.type),
  )
  const adapters = Object.keys(config.adapters ?? {})
    .filter(type => registeredAdapters.has(type) && getEnabledAgentAdapterConfig(config.adapters, type) !== null)
    .sort()

  const meshEnabled = settings.get('meshEnabled') !== false
  return {
    schema: 1,
    recorded_at: (args.now ?? new Date()).toISOString(),
    host: args.host,
    provider,
    prompts,
    compute,
    mcp_servers: mcpServers,
    adapters,
    sandbox_packages: [...(args.sandboxModules ?? [])].sort(),
    mesh: {
      enabled: meshEnabled,
      lan: !!settings.get('meshLan'),
      port: Number(settings.get('meshPort')) || 7295,
      forces_messaging_receive: meshEnabled && config.messaging?.receive === false,
    },
  }
}

/**
 * Build and write the snapshot to adf_meta as readonly. Best-effort: a
 * malformed setting or a failed write must never block a start or a config
 * change, but it is logged so the gap is visible.
 */
export function recordEffectiveRuntime(workspace: AdfWorkspace, build: () => EffectiveRuntimeSnapshot): void {
  try {
    workspace.setMeta(EFFECTIVE_RUNTIME_META_KEY, JSON.stringify(build()), 'readonly')
  } catch (err) {
    console.warn('[EffectiveRuntime] Failed to record effective runtime snapshot:', err)
  }
}
