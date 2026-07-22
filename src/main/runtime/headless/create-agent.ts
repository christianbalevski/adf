import { AdfWorkspace } from '../../adf/adf-workspace'
import { ToolRegistry } from '../../tools/tool-registry'
import { registerBuiltInTools } from '../../tools/built-in/register-built-in-tools'
import type { LLMProvider } from '../../providers/provider.interface'
import type { CreateAgentOptions } from '../../../shared/types/adf-v02.types'
import { assembleAgent, type AssembledAgent } from '../assemble-agent'

export type HeadlessProfile = 'headlessLive' | 'benchmark'

/**
 * A fully-assembled headless agent. No Electron, no IPC, no renderer.
 * Construct N of these to benchmark the runtime, or to back a future CLI.
 */
export type HeadlessAgent = AssembledAgent<HeadlessProfile>

export interface CreateHeadlessAgentOptions {
  /** Human-readable name. Defaults to "bench-agent". */
  name?: string
  /** SQLite path. Defaults to ":memory:" (per-agent, isolated). */
  filePath?: string
  /** The LLM provider, typically MockLLMProvider for benchmarks. */
  provider: LLMProvider
  /** Override any fields of CreateAgentOptions (tools, triggers, model, etc.). */
  createOptions?: Partial<CreateAgentOptions>
  basePrompt?: string
  toolPrompts?: Record<string, string>
  compactionPrompt?: string
  /** Override tool registration. Defaults to registerBuiltInTools. Pass `() => {}` for an empty registry. */
  registerTools?: (registry: ToolRegistry) => void
  /** Live agents poll timers; the benchmark profile explicitly disables polling. */
  profile?: HeadlessProfile
}

export interface OpenHeadlessAgentOptions {
  /** SQLite .adf path to open. */
  filePath: string
  /** The LLM provider, typically supplied by the daemon/runtime host. */
  provider: LLMProvider
  basePrompt?: string
  toolPrompts?: Record<string, string>
  compactionPrompt?: string
  /** Override tool registration. Defaults to registerBuiltInTools. Pass `() => {}` for an empty registry. */
  registerTools?: (registry: ToolRegistry) => void
  profile?: HeadlessProfile
}

export interface CreateHeadlessAgentFromWorkspaceOptions {
  /** The LLM provider, typically supplied by the daemon/runtime host. */
  provider: LLMProvider
  basePrompt?: string
  toolPrompts?: Record<string, string>
  compactionPrompt?: string
  /** Override tool registration. Defaults to registerBuiltInTools. Pass `() => {}` for an empty registry. */
  registerTools?: (registry: ToolRegistry) => void
  /** Restore persisted loop rows into the session before constructing the executor. */
  restoreLoop?: boolean
  profile?: HeadlessProfile
}

export function createHeadlessAgent(opts: CreateHeadlessAgentOptions): HeadlessAgent {
  const filePath = opts.filePath ?? ':memory:'
  const workspace = AdfWorkspace.create(filePath, {
    name: opts.name ?? 'bench-agent',
    description: 'Headless benchmark agent',
    autonomous: false,
    ...opts.createOptions,
  })

  // D1: identity keys are mandatory at creation. Headless has no owner
  // identity service (no owner stamp, no envelopes — Studio adds those),
  // but the agent key itself must exist: the default security level signs
  // every outbound message, and a keyless agent could not send at all.
  try {
    workspace.generateIdentityKeys(null)
  } catch (err) {
    console.warn('[headless] Identity key generation failed — agent cannot sign:', err)
  }

  return createHeadlessAgentFromWorkspace(workspace, opts)
}

export function openHeadlessAgent(opts: OpenHeadlessAgentOptions): HeadlessAgent {
  const workspace = AdfWorkspace.open(opts.filePath)
  return createHeadlessAgentFromWorkspace(workspace, { ...opts, restoreLoop: true })
}

export function createHeadlessAgentFromWorkspace(
  workspace: AdfWorkspace,
  opts: CreateHeadlessAgentFromWorkspaceOptions,
): HeadlessAgent {
  const registry = new ToolRegistry()
  ;(opts.registerTools ?? registerBuiltInTools)(registry)

  const config = workspace.getAgentConfig()
  if (!config) throw new Error('createHeadlessAgent: workspace produced no config')

  const profile = opts.profile ?? 'headlessLive'
  const agent = assembleAgent({
    profile,
    workspace,
    config,
    provider: opts.provider,
    registry,
    restoreLoop: opts.restoreLoop,
    basePrompt: opts.basePrompt,
    toolPrompts: opts.toolPrompts,
    compactionPrompt: opts.compactionPrompt,
  })
  // Both lightweight profiles have no asynchronous startup resources. start()
  // reaches running synchronously before returning its already-resolved promise.
  void agent.start().catch((error) => {
    console.error('[headless] Failed to start agent lifecycle:', error)
  })
  return agent
}
