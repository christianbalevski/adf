/**
 * Protection-gated registry wrapper for the shell pipeline.
 *
 * Wraps the shell's ToolRegistry so ANY tool execution inside a pipeline —
 * command handlers, output redirects (`>` → fs_write), scripts, xargs, $()
 * substitutions — that is denied by a data protection (file/meta/config lock)
 * pauses for a HIL override approval instead of failing. On approve the exact
 * (possibly human-modified) call re-executes with a one-time bypass.
 *
 * Same Proxy idiom as authorizedRegistry (commands/code.ts): shell handlers
 * build tool inputs from parsed flags, so the agent cannot forge
 * `_protection_override` via a command flag. Authorized scripts never hit this
 * path — their calls carry `_authorized`, so no protection denial arises.
 */

import type { ToolRegistry } from '../../tool-registry'
import type { AdfWorkspace } from '../../../adf/adf-workspace'
import type { ToolResult } from '@shared/types/tool.types'
import type { ShellGate } from '../commands/types'

export function protectionGatedRegistry(registry: ToolRegistry, gate: ShellGate): ToolRegistry {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === 'executeTool') {
        return async (name: string, input: unknown, ws: AdfWorkspace): Promise<ToolResult> => {
          const result = await target.executeTool(name, input, ws)
          if (!result.isError || !result.protection) return result
          if (gate.authorized || !gate.onProtectionBlocked) return result

          const decision = await gate.onProtectionBlocked(
            name,
            (input ?? {}) as Record<string, unknown>,
            result.protection,
            gate.command ?? name
          )
          if (!decision.approved) {
            const fb = decision.feedback?.trim()
            return {
              content: `${result.content} Override rejected by the user.${fb ? ` Feedback: ${fb}` : ''} Do not retry.`,
              isError: true
            }
          }
          return target.executeTool(
            name,
            { ...((decision.modifiedArgs ?? input) as Record<string, unknown>), _protection_override: true },
            ws
          )
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
