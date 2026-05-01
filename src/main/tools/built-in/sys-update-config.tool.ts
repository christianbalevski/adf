import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { UPDATABLE_STATES } from '../../../shared/types/adf-v02.types'
import type { AgentConfig } from '../../../shared/types/adf-v02.types'

// Fields agents can never modify, regardless of locks
const DENIED_PATHS = ['adf_version', 'id', 'metadata', 'locked_fields', 'providers'] as const
const DENIED_SET = new Set<string>(DENIED_PATHS)

const HINT = ' Use sys_get_config to inspect the current configuration.'

const InputSchema = z.object({
  path: z.string().min(1)
    .describe(
      'Dot-path to the config field to update. ' +
      'For arrays of named objects, use the name directly (e.g. "tools.fs_read.enabled", "tools.sys_code.enabled"). ' +
      'Numeric indices still work but names are preferred. ' +
      'Examples: "description", "model.temperature", "state", "tools.sys_code.enabled", "tools.sys_code.visible", "triggers.on_chat.enabled".'
    ),
  value: z.unknown()
    .describe('The new value. Any valid JSON (string, number, boolean, object, array, null).'),
  action: z.enum(['set', 'append', 'remove']).optional()
    .describe('Operation: "set" (default) replaces the value at path, "append" pushes to an array, "remove" removes from an array by index.'),
  index: z.number().int().min(0).optional()
    .describe('Array index for action "remove".')
})

type Segment = string | number

export class SysUpdateConfigTool implements Tool {
  readonly name = 'sys_update_config'
  readonly description =
    'Update your operational configuration using a dot-path. ' +
    'Use action "append" to add to arrays, "remove" with index to delete from arrays. ' +
    'For arrays of named objects, use the name directly instead of a numeric index ' +
    '(e.g. "tools.fs_read.enabled" or "tools.fs_read.visible" instead of "tools.3.enabled"). ' +
    'Fields in locked_fields and items marked locked: true cannot be modified. ' +
    'Note: config changes rebuild the system prompt and invalidate the prompt cache. ' +
    'Use sys_get_config to inspect current config before making changes.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  onConfigChanged?: (config: AgentConfig) => void

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const isAuthorized = (input as Record<string, unknown> | undefined)?._authorized === true

    // LLMs sometimes serialize nested objects as JSON strings — coerce them back
    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>
      if (typeof obj.value === 'string') {
        // Try JSON parse first (handles objects, arrays, etc.)
        try {
          const parsed = JSON.parse(obj.value as string)
          if (typeof parsed === 'object' && parsed !== null) obj.value = parsed
        } catch { /* leave as-is */ }
        // Coerce string booleans
        if (obj.value === 'true') obj.value = true
        else if (obj.value === 'false') obj.value = false
        // Coerce numeric strings when path suggests a number
        else if (typeof obj.value === 'string' && /^-?\d+(\.\d+)?$/.test(obj.value)) {
          const pathStr = typeof obj.path === 'string' ? obj.path : ''
          if (pathStr.includes('temperature') || pathStr.includes('_ms') ||
              pathStr.includes('max_') || pathStr.includes('timeout') ||
              pathStr.includes('budget') || pathStr.includes('tokens') ||
              pathStr.includes('level') === false) {
            obj.value = parseFloat(obj.value)
          }
        }
      }
    }

    const parsed = InputSchema.safeParse(input)
    if (!parsed.success) {
      return this.err(`Invalid input: ${parsed.error.issues.map(i => i.message).join('; ')}`)
    }

    try {
      const { path, value, index } = parsed.data
      const action = parsed.data.action ?? 'set'
      const segments = this.parsePath(path)

      // Self-protection: reject paths that target lock or restriction properties
      for (const seg of segments) {
        if (seg === 'locked' || seg === 'locked_fields') {
          return this.err('Cannot modify locking configuration.')
        }
        if (seg === 'restricted' || seg === 'restricted_methods') {
          return this.err('Cannot modify restriction configuration.')
        }
      }

      // Deny list
      if (DENIED_SET.has(String(segments[0]))) {
        return this.err(`'${segments[0]}' cannot be modified.`)
      }

      // Validate action params
      if (action === 'remove' && index === undefined) {
        return this.err('action "remove" requires index.')
      }

      const config = workspace.getAgentConfig()

      // Resolve name-based segments (e.g. "tools.fs_read" → "tools.3")
      const resolved = this.resolveNamedSegments(config, segments)
      if (typeof resolved === 'string') return this.err(resolved)

      // Lock check
      const lockErr = isAuthorized ? null : this.checkLocks(config, resolved)
      if (lockErr) return this.err(lockErr)

      // Field-specific validation (uses original path for pattern matching)
      const valErr = this.validateField(path, value, action)
      if (valErr) return this.err(valErr)

      // Apply the change
      const applyErr = this.applyChange(config, resolved, value, action, index)
      if (applyErr) return this.err(applyErr)

      workspace.setAgentConfig(config)
      this.onConfigChanged?.(config)

      if (action === 'append') {
        return { content: `Appended to ${path}.`, isError: false }
      } else if (action === 'remove') {
        return { content: `Removed index ${index} from ${path}.`, isError: false }
      }
      return { content: `Updated ${path}.`, isError: false }
    } catch (error) {
      return this.err(`Failed to update config: ${String(error)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Path parsing
  // ---------------------------------------------------------------------------

  private parsePath(path: string): Segment[] {
    return path.split('.').map(seg => {
      const n = Number(seg)
      return Number.isInteger(n) && n >= 0 ? n : seg
    })
  }

  // ---------------------------------------------------------------------------
  // Name-based segment resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve name-based segments to numeric indices for arrays of named objects.
   * e.g. ["tools", "fs_read", "enabled"] → ["tools", 3, "enabled"]
   * when config.tools[3].name === "fs_read"
   */
  private resolveNamedSegments(config: AgentConfig, segments: Segment[]): Segment[] | string {
    const resolved: Segment[] = []
    let current: unknown = config

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]

      if (Array.isArray(current) && typeof seg === 'string') {
        // String segment on an array — look up by name property
        const idx = current.findIndex(
          (el: unknown) => el != null && typeof el === 'object' &&
            (el as Record<string, unknown>).name === seg
        )
        if (idx === -1) {
          return `No element named '${seg}' in ${resolved.join('.') || 'root'}.`
        }
        resolved.push(idx)
        current = current[idx]
      } else if (Array.isArray(current) && typeof seg === 'number') {
        resolved.push(seg)
        current = seg >= 0 && seg < current.length ? current[seg] : undefined
      } else if (current != null && typeof current === 'object') {
        resolved.push(seg)
        current = (current as Record<string, unknown>)[String(seg)]
      } else {
        // Can't navigate further — push remaining as-is (apply methods will handle errors)
        resolved.push(seg)
        current = undefined
      }
    }

    return resolved
  }

  // ---------------------------------------------------------------------------
  // Lock checking
  // ---------------------------------------------------------------------------

  private checkLocks(config: AgentConfig, segments: Segment[]): string | null {
    const lockedFields = config.locked_fields ?? []

    // Check locked_fields for every prefix of the path
    let pathSoFar = ''
    for (const seg of segments) {
      if (typeof seg === 'number') continue // skip array indices in prefix matching
      pathSoFar = pathSoFar ? `${pathSoFar}.${seg}` : seg
      if (lockedFields.includes(pathSoFar)) {
        return `'${pathSoFar}' is locked.`
      }
    }

    // Check for locked child fields (prevents bypassing per-field locks via parent replacement)
    const childPrefix = pathSoFar + '.'
    if (lockedFields.some(f => f.startsWith(childPrefix))) {
      return `'${pathSoFar}' contains locked sub-fields. Update individual fields instead.`
    }

    // Walk the config checking locked: true on objects along the path
    let current: unknown = config
    for (let i = 0; i < segments.length; i++) {
      if (current == null || typeof current !== 'object') break
      const seg = segments[i]

      // Check locked on current object before descending
      if (!Array.isArray(current) && 'locked' in (current as Record<string, unknown>)) {
        if ((current as Record<string, unknown>).locked === true) {
          const lockPath = segments.slice(0, i).join('.')
          return `'${lockPath || String(seg)}' is locked.`
        }
      }

      // Descend
      if (Array.isArray(current)) {
        current = current[seg as number]
      } else {
        current = (current as Record<string, unknown>)[String(seg)]
      }
    }

    // Check if the resolved target itself is locked
    if (current != null && typeof current === 'object' && !Array.isArray(current)) {
      if ((current as Record<string, unknown>).locked === true) {
        return `'${segments.join('.')}' is locked.`
      }
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Field validation
  // ---------------------------------------------------------------------------

  private validateField(path: string, value: unknown, action: string): string | null {
    if (path === 'state') {
      if (!UPDATABLE_STATES.includes(value as (typeof UPDATABLE_STATES)[number])) {
        return `state must be one of: ${UPDATABLE_STATES.join(', ')}`
      }
    }

    if (path === 'model.temperature') {
      if (typeof value !== 'number' || value < 0 || value > 2) {
        return 'model.temperature must be a number between 0 and 2'
      }
    }

    if (path === 'logging.default_level') {
      const valid = ['debug', 'info', 'warn', 'error']
      if (typeof value !== 'string' || !valid.includes(value)) {
        return `logging.default_level must be one of: ${valid.join(', ')}`
      }
    }

    if (path === 'logging.max_rows') {
      if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
        return 'logging.max_rows must be a positive integer or null (unlimited)'
      }
    }

    // Shared patterns validation
    if (path === 'serving.shared.patterns' || (path.startsWith('serving.shared.patterns.') && action === 'set')) {
      if (Array.isArray(value) && value.some((s: unknown) => typeof s === 'string' && s.startsWith('messages'))) {
        return 'Shared patterns must not start with "messages"'
      }
    }
    if ((path === 'serving.shared.patterns' && action === 'append') || path.startsWith('serving.shared.patterns.')) {
      if (typeof value === 'string' && value.startsWith('messages')) {
        return 'Shared patterns must not start with "messages"'
      }
    }

    // Route validation (setting or appending a route object)
    if (this.isRouteObjectPath(path, action) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const err = this.validateRoute(value as Record<string, unknown>)
      if (err) return err
    }

    // Route array replacement
    if (path === 'serving.api' && action === 'set' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const err = this.validateRoute(value[i] as Record<string, unknown>)
        if (err) return `routes[${i}]: ${err}`
      }
    }

    // Trigger target validation (setting or appending a target object)
    if (this.isTargetObjectPath(path, action) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const err = this.validateTarget(value as Record<string, unknown>)
      if (err) return err
    }

    // Trigger targets array replacement
    if (/^triggers\.\w+\.targets$/.test(path) && action === 'set' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const err = this.validateTarget(value[i] as Record<string, unknown>)
        if (err) return `targets[${i}]: ${err}`
      }
    }

    return null
  }

  private isRouteObjectPath(path: string, action: string): boolean {
    // serving.api with append, or serving.api.N with set
    return (path === 'serving.api' && action === 'append') ||
           /^serving\.api\.\d+$/.test(path)
  }

  private isTargetObjectPath(path: string, action: string): boolean {
    // triggers.*.targets with append, or triggers.*.targets.N with set
    return (/^triggers\.\w+\.targets$/.test(path) && action === 'append') ||
           /^triggers\.\w+\.targets\.\d+$/.test(path)
  }

  private validateRoute(route: Record<string, unknown>): string | null {
    if (typeof route.path === 'string') {
      if (!route.path.startsWith('/')) return 'Route path must start with "/"'
      if (route.path === '/messages' || route.path.startsWith('/messages/')) {
        return 'Route path must not use reserved "messages" prefix'
      }
    }
    if (typeof route.lambda === 'string') {
      const colonIdx = route.lambda.lastIndexOf(':')
      if (colonIdx <= 0) return 'Lambda must be in format "file.ts:functionName"'
    }
    return null
  }

  private validateTarget(target: Record<string, unknown>): string | null {
    const timings = [target.debounce_ms, target.interval_ms, target.batch_ms].filter(v => v !== undefined)
    if (timings.length > 1) return 'Only one timing modifier allowed per target'
    if (target.batch_count !== undefined && target.batch_ms === undefined) {
      return 'batch_count requires batch_ms'
    }
    if (target.scope !== 'system' && (target.lambda || target.warm !== undefined)) {
      return 'lambda and warm only allowed on system scope targets'
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Apply change
  // ---------------------------------------------------------------------------

  private applyChange(
    config: AgentConfig,
    segments: Segment[],
    value: unknown,
    action: 'set' | 'append' | 'remove',
    index?: number
  ): string | null {
    if (action === 'set') {
      return this.applySet(config, segments, value)
    } else if (action === 'append') {
      return this.applyAppend(config, segments, value)
    } else {
      return this.applyRemove(config, segments, index!)
    }
  }

  private applySet(config: AgentConfig, segments: Segment[], value: unknown): string | null {
    if (segments.length === 0) return 'Empty path.'

    // Navigate to the parent of the final segment, auto-creating intermediates
    let current: unknown = config
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const nextSeg = segments[i + 1]

      if (Array.isArray(current)) {
        if (typeof seg !== 'number' || seg < 0 || seg >= current.length) {
          return `Index ${seg} out of bounds at ${segments.slice(0, i + 1).join('.')}.`
        }
        current = current[seg]
      } else if (current != null && typeof current === 'object') {
        const obj = current as Record<string, unknown>
        const key = String(seg)
        if (obj[key] === undefined || obj[key] === null) {
          // Auto-create intermediate: array if next segment is numeric, else object
          obj[key] = typeof nextSeg === 'number' ? [] : {}
        }
        current = obj[key]
      } else {
        return `Cannot traverse path at '${segments.slice(0, i + 1).join('.')}' — not an object.`
      }
    }

    const finalSeg = segments[segments.length - 1]

    // When replacing an entire array, check for locked elements
    if (Array.isArray(value) && current != null && typeof current === 'object') {
      const existing = Array.isArray(current)
        ? current[finalSeg as number]
        : (current as Record<string, unknown>)[String(finalSeg)]
      if (Array.isArray(existing)) {
        const lockedCount = existing.filter(
          (el: unknown) => el != null && typeof el === 'object' && (el as Record<string, unknown>).locked === true
        ).length
        if (lockedCount > 0) {
          return `Cannot replace array: ${lockedCount} locked element(s). Use append/remove instead.`
        }
      }
    }

    // When replacing an individual array element, check if it's locked
    if (typeof finalSeg === 'number' && Array.isArray(current)) {
      if (finalSeg < 0 || finalSeg >= current.length) {
        return `Index ${finalSeg} out of bounds (${current.length} elements).`
      }
      const existing = current[finalSeg]
      if (existing != null && typeof existing === 'object' && (existing as Record<string, unknown>).locked === true) {
        return `Element at index ${finalSeg} is locked.`
      }
      current[finalSeg] = value
    } else if (current != null && typeof current === 'object' && !Array.isArray(current)) {
      (current as Record<string, unknown>)[String(finalSeg)] = value
    } else {
      return `Cannot set '${segments.join('.')}' — parent is not an object.`
    }

    return null
  }

  private applyAppend(config: AgentConfig, segments: Segment[], value: unknown): string | null {
    // Navigate to the target array, auto-creating intermediates
    let current: unknown = config
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const nextSeg = i < segments.length - 1 ? segments[i + 1] : undefined

      if (Array.isArray(current)) {
        if (typeof seg !== 'number' || seg < 0 || seg >= current.length) {
          return `Index ${seg} out of bounds at ${segments.slice(0, i + 1).join('.')}.`
        }
        current = current[seg]
      } else if (current != null && typeof current === 'object') {
        const obj = current as Record<string, unknown>
        const key = String(seg)
        if (i === segments.length - 1) {
          // Final segment — this should be the array or undefined
          if (obj[key] === undefined || obj[key] === null) {
            obj[key] = []
          }
          current = obj[key]
        } else {
          if (obj[key] === undefined || obj[key] === null) {
            obj[key] = typeof nextSeg === 'number' ? [] : {}
          }
          current = obj[key]
        }
      } else {
        return `Cannot traverse path at '${segments.slice(0, i + 1).join('.')}' — not an object.`
      }
    }

    if (!Array.isArray(current)) {
      return `'${segments.join('.')}' is not an array. Use action "set" instead.`
    }

    current.push(value)
    return null
  }

  private applyRemove(config: AgentConfig, segments: Segment[], index: number): string | null {
    // Navigate to the target array
    let current: unknown = config
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (Array.isArray(current)) {
        if (typeof seg !== 'number' || seg < 0 || seg >= current.length) {
          return `Index ${seg} out of bounds at ${segments.slice(0, i + 1).join('.')}.`
        }
        current = current[seg]
      } else if (current != null && typeof current === 'object') {
        current = (current as Record<string, unknown>)[String(seg)]
      } else {
        return `Cannot traverse path at '${segments.slice(0, i + 1).join('.')}' — not an object.`
      }
    }

    if (!Array.isArray(current)) {
      return `'${segments.join('.')}' is not an array.`
    }

    if (index < 0 || index >= current.length) {
      return `Index ${index} out of bounds (${current.length} elements).`
    }

    // Check if element is locked
    const element = current[index]
    if (element != null && typeof element === 'object' && (element as Record<string, unknown>).locked === true) {
      return `Element at index ${index} is locked.`
    }

    current.splice(index, 1)
    return null
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private err(message: string): ToolResult {
    return { content: message + HINT, isError: true }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
