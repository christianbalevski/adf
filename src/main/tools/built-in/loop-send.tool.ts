import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import {
  LOOP_POOL_UNAVAILABLE,
  resolveLoopPool,
  type LoopPoolAccessor
} from '../../adf/loop-pool.types'

/**
 * Cap on a single inter-loop message.
 *
 * A `loop_send` writes straight into another loop's context, so it needs the
 * same bound `loop_inject` has (adf-call-handler.ts: `max_tool_result_tokens *
 * 3` characters). The tool schema is static and has no config in hand at
 * construction time, so this pins the default of that formula
 * (16_000 * 3 = 48_000) rather than forking a second, looser rule.
 */
export const LOOP_SEND_MAX_CHARS = 48_000

const InputSchema = z.object({
  to_loop: z.string().min(1).describe(
    'Name of the loop to deliver to, from loop_list. "main" is the membrane-facing loop.'
  ),
  content: z.string().min(1).max(LOOP_SEND_MAX_CHARS).describe(
    'The message. Appended to the target loop\'s stream as a real entry, stamped with your loop name.'
  ),
  wake: z.boolean().optional().describe(
    'Wake the target now. An idle target runs a turn immediately; a busy one reads the message at its next model boundary ' +
    'mid-turn and gets one extra turn only if its current turn ends first. Default false — it simply reads the message whenever it next runs.'
  )
})

/**
 * Peer-to-peer message between the loops of ONE agent.
 *
 * An ordinary declared tool: it ships enabled+visible in `DEFAULT_TOOLS`, the
 * owner can turn it off, and a side loop gets it only when its own allow-list
 * names it (superseding the "essential" of docs/design/agent-loops-mvp.md
 * §7.1). It carries no worldly authority — it acts only on interior streams —
 * but the no-secrets principle says visible-and-toggleable beats hardwired.
 *
 * The runtime registers it into main whenever it is enabled (like every other
 * capability tool); on a loop-less agent it is present but errors on any target
 * it names, since `main` cannot send to itself and no other loop exists.
 *
 * Main is not a bus — any loop may address any other, and whether a wake
 * actually runs is the *receiver's* business (the pool decides). The
 * `[from loop:<sender>]` stamp is provenance for audit and for the reader's
 * judgement; it is spoofable inside `content` and is explicitly NOT a
 * prompt-injection defense (§2.4). The mitigation is that a loop's suggestion
 * still has to pass main's HIL before it becomes an action.
 *
 * The append + wake delivery (RT-F6) belongs to the pool — see
 * `LoopPoolApi.sendToLoop`. Three delivery shapes:
 *
 *   - idle target + `wake` — the session rehydrates the durable row and runs a
 *     turn immediately;
 *   - busy target (main or an inner loop) + `wake` — the message is injected so
 *     the target reads it at its NEXT MODEL BOUNDARY, mid-turn. If the turn
 *     ends before that boundary the pool runs one extra content-free "kick"
 *     turn to drain it. Exactly-once: the kick never inlines the content (the
 *     runtime recognizes a pending injection by seq and suppresses the trigger
 *     message), so the model sees it once and the UI renders one card. The kick
 *     is owed per TARGET, not per message — several sends inside one turn drain
 *     on one turn — and mid-turn compaction preserves undelivered deliveries;
 *   - no `wake` — the row simply waits in the target's stream and is read
 *     whenever it next runs. Never costs an extra turn (same for `loop_inject`
 *     from code).
 *
 * Operator note: `wake: true` into a busy target can cost one extra model turn.
 * That is the intended semantics, not a free ride.
 */
export class LoopSendTool implements Tool {
  readonly name = 'loop_send'
  readonly description =
    'Send a message to another cognition loop of this same agent. Use loop_list to see the loops and their goals. ' +
    'The message is appended to that loop\'s stream stamped with your loop name; without wake it is read the next time that loop runs. ' +
    'With wake, an idle target runs a turn immediately and a busy one reads it at its next step, mid-turn. ' +
    'This is interior signalling only — it never leaves the agent ' +
    '(use msg_send to reach another agent or a person).'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  private getPool: LoopPoolAccessor

  constructor(getPool: LoopPoolAccessor) {
    this.getPool = getPool
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { to_loop, content, wake } = input as z.infer<typeof InputSchema>

    const pool = resolveLoopPool(this.getPool)
    if (!pool) return { content: LOOP_POOL_UNAVAILABLE, isError: true }

    const from = workspace.getLoopName()

    if (to_loop === from) {
      return {
        content: `Cannot loop_send to "${to_loop}" — that is your own loop. You are already writing to it by thinking.`,
        isError: true
      }
    }

    // One listLoops() read serves both the unknown-target error and the
    // enabled check below — a disabled loop is a real target (the row lands)
    // but it never runs, so "it will read this on its next run" would be a lie.
    const loops = pool.listLoops()

    if (!pool.hasLoop(to_loop)) {
      return {
        content: `No loop named "${to_loop}". Loops on this agent: ${loops.map(l => l.name).join(', ') || '(none)'}.`,
        isError: true
      }
    }

    const targetDisabled = loops.find(l => l.name === to_loop)?.enabled === false

    try {
      const result = await pool.sendToLoop(from, to_loop, content, wake === true)

      if (!result.delivered) {
        return {
          content: `Message to "${to_loop}" was not delivered${result.reason ? `: ${result.reason}` : '.'}`,
          isError: true
        }
      }

      const parts = [`Delivered to loop "${to_loop}" (stamped [from loop:${from}]).`]
      if (result.woke) parts.push('It is running a turn now.')
      else if (targetDisabled) {
        parts.push(
          `That loop is DISABLED, so it will not run and will not read this — the message sits in its stream ` +
          `and is only seen if the loop is re-enabled. Ask main to enable "${to_loop}" if it needs to act on this.`
        )
      }
      else if (wake === true) parts.push(`Not woken${result.reason ? ` — ${result.reason}` : ''}; it will read this on its next run.`)
      else parts.push('It will read this on its next run.')

      return { content: parts.join(' '), isError: false }
    } catch (error) {
      return {
        content: `Failed to send to loop "${to_loop}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true
      }
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
