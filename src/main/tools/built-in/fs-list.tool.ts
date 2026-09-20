import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  prefix: z
    .string()
    .optional()
    .describe('Optional path prefix to filter files (e.g. "data/" to list only files in data/).')
})

/** Max entries returned to the model before truncation (mirrors db_query). */
const MAX_FILES = 500

export class FsListTool implements Tool {
  readonly name = 'fs_list'
  readonly description = 'List all files in the ADF. Optionally filter by path prefix.'
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { prefix } = (input as z.infer<typeof InputSchema>) || {}

    let files = workspace.listFiles()
    if (prefix) {
      files = files.filter((f) => f.path.startsWith(prefix))
    }

    const records = files.map((f) => ({
      path: f.path,
      size: f.size,
      mime_type: f.mime_type,
      protection: f.protection,
      created_at: f.created_at,
      updated_at: f.updated_at
    }))

    // Same cap + escape hatch as db_query: an ADF with thousands of files used
    // to dump every row into the model's context. Truncation is always visible
    // — never a silent drop — and code execution can pass _full: true.
    const _full = (input as Record<string, unknown>)?._full === true
    if (!_full && records.length > MAX_FILES) {
      return {
        content: [
          JSON.stringify(records.slice(0, MAX_FILES)),
          ``,
          `--- TRUNCATED at ${MAX_FILES} files (${records.length} match${prefix ? ` prefix "${prefix}"` : ''}) ---`,
          `Narrow the listing with a prefix, or use _full: true from code execution to get all files.`
        ].join('\n'),
        isError: false
      }
    }

    return { content: JSON.stringify(records), isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
