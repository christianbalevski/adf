import { AgentExecutor } from '../agent-executor'
import { AgentSession } from '../agent-session'
import { AdfWorkspace } from '../../adf/adf-workspace'
import { ToolRegistry } from '../../tools/tool-registry'
import { registerBuiltInTools } from '../../tools/built-in/register-built-in-tools'
import type { LLMProvider } from '../../providers/provider.interface'
import type { AdfCallHandler } from '../adf-call-handler'
import type { ChannelAdapterManager } from '../../services/channel-adapter-manager'
import type { CodeSandboxService } from '../code-sandbox'
import type { TriggerEvaluator } from '../trigger-evaluator'
import type { McpClientManager } from '../../services/mcp-client-manager'
import type { CreateAgentOptions } from '../../../shared/types/adf-v02.types'

/**
 * A fully-assembled headless agent. No Electron, no IPC, no renderer.
 * Construct N of these to benchmark the runtime, or to back a future CLI.
 */
export interface HeadlessAgent {
  executor: AgentExecutor
  session: AgentSession
  workspace: AdfWorkspace
  registry: ToolRegistry
  adfCallHandler?: AdfCallHandler | null
  adapterManager?: ChannelAdapterManager | null
  codeSandboxService?: CodeSandboxService | null
  triggerEvaluator?: TriggerEvaluator | null
  mcpManager?: McpClientManager | null
  /** Release resources (close SQLite handle, detach listeners). */
  dispose: () => void
  /** Async variant for hosts that need deterministic teardown. */
  disposeAsync?: () => Promise<void>
}

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
}

export function createHeadlessAgent(opts: CreateHeadlessAgentOptions): HeadlessAgent {
  const filePath = opts.filePath ?? ':memory:'
  const workspace = AdfWorkspace.create(filePath, {
    name: opts.name ?? 'bench-agent',
    description: 'Headless benchmark agent',
    autonomous: false,
    ...opts.createOptions,
  })

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
  const session = new AgentSession(workspace)
  if (opts.restoreLoop) {
    const existingLoop = workspace.getLoop()
    if (existingLoop.length > 0) {
      session.restoreMessages(existingLoop.map(e => ({ role: e.role, content: e.content_json })))
    }
  }

  const registry = new ToolRegistry()
  ;(opts.registerTools ?? registerBuiltInTools)(registry)

  const config = workspace.getAgentConfig()
  if (!config) throw new Error('createHeadlessAgent: workspace produced no config')

  const executor = new AgentExecutor(
    config,
    opts.provider,
    registry,
    session,
    opts.basePrompt ?? '',
    opts.toolPrompts ?? {},
    opts.compactionPrompt,
  )

  const dispose = () => {
    executor.removeAllListeners()
    try { workspace.dispose() } catch { /* idempotent */ }
  }

  return { executor, session, workspace, registry, dispose }
}
