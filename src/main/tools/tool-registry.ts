import type { ZodTypeAny } from 'zod'
import type { Tool } from './tool.interface'
import type { ToolResult } from '../../shared/types/tool.types'
import type { ToolDeclaration } from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'

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
   */
  async executeTool(
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
    const inputObj = input as Record<string, unknown> | undefined
    const hasFull = inputObj?._full === true
    const hasAuthorized = inputObj?._authorized === true
    let cleanInput: unknown = input
    if (inputObj && ('_full' in inputObj || '_authorized' in inputObj)) {
      const { _full: _f, _authorized: _a, ...rest } = inputObj
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
    if (hasFull || hasAuthorized) {
      toolInput = {
        ...(parseResult.data as Record<string, unknown>),
        ...(hasFull ? { _full: true } : {}),
        ...(hasAuthorized ? { _authorized: true } : {})
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
