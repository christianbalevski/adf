import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { isTextMime } from './mime-utils'
import { emitUmbilicalEvent } from '../../runtime/emit-umbilical'

const InputSchema = z.object({
  path: z.string().describe('File path to read.'),
  start_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Start line number (1-indexed). Text files only.'),
  end_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('End line number (1-indexed, inclusive). Text files only.')
})

/**
 * Read a file from the VFS. Returns the full file record as JSON:
 * { path, content, mime_type, size, protection, created_at, updated_at }.
 *
 * Text files return text content (use start_line/end_line for large files).
 * Binary files return base64 content in code execution; in chat, the executor
 * strips binary content — use code execution to process binary data.
 *
 * No truncation, no line numbers. The executor handles context-window guards.
 */
export class FsReadTool implements Tool {
  readonly name = 'fs_read'
  readonly description =
    'Read a file from the VFS. Returns the full file record: content, mime_type, size, protection, timestamps. ' +
    'Text files return text content (use start_line/end_line for large files). ' +
    'Binary files return base64 content in code execution; in chat, binary files return metadata only — ' +
    'use code execution to process binary data programmatically.'
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { path, start_line, end_line } = input as z.infer<typeof InputSchema>

    const isDocument = path === 'document.md' || path.startsWith('document.')
    const isMind = path === 'mind.md'

    // --- document.md / mind.md: synthesized row ---
    if (isDocument || isMind) {
      const content = isDocument ? workspace.readDocument() : workspace.readMind()
      if (content === null) {
        return { content: `File not found: "${path}"`, isError: true }
      }

      let finalContent = content
      if (start_line || end_line) {
        const lines = content.split('\n')
        const start = Math.max(1, start_line ?? 1)
        const end = Math.min(end_line ?? lines.length, lines.length)
        finalContent = lines.slice(start - 1, end).join('\n')
      }

      emitUmbilicalEvent({
        event_type: 'file.read',
        payload: { path, bytes: Buffer.byteLength(content, 'utf-8') }
      })
      return {
        content: JSON.stringify({
          path,
          content: finalContent,
          mime_type: 'text/markdown',
          size: Buffer.byteLength(content, 'utf-8'),
          protection: 'no_delete',
          created_at: null,
          updated_at: null
        }),
        isError: false
      }
    }

    // --- All other files ---
    const entry = workspace.getDatabase().readFile(path)
    if (!entry) {
      return { content: `File not found: "${path}"`, isError: true }
    }

    const isText = isTextMime(entry.mime_type)

    let fileContent: string
    if (isText) {
      const text = entry.content.toString('utf-8')
      if (start_line || end_line) {
        const lines = text.split('\n')
        const start = Math.max(1, start_line ?? 1)
        const end = Math.min(end_line ?? lines.length, lines.length)
        fileContent = lines.slice(start - 1, end).join('\n')
      } else {
        fileContent = text
      }
    } else {
      // Binary: base64
      fileContent = entry.content.toString('base64')
    }

    emitUmbilicalEvent({
      event_type: 'file.read',
      payload: { path: entry.path, bytes: entry.size }
    })
    return {
      content: JSON.stringify({
        path: entry.path,
        content: fileContent,
        mime_type: entry.mime_type ?? null,
        size: entry.size,
        protection: entry.protection,
        authorized: entry.authorized,
        created_at: entry.created_at,
        updated_at: entry.updated_at
      }),
      isError: false
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
