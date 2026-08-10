import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { currentSourceOrUnknown } from '../../runtime/execution-context'

const InputSchema = z.object({
  path: z.string().describe('Relative path of the file to delete. Cannot delete read-only or no-delete files.')
})

export class FsDeleteTool implements Tool {
  readonly name = 'fs_delete'
  readonly description = 'Delete a file from the ADF. Cannot delete files with read-only or no-delete protection.'
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { path } = input as z.infer<typeof InputSchema>
    const isAuthorized = (input as Record<string, unknown>)?._authorized === true
    const isOverride = (input as Record<string, unknown>)?._protection_override === true

    const protection = workspace.getFileProtection(path)
    const wasProtected = protection === 'read_only' || protection === 'no_delete'

    // Authorized code bypasses protection — same privilege as UI.
    if (!isAuthorized && !isOverride && (protection === 'read_only' || protection === 'no_delete')) {
      // Structured denial (never "File not found") so the shell's
      // protection-gated registry can offer a HIL override.
      return {
        content: `Cannot delete "${path}": file is protected (${protection}).`,
        isError: true,
        protection: {
          kind: 'file_protection', target: path, level: protection,
          description: `Delete "${path}" — file is protected (${protection})`
        }
      }
    }

    // An authorized/HIL-approved delete must force past the DB's safe DELETE
    // (which ignores protected rows) — without force, an approved override
    // still reported "File not found" for the row it couldn't see.
    const deleted = workspace.deleteFile(path, { force: isAuthorized || isOverride })
    if (deleted) {
      // No Secrets: a bypass of a REAL protection must never be silent. Audit it
      // and surface a visible marker in the loop — the authorized (script) path
      // is otherwise ungated, so this is the only trace a human ever sees.
      if (wasProtected && (isAuthorized || isOverride)) {
        const reason = isOverride
          ? 'human-approved override'
          : `authorized code bypass (${currentSourceOrUnknown()})`
        workspace.insertLog?.('warn', 'protection', 'bypass', path,
          `Deleted protected file "${path}" (${protection}) — ${reason}`)
        return {
          content: `Deleted "${path}" (⚠ protection override: ${protection}, ${isOverride ? 'human-approved' : 'authorized'}).`,
          isError: false
        }
      }
      return { content: `Deleted "${path}".`, isError: false }
    }
    return { content: `File not found: "${path}"`, isError: true }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
