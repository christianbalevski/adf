import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { LoopConfig } from '../../../shared/types/adf-v02.types'
import { LoopConfigSchema } from '../../adf/adf-schema'
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
  name: z.string().min(1).optional().describe(
    'Loop name. Unique within this agent; "main" is reserved. Also settable via the top-level name field.'
  ),
  goal: z.string().min(1).optional().describe(
    "The loop's charter — becomes its system instructions. This is the whole of what it knows it is for."
  ),
  enabled: z.boolean().optional().describe('Whether the loop runs. Default true on create.'),
  model: z.record(z.unknown()).optional().describe(
    'Model override for this loop only (same shape as the agent model config: provider, model_id, temperature, ...). Omit to inherit the agent model.'
  ),
  tools: z.array(z.string().min(1)).optional().describe(
    'Absolute allow-list of tool names for this loop, intersected with your own enabled tools. ' +
    'loop_send/loop_list are always granted. Omit or [] for a purely reflective loop. ' +
    'Naming an unavailable tool fails with the list of what is available.'
  )
}).describe('Loop definition. Full definition for create; partial patch for update.')

const InputSchema = z.object({
  action: z.enum(['create', 'list', 'get', 'update', 'delete']).describe(
    'create — define a new side loop and start it. list — all loops incl. main. get — one loop definition. ' +
    'update — patch a side loop (re-derives and restarts it). delete — archive its stream to the audit log, then remove it.'
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
 * **Restricted.** It ships `enabled: false, restricted: true` in
 * `DEFAULT_TOOLS`; HIL gating is driven by that declaration, which the
 * executor reads (`agent-executor.ts:1776`). `requireApproval` below mirrors
 * the other two restricted built-ins (`compute_exec`, `sys_create_adf`) and is
 * declarative only.
 *
 * Validation happens twice on purpose: here, so the model gets an actionable
 * message naming the available tools, and again inside the pool, which is the
 * one path every non-tool caller also crosses.
 */
export class LoopManageTool implements Tool {
  readonly name = 'loop_manage'
  readonly description =
    'Create, inspect, update and delete this agent\'s side cognition loops — named minds inside you (a reflector, a consolidator, a critic) ' +
    'that share your file, identity and credentials but run their own stream with their own goal and a subset of your tools. ' +
    'Deleting a loop archives its stream to the audit log first. Only the main loop can call this, and loops cannot create loops.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const
  readonly requireApproval = true

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
        case 'list':
          return this.handleList(pool)
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

  private handleList(pool: LoopPoolApi): ToolResult {
    return { content: JSON.stringify({ loops: pool.listLoops() }, null, 2), isError: false }
  }

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

    const candidate = {
      name,
      goal: configArg.goal,
      enabled: configArg.enabled ?? true,
      ...(configArg.model !== undefined && { model: configArg.model }),
      ...(configArg.tools !== undefined && { tools: configArg.tools })
    }

    const validated = this.validate(candidate, workspace)
    if ('error' in validated) return errorResult(validated.error)

    await pool.createLoop(validated.config)

    const granted = validated.config.tools ?? []
    return {
      content:
        `Created loop "${name}"${validated.config.enabled ? ' (running)' : ' (disabled)'}.\n` +
        `Goal: ${validated.config.goal}\n` +
        `Tools: ${granted.length ? granted.join(', ') : '(none)'} + loop_send, loop_list.\n` +
        'Give it work by targeting it from a trigger or timer, or with loop_send.',
      isError: false
    }
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
      ...(patch.tools !== undefined && { tools: validated.config.tools })
    }

    if (Object.keys(outgoing).length === 0) {
      return errorResult('Nothing to update — "config" named no changeable field (goal, enabled, model, tools).')
    }

    await pool.updateLoop(name, outgoing)

    return {
      content: `Updated loop "${name}": ${Object.keys(outgoing).join(', ')}. It has been re-derived and restarted.`,
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
   */
  private validate(
    candidate: Record<string, unknown>,
    workspace: AdfWorkspace
  ): { config: LoopConfig } | { error: string } {
    const parsed = LoopConfigSchema.safeParse(candidate)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return { error: `Invalid loop config — ${issues}` }
    }

    const config = parsed.data as unknown as LoopConfig

    const requested = config.tools ?? []
    if (requested.length > 0) {
      const host = workspace.getAgentConfig()
      const { unknown, prohibited } = validateLoopToolList(host, requested)

      if (unknown.length > 0 || prohibited.length > 0) {
        const parts: string[] = []
        if (unknown.length > 0) {
          parts.push(`not available on this agent: ${unknown.join(', ')}`)
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
    }

    return { config }
  }

  private unknownLoop(
    pool: LoopPoolApi,
    name: string
  ): ToolResult {
    const side = pool.listLoops().filter(l => !l.isMain).map(l => l.name)
    return errorResult(
      `No side loop named "${name}". ${side.length ? `Side loops: ${side.join(', ')}.` : 'This agent has no side loops yet.'}`
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
