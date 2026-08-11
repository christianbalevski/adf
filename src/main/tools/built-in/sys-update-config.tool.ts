import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { UPDATABLE_STATES, RESERVED_AGENT_PATH_SEGMENTS, DEFAULT_TOOLS } from '../../../shared/types/adf-v02.types'
import type { AgentConfig, ToolDeclaration } from '../../../shared/types/adf-v02.types'
import { currentSourceOrUnknown } from '../../runtime/execution-context'
import { AgentConfigSchema } from '../../adf/adf-schema'

// Fields agents can never modify, regardless of locks
const DENIED_PATHS = ['adf_version', 'id', 'metadata', 'locked_fields', 'providers'] as const
const DENIED_SET = new Set<string>(DENIED_PATHS)

/**
 * Guard-system toggles. Per project philosophy the agent may REQUEST any change
 * a human could make (HIL), but the guards that decide what needs approval in
 * the first place are not agent-reachable at all — a hard error with no
 * ProtectionDenial, so there is no approval path and no one-time override.
 * Only genuine guard switches belong here; ordinary capability toggles
 * (code_execution.*, tools.*.enabled, limits.*) stay HIL-gated.
 */
const GUARD_PATHS = [
  'security',                                  // wholesale replacement of the guard block
  'security.allow_unsigned',
  'security.require_middleware_authorization',
  'security.middleware',
  'security.fetch_middleware',
  'security.allow_local_fetch'                 // disables the sys_fetch SSRF guard
] as const

/** True when `path` targets a guard toggle (exact match or a child of one). */
function isGuardPath(path: string, action: string): boolean {
  for (const guard of GUARD_PATHS) {
    if (path === guard) {
      // Bare "security" is only a guard write when the whole block is replaced.
      if (guard === 'security') { if (action === 'set') return true; continue }
      return true
    }
    if (guard !== 'security' && path.startsWith(guard + '.')) return true
  }
  return false
}

/**
 * Leaf names whose value is numeric. The previous guard included
 * `pathStr.includes('level') === false`, which is true for almost every path
 * and therefore coerced numeric-looking strings everywhere (e.g. a version
 * string "1.0" set on `description`). Coerce only where a number is expected.
 */
const NUMERIC_LEAF_NAMES = new Set([
  'temperature', 'top_p', 'level', 'port', 'chain_id', 'max_rows', 'max_events', 'index'
])
const NUMERIC_LEAF_SUFFIX =
  /(_ms|_bytes|_tokens|_chars|_count|_rows|_events|_turns|_threshold|_budget|_sec|_size|_runs|_port|_delay)$/

function expectsNumber(path: string): boolean {
  const leaf = path.split('.').pop() ?? ''
  return NUMERIC_LEAF_NAMES.has(leaf) || NUMERIC_LEAF_SUFFIX.test(leaf)
}

/** Config arrays whose elements are identified by `name`/`id` declarations. */
const DECLARATION_ARRAYS = new Set([
  'tools', 'serving.api', 'ws_connections', 'stream_bindings', 'umbilical_taps', 'mcp.servers'
])

function declarationKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.name === 'string' && obj.name) return obj.name
  if (typeof obj.id === 'string' && obj.id) return obj.id
  return null
}

/** Restriction baseline for a tool: current declaration, else the built-in default. */
function effectiveToolRestrictions(config: AgentConfig, name: string): { restricted: boolean; locked: boolean } {
  const decl = config.tools?.find((t) => t.name === name) as ToolDeclaration | undefined
  const fallback = DEFAULT_TOOLS.find((t) => t.name === name)
  return {
    restricted: decl?.restricted ?? fallback?.restricted ?? false,
    locked: decl?.locked ?? false
  }
}

function cloneConfig(config: AgentConfig): AgentConfig {
  return JSON.parse(JSON.stringify(config)) as AgentConfig
}

/**
 * Restore `target` in place from `snapshot`, keeping the object identity the
 * workspace and its listeners already hold.
 */
function restoreConfig(target: AgentConfig, snapshot: AgentConfig): void {
  const t = target as unknown as Record<string, unknown>
  for (const key of Object.keys(t)) delete t[key]
  Object.assign(t, snapshot as unknown as Record<string, unknown>)
}

/**
 * Schema violations keyed by normalized location (array indices collapsed to
 * `#`), so an index shift from a `remove` is not mistaken for a new violation.
 */
function schemaIssueKeys(config: AgentConfig): Map<string, string> {
  const result = AgentConfigSchema.safeParse(config)
  const issues = new Map<string, string>()
  if (result.success) return issues
  for (const issue of result.error.issues) {
    const location = issue.path.map((seg) => (typeof seg === 'number' ? '#' : seg)).join('.')
    issues.set(`${location}|${issue.message}`, `${location || '(root)'}: ${issue.message}`)
  }
  return issues
}

const HINT = ' Use sys_get_config to inspect the current configuration.'

// True when a shared-file glob's first path segment is a reserved protocol
// mailbox (inbox/card/health) — those paths are served by the mesh protocol,
// so a matching shared file could never be reached.
function startsWithReservedSegment(pattern: string): boolean {
  const firstSegment = pattern.replace(/^\/+/, '').split('/')[0]
  return (RESERVED_AGENT_PATH_SEGMENTS as readonly string[]).includes(firstSegment)
}

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

/** A lock denial that a human may override via HIL approval. */
type LockViolation = { message: string; target: string; level: 'locked' | 'locked_fields' }

export class SysUpdateConfigTool implements Tool {
  readonly name = 'sys_update_config'
  readonly description =
    'Update your operational configuration using a dot-path. ' +
    'Use action "append" to add to arrays, "remove" with index to delete from arrays. ' +
    'For arrays of named objects, use the name directly instead of a numeric index ' +
    '(e.g. "tools.fs_read.enabled" or "tools.fs_read.visible" instead of "tools.3.enabled"). ' +
    'Fields in locked_fields and items marked locked: true cannot be modified. ' +
    'Note: config changes rebuild the system prompt and invalidate the prompt cache. ' +
    'Changing "name" also renames your .adf file to match (applied when you stop). ' +
    'Use sys_get_config to inspect current config before making changes.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  onConfigChanged?: (config: AgentConfig) => void

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const isAuthorized = (input as Record<string, unknown> | undefined)?._authorized === true
    const isOverride = (input as Record<string, unknown> | undefined)?._protection_override === true

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
        // Coerce numeric strings only where the target field is actually numeric
        else if (typeof obj.value === 'string' && /^-?\d+(\.\d+)?$/.test(obj.value)) {
          const pathStr = typeof obj.path === 'string' ? obj.path : ''
          if (expectsNumber(pathStr)) {
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

      // Guard-system config is hard-denied: a plain error, no ProtectionDenial,
      // so there is no HIL approval or override path (see GUARD_PATHS).
      if (isGuardPath(path, action)) {
        return this.err(
          `'${path}' is a guard-system setting and cannot be changed by the agent. ` +
          'Ask your principal to change it in the app.'
        )
      }

      // Validate action params
      if (action === 'remove' && index === undefined) {
        return this.err('action "remove" requires index.')
      }

      const config = workspace.getAgentConfig()

      // Typo guard: a set/append may not invent a brand-new top-level branch.
      // Known schema keys and keys already present in the config are allowed.
      if (action !== 'remove') {
        const top = String(segments[0])
        const knownTopLevel = new Set([
          ...Object.keys(AgentConfigSchema.shape),
          ...Object.keys(config as unknown as Record<string, unknown>)
        ])
        if (!knownTopLevel.has(top)) {
          return this.err(`'${top}' is not a known configuration section.`)
        }
      }

      // Resolve name-based segments (e.g. "tools.fs_read" → "tools.3")
      const resolved = this.resolveNamedSegments(config, segments)
      if (typeof resolved === 'string') return this.err(resolved)

      // Lock check. We compute it even for authorized/override callers so a
      // bypass of a REAL lock can be audited + marked below (No Secrets).
      const lockViolation = this.checkLocks(config, resolved)
      if (lockViolation && !isAuthorized && !isOverride) {
        return this.errProtected(lockViolation, this.lockDescription(path, value, action))
      }

      // Field-specific validation (uses original path for pattern matching)
      const valErr = this.validateField(path, value, action)
      if (valErr) return this.err(valErr)

      // Declaration integrity: no shadowing duplicates, no self-de-restriction
      const declErr = this.checkDeclarationIntegrity(config, resolved, value, action)
      if (declErr) return this.err(declErr)

      // Snapshot for the schema before/after comparison + rollback below
      const snapshot = cloneConfig(config)
      const issuesBefore = schemaIssueKeys(snapshot)

      // Apply the change
      const applyErr = this.applyChange(config, resolved, value, action, index, isOverride)
      if (applyErr) return typeof applyErr === 'string'
        ? this.err(applyErr)
        : this.errProtected(applyErr, this.lockDescription(path, value, action))

      // Reject only violations this change INTRODUCED — a config that was
      // already invalid stays editable instead of becoming permanently frozen.
      const issuesAfter = schemaIssueKeys(config)
      const introduced = [...issuesAfter.keys()].filter((key) => !issuesBefore.has(key))
      if (introduced.length > 0 || issuesAfter.size > issuesBefore.size) {
        restoreConfig(config, snapshot)
        const detail = introduced.length > 0
          ? introduced.slice(0, 3).map((key) => issuesAfter.get(key)).join('; ')
          : [...issuesAfter.values()].slice(0, 3).join('; ')
        return this.err(`Change rejected — it would make the configuration invalid: ${detail}`)
      }

      workspace.setAgentConfig(config)
      this.onConfigChanged?.(config)

      // No Secrets: a locked setting changed by an authorized/human bypass must
      // never be silent — audit it and append a visible marker to the result.
      let marker = ''
      if (lockViolation && (isAuthorized || isOverride)) {
        const reason = isOverride
          ? 'human-approved override'
          : `authorized code bypass (${currentSourceOrUnknown()})`
        workspace.insertLog?.('warn', 'protection', 'bypass', lockViolation.target,
          `Changed locked setting "${lockViolation.target}" (${lockViolation.level}) — ${reason}`)
        marker = ` (⚠ protection override: ${lockViolation.level}, ${isOverride ? 'human-approved' : 'authorized'})`
      }

      if (action === 'append') {
        return { content: `Appended to ${path}.${marker}`, isError: false }
      } else if (action === 'remove') {
        return { content: `Removed index ${index} from ${path}.${marker}`, isError: false }
      }
      return { content: `Updated ${path}.${marker}`, isError: false }
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

  private checkLocks(config: AgentConfig, segments: Segment[]): LockViolation | null {
    const lockedFields = config.locked_fields ?? []

    // Check locked_fields for every prefix of the path
    let pathSoFar = ''
    for (const seg of segments) {
      if (typeof seg === 'number') continue // skip array indices in prefix matching
      pathSoFar = pathSoFar ? `${pathSoFar}.${seg}` : seg
      if (lockedFields.includes(pathSoFar)) {
        return { message: `'${pathSoFar}' is locked.`, target: pathSoFar, level: 'locked_fields' }
      }
    }

    // Check for locked child fields (prevents bypassing per-field locks via parent replacement)
    const childPrefix = pathSoFar + '.'
    if (lockedFields.some(f => f.startsWith(childPrefix))) {
      return {
        message: `'${pathSoFar}' contains locked sub-fields. Update individual fields instead.`,
        target: pathSoFar,
        level: 'locked_fields'
      }
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
          return { message: `'${lockPath || String(seg)}' is locked.`, target: lockPath || String(seg), level: 'locked' }
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
        return { message: `'${segments.join('.')}' is locked.`, target: segments.join('.'), level: 'locked' }
      }
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Field validation
  // ---------------------------------------------------------------------------

  private validateField(path: string, value: unknown, action: string): string | null {
    if (path === 'name') {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return 'name must be a non-empty string'
      }
      // The .adf file is renamed to match the agent name, so it must be a
      // valid file name on all platforms.
      if (/[<>:"/\\|?*\u0000-\u001f]/.test(value) || value.trim().endsWith('.')) {
        return 'name contains characters not allowed in file names'
      }
    }

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

    // Shared patterns validation — a pattern may not start with a reserved
    // protocol-mailbox segment (inbox/card/health). Files under those segments
    // are unreachable anyway (the mesh server's reserved-segment guard 404s
    // them), so reject at config time with a clear error.
    if (path === 'serving.shared.patterns' || (path.startsWith('serving.shared.patterns.') && action === 'set')) {
      if (Array.isArray(value) && value.some((s: unknown) => typeof s === 'string' && startsWithReservedSegment(s))) {
        return `Shared patterns must not start with a reserved segment (${RESERVED_AGENT_PATH_SEGMENTS.join('/')})`
      }
    }
    if ((path === 'serving.shared.patterns' && action === 'append') || path.startsWith('serving.shared.patterns.')) {
      if (typeof value === 'string' && startsWithReservedSegment(value)) {
        return `Shared patterns must not start with a reserved segment (${RESERVED_AGENT_PATH_SEGMENTS.join('/')})`
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
      const firstSegment = route.path.replace(/^\/+/, '').split('/')[0]
      if ((RESERVED_AGENT_PATH_SEGMENTS as readonly string[]).includes(firstSegment)) {
        return `Route path must not use reserved segment "${firstSegment}" (${RESERVED_AGENT_PATH_SEGMENTS.join('/')} are protocol mailboxes)`
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
  // Declaration integrity
  // ---------------------------------------------------------------------------

  /**
   * Stops the "fresh declaration" self-de-restriction route. The path-segment
   * guard blocks `tools.sys_update_config.restricted`, but an
   * `append` of `{ name: 'sys_update_config', restricted: false }` contains no
   * banned segment and would shadow the restricted entry. Two rules:
   *
   *  1. An appended (or newly set) declaration may not reuse the `name`/`id` of
   *     an existing element in that array — duplicates are always shadowing.
   *  2. A declaration may not carry `restricted: false` / `locked: false` when
   *     the tool's effective declaration (current config, else DEFAULT_TOOLS)
   *     has that flag true.
   */
  private checkDeclarationIntegrity(
    config: AgentConfig,
    segments: Segment[],
    value: unknown,
    action: 'set' | 'append' | 'remove'
  ): string | null {
    if (action === 'remove') return null

    // Normalize the array this write targets. Segments are already resolved, so
    // both "tools", "tools.3" and "tools.sys_code" collapse to "tools".
    const normalized = segments.filter((seg) => typeof seg !== 'number').join('.')
    if (!DECLARATION_ARRAYS.has(normalized)) return null

    const isElementSet = action === 'set' && typeof segments[segments.length - 1] === 'number'
    const incoming: unknown[] =
      action === 'append' ? [value]
        : isElementSet ? [value]
          : Array.isArray(value) ? value
            : []
    if (incoming.length === 0) return null

    // Existing siblings, minus the element being replaced in an element-set.
    const existingArray = this.readArrayAt(config, isElementSet ? segments.slice(0, -1) : segments)
    const replacedIndex = isElementSet ? (segments[segments.length - 1] as number) : -1
    const siblings = (existingArray ?? []).filter((_, i) => i !== replacedIndex)

    const seen = new Set<string>()
    for (const entry of incoming) {
      const key = declarationKey(entry)
      if (!key) continue

      if (seen.has(key) || siblings.some((el) => declarationKey(el) === key)) {
        return `A declaration named '${key}' already exists in '${normalized}'. ` +
          `Update the existing entry instead of adding a duplicate.`
      }
      seen.add(key)

      const decl = entry as Record<string, unknown>
      if (normalized === 'tools') {
        const effective = effectiveToolRestrictions(config, key)
        if (effective.restricted && decl.restricted === false) {
          return `Cannot declare '${key}' with restricted: false — it is a restricted tool.`
        }
        if (effective.locked && decl.locked === false) {
          return `Cannot declare '${key}' with locked: false — it is locked.`
        }
      } else {
        // Routes/connections/taps: never let a write clear an existing lock.
        const current = siblings.find((el) => declarationKey(el) === key) as Record<string, unknown> | undefined
        if (current?.locked === true && decl.locked === false) {
          return `Cannot declare '${key}' with locked: false — it is locked.`
        }
      }
    }
    return null
  }

  /** Read the array at `segments`, or null when the path is not an array. */
  private readArrayAt(config: AgentConfig, segments: Segment[]): unknown[] | null {
    let current: unknown = config
    for (const seg of segments) {
      if (current == null || typeof current !== 'object') return null
      current = Array.isArray(current)
        ? current[seg as number]
        : (current as Record<string, unknown>)[String(seg)]
    }
    return Array.isArray(current) ? current : null
  }

  // ---------------------------------------------------------------------------
  // Apply change
  // ---------------------------------------------------------------------------

  private applyChange(
    config: AgentConfig,
    segments: Segment[],
    value: unknown,
    action: 'set' | 'append' | 'remove',
    index?: number,
    isOverride?: boolean
  ): string | LockViolation | null {
    if (action === 'set') {
      return this.applySet(config, segments, value, isOverride)
    } else if (action === 'append') {
      return this.applyAppend(config, segments, value)
    } else {
      return this.applyRemove(config, segments, index!, isOverride)
    }
  }

  private applySet(config: AgentConfig, segments: Segment[], value: unknown, isOverride?: boolean): string | LockViolation | null {
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
        if (lockedCount > 0 && !isOverride) {
          return {
            message: `Cannot replace array: ${lockedCount} locked element(s). Use append/remove instead.`,
            target: segments.join('.'),
            level: 'locked'
          }
        }
      }
    }

    // When replacing an individual array element, check if it's locked
    if (typeof finalSeg === 'number' && Array.isArray(current)) {
      if (finalSeg < 0 || finalSeg >= current.length) {
        return `Index ${finalSeg} out of bounds (${current.length} elements).`
      }
      const existing = current[finalSeg]
      if (existing != null && typeof existing === 'object' && (existing as Record<string, unknown>).locked === true && !isOverride) {
        return { message: `Element at index ${finalSeg} is locked.`, target: segments.join('.'), level: 'locked' }
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

  private applyRemove(config: AgentConfig, segments: Segment[], index: number, isOverride?: boolean): string | LockViolation | null {
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
    if (element != null && typeof element === 'object' && (element as Record<string, unknown>).locked === true && !isOverride) {
      return { message: `Element at index ${index} is locked.`, target: segments.join('.'), level: 'locked' }
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

  /** A human-overridable lock denial: carries structured protection detail so callers can start HIL. */
  private errProtected(v: LockViolation, description?: string): ToolResult {
    return {
      content: v.message + HINT,
      isError: true,
      protection: { kind: 'config_lock', target: v.target, level: v.level, description }
    }
  }

  /**
   * Compact human-facing title for a locked-setting change, built from the
   * ORIGINAL dot-path (nicer than the resolved numeric-index target). Rendered
   * as the HIL approval title. Names the concrete toggle when it can.
   */
  private lockDescription(path: string, value: unknown, action: 'set' | 'append' | 'remove'): string {
    if (action === 'set' && typeof value === 'boolean' && /\.enabled$/.test(path)) {
      return `${value ? 'Enable' : 'Disable'} ${path.replace(/\.enabled$/, '')} — changing a locked setting`
    }
    if (action === 'remove') return `Remove an item from "${path}" — changing a locked setting`
    if (action === 'append') return `Add to "${path}" — changing a locked setting`
    return `Change locked setting "${path}"`
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
