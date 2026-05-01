import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { emitUmbilicalEvent } from '../../runtime/emit-umbilical'

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

    // Authorized code bypasses protection — same privilege as UI.
    if (!isAuthorized) {
      const protection = workspace.getFileProtection(path)
      if (protection === 'read_only') {
        return { content: `Cannot delete "${path}": file is read-only.`, isError: true }
      }
      if (protection === 'no_delete') {
        return { content: `Cannot delete "${path}": file is protected (no-delete).`, isError: true }
      }
    }

    const deleted = workspace.deleteFile(path)
    if (deleted) {
      emitUmbilicalEvent({ event_type: 'file.deleted', payload: { path } })
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
