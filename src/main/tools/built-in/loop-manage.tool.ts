import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { DEFAULT_NEW_LOOP_TOOLS, type LoopConfig } from '../../../shared/types/adf-v02.types'
import {
  LoopConfigSchema,
  LOOP_GOAL_MAX_CHARS,
  LOOP_NAME_PATTERN,
  LOOP_NAME_RULE,
  LOOP_TOOLS_MAX,
  MAX_SIDE_LOOPS
} from '../../adf/adf-schema'
import {
  MAIN_LOOP,
  listAvailableLoopTools,
  validateLoopToolList
} from '../../adf/derive-loop-config'
import {
  LOOP_POOL_UNAVAILABLE,
  resolveLoopPool,
  type LoopPoolAccessor,
  type LoopPoolApi
} from '../../adf/loop-pool.types'

/**
 * Loosely typed on the way in — the real contract is `LoopConfigSchema`, which
 * runs after the merge so `update` validates the *resulting* loop rather than
 * the patch. Keeping the provider schema shallow also keeps the tool JSON
 * small; the error path quotes the exact rule that was broken.
 */
const LoopConfigInputSchema = z.object({
  // Same rule as LoopConfigSchema (single source of truth in adf-schema.ts) so
  // a bad name fails at the provider boundary with the same sentence it would
  // fail with after the merge.
  name: z.string().regex(LOOP_NAME_PATTERN, { message: LOOP_NAME_RULE }).optional().describe(
    'Loop name: 1-32 lowercase chars; unique here, "main" reserved.'
  ),
  goal: z.string().min(1).max(LOOP_GOAL_MAX_CHARS).optional().describe(
    "The loop's charter — it becomes the loop's instructions."
  ),
  enabled: z.boolean().optional().describe('Whether the loop runs. Default true on create.'),
  model: z.record(z.unknown()).optional().describe(
    'Model override for this loop only, same provider as yours. Omit to inherit the agent model.'
  ),
  compact_threshold: z.number().int().positive().nullable().optional().describe(
    'Token count at which this loop auto-compacts. Omit to inherit yours.'
  ),
  tools: z.array(z.string().min(1)).max(LOOP_TOOLS_MAX).optional().describe(
    `Absolute allow-list, intersected with your enabled tools; nothing implicit. Omit for ${DEFAULT_NEW_LOOP_TOOLS.join(' + ')}; [] for a mute loop.`
  )
}).describe('Loop definition. Full definition for create; partial patch for update.')

const InputSchema = z.object({
  // No `list`: that is `loop_list`, an ordinary tool you hold like every other
  // loop does. Two ways to enumerate the same roster was one too many.
  action: z.enum(['create', 'get', 'update', 'delete']).describe(
    'create — define a new inner loop and start it. get — one loop\'s full definition (use loop_list to enumerate them). ' +
    'update — patch an inner loop (re-derives and restarts it). delete — archive its stream to the audit log, then remove it.'
  ),
  name: z.string().min(1).optional().describe('Loop name. Required for get, update and delete.'),
  config: LoopConfigInputSchema.optional().describe('Required for create and update.')
})

type LoopConfigInput = z.infer<typeof LoopConfigInputSchema>

function errorResult(content: string): ToolResult {
  return { content, isError: true }
}

/**
 * The self-curating organism: main creates, inspects, patches and tears down
 * this agent's own side loops at runtime (docs/design/agent-loops-mvp.md §7.2).
 *
 * **Main only.** `deriveLoopConfig` already subtracts it from every side loop's
 * toolset (it is in `LOOP_PROHIBITED_TOOLS`, rejected by `LoopConfigSchema`
 * too), so the runtime guard below is defense in depth against a future
 * registration path that hands the tool to the wrong executor. Loops do not
 * nest.
 *
 * **Ungated by default.** It ships `enabled: true, visible: true` (no
 * `restricted`) in `DEFAULT_TOOLS`. The rationale is attenuation, not
 * convenience: a loop is a strict attenuation of authority main ALREADY holds
 * — `deriveLoopConfig` intersects the loop's allow-list with the host's enabled
 * tools, drops every `restricted` name, and clamps `code_execution` — so
 * `loop_manage` cannot expand the agent's capability surface, only subdivide
 * it. Creating a loop is therefore not an escalation, and gating it would buy
 * no authority the agent did not already have. HIL gating is still driven
 * entirely by the config declaration's `restricted` flag (`agent-executor.ts`
 * `isRestricted = enabled && restricted`), so an owner who flips
 * `restricted: true` back on gets the gate. `requireApproval` below is unused
 * by the executor (gating reads the config, not the tool) and is left `false`
 * only to state intent.
 *
 * **Owner locks still bind.** `create`/`update`/`delete` honour
 * `locked_fields`: if the owner has locked the `loops` config path the tool
 * refuses with the same "'loops' is locked." sentence `sys_update_config` uses.
 * And `delete` (like config-edit removal) PRESERVES `locked: true` timers
 * stamped to the deleted loop — they are kept and logged, never dropped,
 * matching the human-only lock semantics everywhere else.
 *
 * Validation happens twice on purpose: here, so the model gets an actionable
 * message naming the available tools, and again inside the pool, which is the
 * one path every non-tool caller also crosses.
 */
export class LoopManageTool implements Tool {
  readonly name = 'loop_manage'
  readonly description =
    'Create, inspect, update and delete this agent\'s inner cognition loops: named streams inside you (a reflector, a consolidator, a critic) ' +
    'that share your file, identity and credentials but run their own stream with their own goal and a subset of your tools. ' +
    'Use loop_list to see which loops exist; this tool changes them. ' +
    'Deleting a loop archives its stream to the audit log first. Only the main loop can call this, and loops cannot create loops.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const
  readonly requireApproval = false

  private getPool: LoopPoolAccessor

  constructor(getPool: LoopPoolAccessor) {
    this.getPool = getPool
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>

    const callerLoop = workspace.getLoopName()
    if (callerLoop !== MAIN_LOOP) {
      return errorResult(
        `loop_manage is available to the main loop only (you are "${callerLoop}"). ` +
        'Loops do not create or modify loops — ask main with loop_send.'
      )
    }

    const pool = resolveLoopPool(this.getPool)
    if (!pool) return errorResult(LOOP_POOL_UNAVAILABLE)

    try {
      switch (parsed.action) {
        case 'get':
          return this.handleGet(pool, parsed.name)
        case 'create':
          return await this.handleCreate(pool, workspace, parsed.name, parsed.config)
        case 'update':
          return await this.handleUpdate(pool, workspace, parsed.name, parsed.config)
        case 'delete':
          return await this.handleDelete(pool, parsed.name)
      }
    } catch (error) {
      return errorResult(
        `loop_manage ${parsed.action} failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Read-only
  // ---------------------------------------------------------------------------

  private handleGet(
    pool: LoopPoolApi,
    name: string | undefined
  ): ToolResult {
    if (!name) return errorResult('get requires "name".')

    if (name === MAIN_LOOP) {
      return errorResult(
        'main is the implicit host loop — it has no LoopConfig. Its goal is your instructions and its tools are your tools; ' +
        'read them with sys_get_config.'
      )
    }

    const config = pool.getLoop(name)
    if (!config) return this.unknownLoop(pool, name)

    const info = pool.listLoops().find(l => l.name === name)
    return {
      content: JSON.stringify({ ...config, status: info?.status ?? 'idle' }, null, 2),
      isError: false
    }
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  private async handleCreate(
    pool: LoopPoolApi,
    workspace: AdfWorkspace,
    nameArg: string | undefined,
    configArg: LoopConfigInput | undefined
  ): Promise<ToolResult> {
    if (!configArg) return errorResult('create requires "config" (at least name and goal).')

    const name = configArg.name ?? nameArg
    if (!name) return errorResult('create requires a loop name, in "config.name" or "name".')
    if (configArg.name && nameArg && configArg.name !== nameArg) {
      return errorResult(`Conflicting names: "name" is "${nameArg}" but "config.name" is "${configArg.name}".`)
    }

    if (pool.hasLoop(name)) {
      return errorResult(
        name === MAIN_LOOP
          ? 'main already exists — it is the implicit host loop and cannot be created.'
          : `A loop named "${name}" already exists. Use action "update" to change it.`
      )
    }

    // Structural brake: loop concurrency is unbounded and HIL is per-call, so
    // this is the only thing bounding how many minds the agent can spawn.
    const sideLoopCount = pool.listLoops().filter(l => !l.isMain).length
    if (sideLoopCount >= MAX_SIDE_LOOPS) {
      return errorResult(
        `This agent already has ${sideLoopCount} inner loops, the maximum (${MAX_SIDE_LOOPS}). ` +
        'Delete one you no longer need, or widen an existing loop\'s goal instead of adding another mind.'
      )
    }

    const candidate = {
      name,
      goal: configArg.goal,
      enabled: configArg.enabled ?? true,
      ...(configArg.model !== undefined && { model: configArg.model }),
      ...(configArg.compact_threshold !== undefined && { compact_threshold: configArg.compact_threshold }),
      // Omitted `tools` means "you decide" — and a loop that cannot reach the
      // rest of the agent is almost never what was meant, so it defaults to the
      // inter-loop pair. An explicit list (including `[]`) is taken literally:
      // deliberately excluding loop_send is how a mute loop is expressed.
      //
      // Filtered against what this host can actually grant, because a default
      // is a suggestion: an owner who disabled `loop_send` on the agent must
      // still be able to create a loop, not hit "not available on this agent"
      // for a name they never typed. An explicit request for the same name
      // still errors — that one was asked for.
      tools: configArg.tools ?? this.defaultToolsFor(workspace)
    }

    const validated = this.validate(candidate, workspace)
    if ('error' in validated) return errorResult(validated.error)

    const created = await pool.createLoop(validated.config)

    // Report what the loop ACTUALLY got, not what was asked for: derivation
    // still adds loop_compact/loop_clear unless the host disabled or restricted
    // them. Fall back to the resolved request only if the pool predates the
    // effectiveTools contract.
    const requested = validated.config.tools ?? []
    const effective = created?.effectiveTools
    const toolLine = effective
      ? (effective.length ? effective.join(', ') : '(none)')
      : (requested.length ? requested.join(', ') : '(none)')

    return {
      content:
        `Created loop "${name}"${validated.config.enabled ? ' (running)' : ' (disabled)'}.\n` +
        `Goal: ${validated.config.goal}\n` +
        `Tools: ${toolLine}.${this.disabledNote(validated.disabled)}\n` +
        'Give it work by targeting it from a trigger or timer, or with loop_send.',
      isError: false
    }
  }

  /** `DEFAULT_NEW_LOOP_TOOLS`, minus anything this host cannot grant. */
  private defaultToolsFor(workspace: AdfWorkspace): string[] {
    const available = new Set(listAvailableLoopTools(workspace.getAgentConfig()))
    return DEFAULT_NEW_LOOP_TOOLS.filter(name => available.has(name))
  }

  private async handleUpdate(
    pool: LoopPoolApi,
    workspace: AdfWorkspace,
    name: string | undefined,
    patch: LoopConfigInput | undefined
  ): Promise<ToolResult> {
    if (!name) return errorResult('update requires "name".')
    if (!patch) return errorResult('update requires "config" with the fields to change.')

    if (name === MAIN_LOOP) {
      return errorResult(
        'main is the implicit host loop and is not managed here — change its instructions, model or tools with sys_update_config.'
      )
    }

    const existing = pool.getLoop(name)
    if (!existing) return this.unknownLoop(pool, name)

    if (patch.name && patch.name !== name) {
      return errorResult(
        `Loops cannot be renamed ("${name}" → "${patch.name}") — the name binds the executor to its stream. ` +
        'Create the new loop and delete the old one if that is what you want.'
      )
    }

    const merged = {
      ...existing,
      ...(patch.goal !== undefined && { goal: patch.goal }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.model !== undefined && { model: patch.model }),
      ...(patch.compact_threshold !== undefined && { compact_threshold: patch.compact_threshold }),
      ...(patch.tools !== undefined && { tools: patch.tools }),
      name
    }

    const validated = this.validate(merged, workspace)
    if ('error' in validated) return errorResult(validated.error)

    // Send the pool a patch, not the merge: it re-reads the live config itself,
    // so a concurrent edit is not silently overwritten by our stale snapshot.
    const outgoing: Partial<LoopConfig> = {
      ...(patch.goal !== undefined && { goal: validated.config.goal }),
      ...(patch.enabled !== undefined && { enabled: validated.config.enabled }),
      ...(patch.model !== undefined && { model: validated.config.model }),
      ...(patch.compact_threshold !== undefined && { compact_threshold: validated.config.compact_threshold }),
      ...(patch.tools !== undefined && { tools: validated.config.tools })
    }

    if (Object.keys(outgoing).length === 0) {
      return errorResult(
        'Nothing to update — "config" named no changeable field (goal, enabled, model, compact_threshold, tools).'
      )
    }

    await pool.updateLoop(name, outgoing)

    return {
      content:
        `Updated loop "${name}": ${Object.keys(outgoing).join(', ')}. It has been re-derived and restarted.` +
        this.disabledNote(validated.disabled),
      isError: false
    }
  }

  private async handleDelete(
    pool: LoopPoolApi,
    name: string | undefined
  ): Promise<ToolResult> {
    if (!name) return errorResult('delete requires "name".')

    if (name === MAIN_LOOP) {
      return errorResult('main is your own loop and cannot be deleted.')
    }

    if (!pool.getLoop(name)) return this.unknownLoop(pool, name)

    const result = await pool.deleteLoop(name)

    return {
      content:
        `Deleted loop "${name}". ` +
        `Its stream (${result.archivedEntries} ${result.archivedEntries === 1 ? 'entry' : 'entries'}) was archived to the audit log under "loop:${name}".`,
      isError: false
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Schema validation (name/goal/enabled, hard prohibited names) followed by
   * the host-relative tool check that the schema cannot do — it needs this
   * agent's tool declarations.
   *
   * Only two of the four buckets fail. An UNKNOWN name is a typo or an
   * invention and failing is how the model learns the real list; a PROHIBITED
   * name is the security boundary. A name the owner has merely DISABLED is
   * neither — the loop is created carrying it, ungranted for now, and `disabled`
   * comes back so the success message can say which names did not take effect.
   */
  private validate(
    candidate: Record<string, unknown>,
    workspace: AdfWorkspace
  ): { config: LoopConfig; disabled: string[] } | { error: string } {
    const parsed = LoopConfigSchema.safeParse(candidate)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return { error: `Invalid loop config — ${issues}` }
    }

    const config = parsed.data as unknown as LoopConfig

    const requested = config.tools ?? []
    if (requested.length === 0) return { config, disabled: [] }

    const host = workspace.getAgentConfig()
    const { unknown, disabled, prohibited } = validateLoopToolList(host, requested)

    if (unknown.length > 0 || prohibited.length > 0) {
      const parts: string[] = []
      if (unknown.length > 0) {
        parts.push(`no such tool on this agent: ${unknown.join(', ')}`)
      }
      if (prohibited.length > 0) {
        parts.push(
          `never grantable to a loop: ${prohibited.join(', ')} ` +
          '(config self-modification, agent creation, loop management, and anything needing human approval — ' +
          'a loop has no channel to ask a human)'
        )
      }
      return {
        error:
          `Cannot grant those tools — ${parts.join('; ')}. ` +
          `Available: ${listAvailableLoopTools(host).join(', ') || '(none)'}.`
      }
    }

    return { config, disabled }
  }

  /** The "…but you won't get these yet" line, or '' when nothing was excluded. */
  private disabledNote(disabled: string[]): string {
    if (disabled.length === 0) return ''
    return `\nExcluded for now: ${disabled.join(', ')} — ` +
      `${disabled.length === 1 ? 'that tool is' : 'those tools are'} disabled on this agent, so the loop carries ` +
      `${disabled.length === 1 ? 'the name' : 'the names'} but no grant. Enable ` +
      `${disabled.length === 1 ? 'it' : 'them'} on yourself and the loop gets ${disabled.length === 1 ? 'it' : 'them'} automatically.`
  }

  private unknownLoop(
    pool: LoopPoolApi,
    name: string
  ): ToolResult {
    const side = pool.listLoops().filter(l => !l.isMain).map(l => l.name)
    return errorResult(
      `No inner loop named "${name}". ${side.length ? `Inner loops: ${side.join(', ')}.` : 'This agent has no inner loops yet.'}`
    )
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
