import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { emitUmbilicalEvent } from '../../runtime/emit-umbilical'

const InputSchema = z.object({
  mode: z.enum(['write', 'edit']).describe('Operation mode: "write" to create/overwrite, "edit" to find-and-replace.'),
  path: z.string().describe('File path: "document.md", "mind.md", or any relative path.'),
  content: z.string().optional()
    .describe('write mode: full content to write. Creates or overwrites the file.'),
  old_text: z.string().min(1).optional()
    .describe('edit mode: exact text to find. Must appear exactly once in the file.'),
  new_text: z.string().optional()
    .describe('edit mode: replacement text. Use "" to delete matched text.'),
  protection: z.enum(['read_only', 'no_delete', 'none']).optional()
    .describe('write mode: protection level for new files.'),
  encoding: z.enum(['utf8', 'base64']).optional()
    .describe('write mode: content encoding. Use "base64" for binary files.'),
  mime_type: z.string().optional()
    .describe('write mode: MIME type (e.g. "image/png"). Used with encoding: "base64".')
})

/**
 * Unified file write/edit tool.
 * - Write mode (content): create or overwrite a file
 * - Edit mode (old_text + new_text): find-and-replace within a file
 * - Binary support via encoding: "base64" + optional mime_type
 */
export class FsWriteTool implements Tool {
  readonly name = 'fs_write'
  readonly description =
    'Write or edit any file. Set mode="write" with "content" to create/overwrite, ' +
    'or mode="edit" with "old_text"+"new_text" to find-and-replace.'
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const inputObj = input as Record<string, unknown>
    if (inputObj._error) {
      return { content: `PROVIDER ERROR: ${inputObj._error}`, isError: true }
    }

    const parsed = input as z.infer<typeof InputSchema>
    const { mode, path, content, old_text, new_text, protection: requestedProtection, encoding, mime_type } = parsed
    const isAuthorized = (input as Record<string, unknown>)?._authorized === true

    // Check file protection level. Authorized code bypasses — same privilege as UI.
    if (!isAuthorized) {
      const protection = workspace.getFileProtection(path)
      if (protection === 'read_only') {
        return {
          content: `Cannot write to "${path}": file is read-only.`,
          isError: true
        }
      }
    }

    try {
      if (mode === 'write') {
        if (content === undefined) {
          return { content: 'write mode requires "content".', isError: true }
        }
        return this.writeMode(path, content, workspace, requestedProtection, encoding, mime_type)
      } else {
        if (!old_text) {
          return { content: 'edit mode requires "old_text".', isError: true }
        }
        return this.editMode(path, old_text, new_text ?? '', workspace)
      }
    } catch (error) {
      return {
        content: `Failed to write "${path}": ${String(error)}`,
        isError: true
      }
    }
  }

  private writeMode(
    path: string,
    content: string,
    workspace: AdfWorkspace,
    requestedProtection?: 'read_only' | 'no_delete' | 'none',
    encoding?: 'utf8' | 'base64',
    mime_type?: string
  ): ToolResult {
    const isDocument = path === 'document.md' || path.startsWith('document.')
    const isMind = path === 'mind.md'

    // Binary write via base64
    if (encoding === 'base64') {
      const buffer = Buffer.from(content, 'base64')
      workspace.writeFileBuffer(path, buffer, mime_type)
      emitUmbilicalEvent({ event_type: 'file.written', payload: { path, bytes: buffer.length } })
      return {
        content: `Successfully wrote "${path}" (${buffer.length} bytes, binary)`,
        isError: false
      }
    }

    // Enforce write size limit (skip for document.md and mind.md)
    if (!isDocument && !isMind) {
      const maxWriteBytes = workspace.getAgentConfig().limits?.max_file_write_bytes ?? 5000000
      const contentBytes = Buffer.byteLength(content, 'utf8')
      if (contentBytes > maxWriteBytes) {
        const fmt = (b: number) => b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`
        return {
          content: `Write rejected: content is ${fmt(contentBytes)} but max_file_write_bytes is ${fmt(maxWriteBytes)}. Reduce content size or increase the limit in agent config.`,
          isError: true
        }
      }
    }

    if (isDocument) {
      workspace.writeDocument(content)
    } else if (isMind) {
      workspace.writeMind(content)
    } else {
      workspace.writeFile(path, content, requestedProtection)
    }

    emitUmbilicalEvent({
      event_type: 'file.written',
      payload: { path, bytes: Buffer.byteLength(content, 'utf-8') }
    })
    return {
      content: `Successfully wrote "${path}" (${content.length} characters)`,
      isError: false
    }
  }

  private editMode(
    path: string,
    old_text: string,
    new_text: string,
    workspace: AdfWorkspace
  ): ToolResult {
    if (old_text === new_text) {
      return { content: 'old_text and new_text are identical — no change needed.', isError: true }
    }

    const isDocument = path === 'document.md' || path.startsWith('document.')
    const isMind = path === 'mind.md'

    // Read current content
    let doc: string
    if (isDocument) {
      doc = workspace.readDocument()
    } else if (isMind) {
      doc = workspace.readMind()
    } else {
      const fileContent = workspace.readFile(path)
      if (fileContent === null) {
        return {
          content: `File not found: "${path}". Use the "content" parameter to create new files.`,
          isError: true
        }
      }
      doc = fileContent
    }

    // Find old_text — must appear exactly once
    const firstIndex = doc.indexOf(old_text)
    if (firstIndex === -1) {
      return {
        content: `old_text not found in ${path}. Use fs_read to verify current content.`,
        isError: true
      }
    }

    if (doc.indexOf(old_text, firstIndex + 1) !== -1) {
      return {
        content: `old_text appears multiple times in ${path}. Include more context to make it unique.`,
        isError: true
      }
    }

    const updated = doc.slice(0, firstIndex) + new_text + doc.slice(firstIndex + old_text.length)

    if (isDocument) workspace.writeDocument(updated)
    else if (isMind) workspace.writeMind(updated)
    else workspace.writeFile(path, updated)

    emitUmbilicalEvent({
      event_type: 'file.written',
      payload: { path, bytes: Buffer.byteLength(updated, 'utf-8') }
    })
    return {
      content: `Edited ${path} (replaced ${old_text.length} chars with ${new_text.length} chars)`,
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
