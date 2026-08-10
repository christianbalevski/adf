import type { ZodTypeAny } from 'zod'
import type { Tool } from './tool.interface'
import type { ToolResult } from '../../shared/types/tool.types'
import type { ToolDeclaration } from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { emitUmbilicalEvent } from '../runtime/emit-umbilical'

/** Cross-cutting flags injected by the runtime — never surfaced in tool.* payloads. */
const INTERNAL_INPUT_FLAGS = ['_authorized', '_protection_override', '_full', '_async'] as const

/** Result content is truncated in umbilical payloads — taps are observers, not sinks. */
const MAX_EVENT_RESULT_BYTES = 16_384

/** Optional call metadata. `toolUseId` is the LLM `tool_use.id`; code-driven calls omit it. */
export interface ToolExecutionContext {
  toolUseId?: string
  /**
   * Explicit umbilical provenance for calls that run OUTSIDE any `withSource`
   * scope (e.g. backgrounded async tools resumed from an IPC/HTTP approval
   * callback). When set, tool.* events are stamped with this agent id instead
   * of relying on the async-local context — which would otherwise be null.
   */
  agentId?: string
  /**
   * Skip the `tool.started` emission. Used when the caller already emitted
   * `tool.started` at enqueue time (async-restricted approval path) so a tap
   * still sees exactly one started + one terminal event per tool_use id.
   */
  suppressStarted?: boolean
}

/** Drop runtime-injected flags so tool.* payloads only carry what the caller asked for. */
export function stripInternalToolFlags(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const rest = { ...(input as Record<string, unknown>) }
  for (const flag of INTERNAL_INPUT_FLAGS) delete rest[flag]
  return rest
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()

  // Performance: cache filtered tools to avoid repeated filtering
  private toolCache: Map<string, Tool[]> = new Map()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
    // Invalidate cache when tools are registered
    this.toolCache.clear()
  }

  unregister(name: string): boolean {
    const result = this.tools.delete(name)
    if (result) {
      // Invalidate cache when tools are removed
      this.toolCache.clear()
    }
    return result
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Clear the tool filter cache.
   * Should be called when agent config changes to ensure tool availability is recalculated.
   */
  clearCache(): void {
    this.toolCache.clear()
  }

  /**
   * Returns only the tools that are declared, enabled, and visible in the agent config.
   * Results are cached for performance.
   */
  getToolsForAgent(declarations: ToolDeclaration[]): Tool[] {
    // Create cache key from sorted declarations
    const cacheKey = JSON.stringify(
      declarations
        .map(d => ({ name: d.name, enabled: d.enabled, visible: d.visible }))
        .sort((a, b) => a.name.localeCompare(b.name))
    )

    // Check cache
    if (this.toolCache.has(cacheKey)) {
      return this.toolCache.get(cacheKey)!
    }

    // Cache miss - filter and map
    const result = declarations
      .filter((d) => d.enabled && d.visible)
      .map((d) => this.tools.get(d.name))
      .filter((t): t is Tool => t !== undefined)

    // Cache the result
    this.toolCache.set(cacheKey, result)
    return result
  }

  /**
   * Execute a tool by name, with input validation.
   *
   * This is the single choke point for tool invocation — the LLM loop, sandbox
   * `adf.*` calls, and the shell pipeline all land here — so it is also the
   * single place `tool.*` umbilical events are emitted. Every invocation emits
   * exactly one `tool.started` and exactly one `tool.completed`/`tool.failed`,
   * including unknown tools, zod validation failures, and thrown errors.
   */
  async executeTool(
    name: string,
    input: unknown,
    workspace: AdfWorkspace,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    const agentId = context?.agentId
    const base: Record<string, unknown> = {
      ...(ToolRegistry.safeFilePath(workspace) ? { filePath: ToolRegistry.safeFilePath(workspace) } : {}),
      name,
      ...(context?.toolUseId ? { id: context.toolUseId } : {}),
      input: stripInternalToolFlags(input),
    }
    if (!context?.suppressStarted) {
      ToolRegistry.emitToolEvent('tool.started', base, agentId)
    }

    let result: ToolResult
    try {
      result = await this.executeToolInner(name, input, workspace)
    } catch (error) {
      // Thrown here means the failure escaped the per-tool catch (e.g. an abort
      // propagating mid-batch). Record it, then re-throw — callers depend on it.
      ToolRegistry.emitToolEvent('tool.failed', {
        ...base,
        result: { content: `Tool "${name}" execution failed: ${String(error)}`, isError: true },
        isError: true,
      }, agentId)
      throw error
    }

    const isError = result.isError === true
    ToolRegistry.emitToolEvent(isError ? 'tool.failed' : 'tool.completed', {
      ...base,
      result: { content: ToolRegistry.truncateForEvent(result.content), isError },
      isError,
    }, agentId)
    return result
  }

  /** Workspace file path, if the workspace exposes one. Never throws. */
  private static safeFilePath(workspace: AdfWorkspace): string | undefined {
    try {
      return typeof workspace?.getFilePath === 'function' ? workspace.getFilePath() : undefined
    } catch {
      return undefined
    }
  }

  private static truncateForEvent(content: string): string {
    if (typeof content !== 'string') return content
    if (Buffer.byteLength(content, 'utf-8') <= MAX_EVENT_RESULT_BYTES) return content
    return `${content.slice(0, MAX_EVENT_RESULT_BYTES)}\n[truncated]`
  }

  /** Emission is observability — it must never break a tool call. */
  private static emitToolEvent(eventType: string, payload: Record<string, unknown>, agentId?: string): void {
    try {
      emitUmbilicalEvent({ event_type: eventType, payload, ...(agentId ? { agentId } : {}) })
    } catch { /* best-effort */ }
  }

  private async executeToolInner(
    name: string,
    input: unknown,
    workspace: AdfWorkspace
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true }
    }

    // Extract cross-cutting params before schema validation. These are not in individual tool
    // schemas and flow through code execution paths only (stripped from LLM calls by agent executor).
    //   _full       — return full/unabridged output (e.g. db_query)
    //   _authorized — caller is authorized code; tools may skip protection checks
    //                 (e.g. file protections and protected local tables)
    //   _protection_override — a human approved this exact call; bypasses ONLY
    //                 data-protection checks (file/meta/config locks)
    const inputObj = input as Record<string, unknown> | undefined
    const hasFull = inputObj?._full === true
    const hasAuthorized = inputObj?._authorized === true
    const hasProtectionOverride = inputObj?._protection_override === true
    let cleanInput: unknown = input
    if (inputObj && ('_full' in inputObj || '_authorized' in inputObj || '_protection_override' in inputObj)) {
      const { _full: _f, _authorized: _a, _protection_override: _p, ...rest } = inputObj
      cleanInput = rest
    }

    // Strip optional params that match their schema defaults.
    // Some models (e.g. GPT-5-class) fill in every optional param with defaults
    // instead of omitting them, which can cause validation conflicts.
    const sanitized = ToolRegistry.stripSchemaDefaults(cleanInput, tool.inputSchema)

    const parseResult = tool.inputSchema.safeParse(sanitized)
    if (!parseResult.success) {
      return {
        content: `Invalid input for tool "${name}": ${parseResult.error.message}`,
        isError: true
      }
    }

    // Re-attach cross-cutting params for tools that consume them.
    let toolInput: unknown = parseResult.data
    if (hasFull || hasAuthorized || hasProtectionOverride) {
      toolInput = {
        ...(parseResult.data as Record<string, unknown>),
        ...(hasFull ? { _full: true } : {}),
        ...(hasAuthorized ? { _authorized: true } : {}),
        ...(hasProtectionOverride ? { _protection_override: true } : {})
      }
    }

    try {
      return await tool.execute(toolInput, workspace)
    } catch (error) {
      return {
        content: `Tool "${name}" execution failed: ${String(error)}`,
        isError: true
      }
    }
  }

  /**
   * Strip optional properties whose values match their schema defaults.
   * Handles models that fill every optional param instead of omitting them.
   */
  private static stripSchemaDefaults(input: unknown, schema: ZodTypeAny): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input

    const obj = input as Record<string, unknown>
    const shape = (schema as { shape?: Record<string, ZodTypeAny> }).shape
    if (!shape) return input

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      const fieldSchema = shape[key]
      if (!fieldSchema) {
        result[key] = value
        continue
      }

      // Walk through ZodOptional/ZodDefault wrappers to find defaults
      let walker: ZodTypeAny = fieldSchema
      let schemaDefault: unknown = undefined
      let hasDefault = false
      let isOptional = false

      for (let i = 0; i < 5; i++) {
        const def = (walker as { _def?: Record<string, unknown> })._def
        if (!def) break
        if (def.typeName === 'ZodDefault') {
          hasDefault = true
          schemaDefault = typeof def.defaultValue === 'function'
            ? (def.defaultValue as () => unknown)()
            : def.defaultValue
        }
        if (def.typeName === 'ZodOptional') isOptional = true
        if (def.innerType) walker = def.innerType as ZodTypeAny
        else break
      }

      // Strip if optional and value matches the schema default
      if (isOptional && hasDefault && value === schemaDefault) continue
      // Strip injected cross-cutting params (not part of tool schemas)
      if (key === '_async' && value === false) continue
      if (key === '_reason') continue

      result[key] = value
    }
    return result
  }
}
