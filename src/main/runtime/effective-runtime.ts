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
 * At every start the runtime writes a snapshot of those inherited values to
 * `adf_meta['adf_effective_runtime']` (readonly). It records WHAT applied and
 * WHERE it came from — never secret values: keys are reported only as their
 * source, env values only by name, prompts by hash (their full text already
 * reaches the loop as persisted entries).
 */

import { createHash } from 'crypto'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { McpServerRegistration } from '../../shared/types/ipc.types'
import type { LLMProvider } from '../providers/provider.interface'
import { describeProviderOrigin } from '../providers/provider-origin'
import type { ComputeAppSettings } from '../../shared/types/compute.types'
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
  /** Whether this host installs the app-level `sandboxPackages` into code execution. */
  sandboxPackagesApplied: boolean
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
    base_url?: string
    model?: string
    params_source: 'agent_model' | 'provider' | 'none' | 'unknown'
    request_delay_ms?: number
    api_key_source: 'agent' | 'app' | 'none' | 'unknown'
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
  adapters: string[]
  sandbox_packages: string[]
  mesh: { enabled: boolean; lan: boolean; port: number }
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
  now?: Date
}): EffectiveRuntimeSnapshot {
  const { config, sources } = args
  const { settings } = sources

  // Provider — read off the provider in use, as createProvider recorded it.
  const origin = describeProviderOrigin(args.provider)
  const provider: EffectiveRuntimeSnapshot['provider'] = origin
    ? {
        id: origin.config.id,
        source: origin.source,
        type: origin.config.type,
        name: origin.config.name,
        base_url: origin.config.baseUrl,
        ...(origin.config.requestDelayMs ? { request_delay_ms: origin.config.requestDelayMs } : {}),
        model: args.provider.modelId || undefined,
        params_source: origin.paramsSource,
        api_key_source: origin.apiKeySource,
      }
    : {
        id: args.provider.providerId ?? config.model.provider,
        source: 'unknown',
        ...(args.provider.providerType ? { type: args.provider.providerType } : {}),
        name: args.provider.name,
        model: args.provider.modelId || undefined,
        params_source: 'unknown',
        api_key_source: 'unknown',
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
    host_approved: [...(computeSettings.hostApproved ?? [])],
    execution_targets: (computeSettings.executionTargets ?? []).map(t => t.id),
    ...(computeSettings.containerImage ? { container_image: computeSettings.containerImage } : {}),
    container_packages: [...(computeSettings.containerPackages ?? [])],
  }

  // MCP — same name-match the hosts use for pinServerConfigToRegistration.
  const registrations = (settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
  const mcpServers: EffectiveRuntimeSnapshot['mcp_servers'] = (config.mcp?.servers ?? []).map(server => {
    const reg = registrations.find(r => r.name === server.name)
    const envNames = new Set<string>([
      ...Object.keys(server.env ?? {}),
      ...(server.env_keys ?? []),
      ...(server.env_schema ?? []).map(s => s.key),
      ...(reg?.env ?? []).map(e => e.key),
    ])
    const pkg = reg ? (reg.npmPackage ?? reg.pypiPackage) : (server.npm_package ?? server.pypi_package)
    const url = reg ? reg.url : server.url
    const command = reg ? reg.command : server.command
    const runLocation = reg?.runLocation ?? server.run_location
    return {
      name: server.name,
      pinned_to_app_registration: !!reg,
      transport: reg ? (reg.type === 'http' ? 'http' : 'stdio') : server.transport,
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      ...(pkg ? { package: pkg } : {}),
      ...(runLocation ? { run_location: runLocation } : {}),
      env_names: [...envNames].filter(Boolean).sort(),
    }
  })

  const adapters = Object.entries((config.adapters ?? {}) as Record<string, { enabled?: boolean } | undefined>)
    .filter(([, v]) => v && v.enabled !== false)
    .map(([type]) => type)
    .sort()

  const sandboxPackages = sources.sandboxPackagesApplied
    ? ((settings.get('sandboxPackages') as Array<{ name: string; version: string }> | undefined) ?? [])
        .map(p => `${p.name}@${p.version}`)
    : []

  return {
    schema: 1,
    recorded_at: (args.now ?? new Date()).toISOString(),
    host: args.host,
    provider,
    prompts,
    compute,
    mcp_servers: mcpServers,
    adapters,
    sandbox_packages: sandboxPackages,
    mesh: {
      enabled: settings.get('meshEnabled') !== false,
      lan: !!settings.get('meshLan'),
      port: Number(settings.get('meshPort')) || 7295,
    },
  }
}

/**
 * Write the snapshot to adf_meta as readonly. Best-effort: failing to record
 * must never block a start, but it is logged so the gap is visible.
 */
export function recordEffectiveRuntime(workspace: AdfWorkspace, snapshot: EffectiveRuntimeSnapshot): void {
  try {
    workspace.setMeta(EFFECTIVE_RUNTIME_META_KEY, JSON.stringify(snapshot), 'readonly')
  } catch (err) {
    console.warn('[EffectiveRuntime] Failed to record effective runtime snapshot:', err)
  }
}
