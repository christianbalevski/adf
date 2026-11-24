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
  LOOP_DEFAULT_ON_TOOLS,
  MAIN_LOOP,
  listAvailableLoopTools,
  validateLoopToolList
} from '../../adf/derive-loop-config'
import {
  LOOP_AUTOSTART_MESSAGE,
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
  goal: z.string().max(LOOP_GOAL_MAX_CHARS).optional().describe(
    "The loop's charter, appended to its instructions. Optional: without one the loop works on whatever it is sent. Required when autostart is true."
  ),
  enabled: z.boolean().optional().describe('Whether the loop runs. Default true on create.'),
  autostart: z.boolean().optional().describe(
    'Run a first turn on the goal without waiting to be addressed: now on create, and again whenever the agent starts. ' +
    'Default true on create, and needs a goal: creating without a goal requires autostart false. ' +
    'false: it only runs when a trigger, timer or loop_send targets it.'
  ),
  autonomous: z.boolean().optional().describe(
    'Keep turning after text-only responses until the loop calls sys_set_state. Not inherited from you; default false. Grant sys_set_state alongside.'
  ),
  model: z.record(z.unknown()).optional().describe(
    'Model override for this loop only, same provider as yours. Omit to inherit the agent model.'
  ),
  compact_threshold: z.number().int().positive().nullable().optional().describe(
    'Token count at which this loop auto-compacts. Omit to inherit yours.'
  ),
  tools: z.array(z.string().min(1)).max(LOOP_TOOLS_MAX).optional().describe(
    `Absolute allow-list, intersected with your enabled tools; nothing implicit. Omit for ${DEFAULT_NEW_LOOP_TOOLS.join(' + ')}; [] for a mute loop. Include sys_set_state to yield.`
  )
}).describe('Loop definition. Full definition for create; partial patch for update.')

const InputSchema = z.object({
  // No `list`: that is `loop_list`, an ordinary tool you hold like every other
  // loop does. Two ways to enumerate the same roster was one too many.
  action: z.enum(['create', 'get', 'update', 'delete']).describe(
    'create — define a new inner loop and start it (with config.autostart, the default, it runs its first turn right away). ' +
    'get — one loop\'s full definition (use loop_list to enumerate them). ' +
    'update — patch an inner loop (re-derives and restarts it; enabled:false stops it immediately). ' +
    'delete — stop it (mid-turn included), archive its stream to the audit log, then remove it.'
  ),
  name: z.string().min(1).optional().describe('Loop name. Required for get, update and delete.'),
  config: LoopConfigInputSchema.optional().describe('Required for create and update.')
})

type LoopConfigInput = z.infer<typeof LoopConfigInputSchema>

function errorResult(content: string): ToolResult {
  return { content, isError: true }
}

/**
 * The self-curating organism: the agent creates, inspects, patches and tears
 * down its own side loops at runtime (docs/design/agent-loops-mvp.md §7.2).
 *
 * **Any loop that holds it.** The roster is flat: a side loop granted this
 * tool manages its siblings, and what it creates is a sibling, never a child
 * (derived configs carry `loops: []`). A loop may not update or delete itself:
 * either stops the caller's own runtime from inside its own turn, which aborts
 * that turn and then waits out the pool's stop-settle timeout on itself.
 *
 * **Ungated by default.** It ships `enabled: true, visible: true` (no
 * `restricted`) in `DEFAULT_TOOLS`. A loop never holds more than the agent
 * already does — `deriveLoopConfig` intersects the loop's allow-list with the
 * host's enabled tools and keeps each granted tool's `restricted` flag — so
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
    'Create, inspect, update and delete this agent\'s inner cognition loops: named streams inside you ' +
    'that share your file, identity and credentials but run their own stream with their own goal and a subset of your tools. ' +
    'Use loop_list to see which loops exist; this tool changes them. ' +
    'Deleting a loop archives its stream to the audit log first. Loops do not nest: a loop that creates one adds a sibling, manages only loops whose tools it holds, and cannot update or delete itself.'
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
    // Updating or deleting the calling loop stops its own runtime mid-turn.
    if ((parsed.action === 'update' || parsed.action === 'delete') && parsed.name === callerLoop && callerLoop !== MAIN_LOOP) {
      return errorResult(
        `A loop cannot ${parsed.action} itself (you are "${callerLoop}"): that would stop the turn making the call. ` +
        'Ask main or another loop to do it with loop_send.'
      )
    }

    const pool = resolveLoopPool(this.getPool)
    if (!pool) return errorResult(LOOP_POOL_UNAVAILABLE)

    try {
      switch (parsed.action) {
        case 'get':
          return this.handleGet(pool, parsed.name)
        case 'create':
          return await this.handleCreate(pool, workspace, callerLoop, parsed.name, parsed.config)
        case 'update':
          return await this.handleUpdate(pool, workspace, callerLoop, parsed.name, parsed.config)
        case 'delete':
          return await this.handleDelete(pool, callerLoop, parsed.name)
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
    callerLoop: string,
    nameArg: string | undefined,
    configArg: LoopConfigInput | undefined
  ): Promise<ToolResult> {
    if (!configArg) return errorResult('create requires "config" (at least a name).')

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
      ...(configArg.goal !== undefined && { goal: configArg.goal }),
      enabled: configArg.enabled ?? true,
      // Persisted, like the agent's own `autostart`: the pool re-kicks the loop
      // on every agent start. Default on — a loop nobody addresses is idle,
      // and creators expect the thing they just made to get going.
      autostart: configArg.autostart ?? true,
      ...(configArg.autonomous !== undefined && { autonomous: configArg.autonomous }),
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
      // From an inner loop, the default is also cut to what that loop holds.
      tools: configArg.tools ?? this.defaultToolsFor(workspace).filter(n => this.toolsBeyondCaller(pool, callerLoop, [n]).length === 0)
    }

    const validated = this.validate(candidate, workspace)
    if ('error' in validated) return errorResult(validated.error)
    const beyond = this.toolsBeyondCaller(pool, callerLoop, validated.config.tools ?? [])
    if (beyond.length > 0) {
      return errorResult(
        `"${callerLoop}" can only give a loop tools it holds itself; it does not hold ${beyond.join(', ')}. ` +
        'Ask main to create this loop with loop_send.'
      )
    }

    const created = await pool.createLoop(validated.config)

    // Report what the loop ACTUALLY got, not what was asked for: derivation
    // still adds loop_compact/loop_clear unless the host disabled them. Fall
    // back to the resolved request only if the pool predates the
    // effectiveTools contract.
    const requested = validated.config.tools ?? []
    const effective = created?.effectiveTools
    const toolLine = effective
      ? (effective.length ? effective.join(', ') : '(none)')
      : (requested.length ? requested.join(', ') : '(none)')

    // A loop is event-driven: enabled means it CAN take a turn, not that it
    // does. Without a first message it sits idle until a trigger, timer or
    // loop_send names it. With autostart the caller kicks it off now through the
    // normal loop_send path (the wake row is appended and audited like any
    // other interior message); the pool repeats that on every agent start.
    let startLine: string
    if (!validated.config.enabled) {
      startLine = 'It is disabled; enable it with update to let it run.'
    } else if (!validated.config.autostart) {
      startLine = 'It is waiting: give it work by targeting it from a trigger or timer, or with loop_send.'
    } else {
      const sent = await pool.sendToLoop(callerLoop, name, LOOP_AUTOSTART_MESSAGE, true)
      startLine = (sent.woke
        ? 'It is running its first turn on its goal now'
        : `Its kickoff message was delivered but it has not started${sent.reason ? ` (${sent.reason})` : ''}`) +
        ', and it will run a first turn again whenever this agent starts.'
    }

    return {
      content:
        `Created loop "${name}"${validated.config.enabled ? ' (running)' : ' (disabled)'}.\n` +
        `Goal: ${validated.config.goal?.trim() ? validated.config.goal : '(none)'}\n` +
        `Tools: ${toolLine}.${this.disabledNote(validated.disabled)}\n` +
        startLine,
      isError: false
    }
  }

  /**
   * Tool names in `tools` that the calling inner loop's own allow-list lacks.
   * Main may manage any loop; an inner loop only loops whose tools it holds,
   * so `loop_manage` never widens, redirects or removes a loop that can do
   * more than the one using it. The
   * allow-lists are compared directly: both are intersected with the same
   * host tools at derive time.
   */
  private toolsBeyondCaller(pool: LoopPoolApi, callerLoop: string, tools: string[]): string[] {
    if (callerLoop === MAIN_LOOP) return []
    // Every loop holds the default-on pair whether or not it lists them.
    const held = new Set([...(pool.getLoop(callerLoop)?.tools ?? []), ...LOOP_DEFAULT_ON_TOOLS])
    return [...new Set(tools)].filter(name => !held.has(name))
  }

  /** `DEFAULT_NEW_LOOP_TOOLS`, minus anything this host cannot grant. */
  private defaultToolsFor(workspace: AdfWorkspace): string[] {
    const available = new Set(listAvailableLoopTools(workspace.getAgentConfig()))
    return DEFAULT_NEW_LOOP_TOOLS.filter(name => available.has(name))
  }

  private async handleUpdate(
    pool: LoopPoolApi,
    workspace: AdfWorkspace,
    callerLoop: string,
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
      ...(patch.autostart !== undefined && { autostart: patch.autostart }),
      ...(patch.autonomous !== undefined && { autonomous: patch.autonomous }),
      ...(patch.model !== undefined && { model: patch.model }),
      ...(patch.compact_threshold !== undefined && { compact_threshold: patch.compact_threshold }),
      ...(patch.tools !== undefined && { tools: patch.tools }),
      name
    }

    const validated = this.validate(merged, workspace)
    if ('error' in validated) return errorResult(validated.error)
    // Both sides: what the loop would get, and what it already holds (a loop
    // must not redirect a sibling that holds more than it does).
    const beyond = this.toolsBeyondCaller(pool, callerLoop, [...(existing.tools ?? []), ...(validated.config.tools ?? [])])
    if (beyond.length > 0) {
      return errorResult(
        `"${callerLoop}" can only change a loop whose tools it holds itself; it does not hold ${beyond.join(', ')}. ` +
        `Ask main to update "${name}" with loop_send.`
      )
    }

    // Send the pool a patch, not the merge: it re-reads the live config itself,
    // so a concurrent edit is not silently overwritten by our stale snapshot.
    const outgoing: Partial<LoopConfig> = {
      ...(patch.goal !== undefined && { goal: validated.config.goal }),
      ...(patch.enabled !== undefined && { enabled: validated.config.enabled }),
      ...(patch.autostart !== undefined && { autostart: validated.config.autostart }),
      ...(patch.autonomous !== undefined && { autonomous: validated.config.autonomous }),
      ...(patch.model !== undefined && { model: validated.config.model }),
      ...(patch.compact_threshold !== undefined && { compact_threshold: validated.config.compact_threshold }),
      ...(patch.tools !== undefined && { tools: validated.config.tools })
    }

    if (Object.keys(outgoing).length === 0) {
      return errorResult(
        'Nothing to update — "config" named no changeable field (goal, enabled, autostart, autonomous, model, compact_threshold, tools).'
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
    callerLoop: string,
    name: string | undefined
  ): Promise<ToolResult> {
    if (!name) return errorResult('delete requires "name".')

    if (name === MAIN_LOOP) {
      return errorResult('main is your own loop and cannot be deleted.')
    }

    const existing = pool.getLoop(name)
    if (!existing) return this.unknownLoop(pool, name)
    const beyond = this.toolsBeyondCaller(pool, callerLoop, existing.tools ?? [])
    if (beyond.length > 0) {
      return errorResult(
        `"${callerLoop}" can only delete a loop whose tools it holds itself; it does not hold ${beyond.join(', ')}. ` +
        `Ask main to delete "${name}" with loop_send.`
      )
    }

    const result = await pool.deleteLoop(name)

    return {
      content:
        `Deleted loop "${name}". ` +
        (result.interruptedTurn ? 'It was mid-turn; that turn was stopped and its writes kept. ' : '') +
        `Its stream (${result.archivedEntries} ${result.archivedEntries === 1 ? 'entry' : 'entries'}) was archived to the audit log under "loop:${name}".`,
      isError: false
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Schema validation (name/goal/enabled) followed by the host-relative tool
   * check that the schema cannot do — it needs this agent's tool declarations.
   *
   * Only UNKNOWN names fail: a typo or an invention, and failing is how the
   * model learns the real list. A name the owner has merely DISABLED is not an
   * error — the loop is created carrying it, ungranted for now, and `disabled`
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
    const { unknown, disabled } = validateLoopToolList(host, requested)

    if (unknown.length > 0) {
      return {
        error:
          `Cannot grant those tools — no such tool on this agent: ${unknown.join(', ')}. ` +
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
