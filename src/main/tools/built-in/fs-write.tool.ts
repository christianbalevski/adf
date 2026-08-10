import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { currentSourceOrUnknown } from '../../runtime/execution-context'
import { withFileLock } from '../file-lock'

const EditSchema = z.object({
  old_text: z.string().min(1).describe('Exact text to find.'),
  new_text: z.string().describe('Replacement text. Use "" to delete.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence (default: require a single unique match).'),
})

const InputSchema = z.object({
  mode: z.enum(['write', 'edit', 'append']).describe('Operation: "write" create/overwrite, "edit" find-and-replace, "append" add to end.'),
  path: z.string().describe('File path: "README.md", "mind.md", or any relative path.'),
  content: z.string().optional()
    .describe('write/append mode: content to write or append.'),
  old_text: z.string().min(1).optional()
    .describe('edit mode (single): exact text to find. Must appear once unless replace_all is set.'),
  new_text: z.string().optional()
    .describe('edit mode (single): replacement text. Use "" to delete matched text.'),
  replace_all: z.boolean().optional()
    .describe('edit mode (single): replace every occurrence of old_text instead of requiring a unique match.'),
  edits: z.array(EditSchema).optional()
    .describe('edit mode (batch): a list of {old_text,new_text,replace_all} applied in order and atomically — if any fails, the file is not modified.'),
  protection: z.enum(['read_only', 'no_delete', 'none']).optional()
    .describe('write mode: protection level for new files.'),
  encoding: z.enum(['utf8', 'base64']).optional()
    .describe('write mode: content encoding. Use "base64" for binary files.'),
  mime_type: z.string().optional()
    .describe('write mode: MIME type (e.g. "image/png"). Used with encoding: "base64".')
})

type EditOp = z.infer<typeof EditSchema>

/**
 * Unified file write/edit tool.
 * - Write mode: create or overwrite a file (binary via encoding:"base64").
 * - Edit mode: find-and-replace, single (old_text/new_text[/replace_all]) or
 *   batch (edits[]) applied atomically.
 * - Append mode: add content to the end.
 * All operations on a file are serialized per (workspace, path) so concurrent
 * edits/appends can't clobber each other.
 */
export class FsWriteTool implements Tool {
  readonly name = 'fs_write'
  readonly description =
    'Write, edit, or append to any file. mode="write" + "content" to create/overwrite; ' +
    'mode="edit" with "old_text"+"new_text" (add replace_all for all occurrences) or "edits":[...] ' +
    'for an atomic batch of replacements; mode="append" + "content" to add to the end.'
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const inputObj = input as Record<string, unknown>
    if (inputObj._error) {
      return { content: `PROVIDER ERROR: ${inputObj._error}`, isError: true }
    }

    const parsed = input as z.infer<typeof InputSchema>
    const { mode, path } = parsed
    const isAuthorized = inputObj?._authorized === true
    const isOverride = inputObj?._protection_override === true

    // File protection check. Only read_only blocks writes (no_delete permits
    // edits). Authorized code bypasses — same privilege as UI.
    const protection = workspace.getFileProtection(path)
    if (!isAuthorized && !isOverride && protection === 'read_only') {
      return {
        content: `Cannot write to "${path}": file is read-only.`,
        isError: true,
        protection: {
          kind: 'file_protection', target: path, level: 'read_only',
          description: `Overwrite "${path}" — file is read-only`
        }
      }
    }
    const bypassedProtection = protection === 'read_only' && (isAuthorized || isOverride)

    // Serialize all operations on this file (per workspace) to prevent
    // read-modify-write clobbering under concurrency.
    const result = await withFileLock(workspace, path, () => {
      try {
        if (mode === 'write') {
          if (parsed.content === undefined) return { content: 'write mode requires "content".', isError: true }
          return this.writeMode(path, parsed.content, workspace, parsed.protection, parsed.encoding, parsed.mime_type)
        }
        if (mode === 'append') {
          if (parsed.content === undefined) return { content: 'append mode requires "content".', isError: true }
          return this.appendMode(path, parsed.content, workspace)
        }
        // edit
        const editList: EditOp[] = parsed.edits && parsed.edits.length > 0
          ? parsed.edits
          : parsed.old_text
            ? [{ old_text: parsed.old_text, new_text: parsed.new_text ?? '', replace_all: parsed.replace_all }]
            : []
        if (editList.length === 0) return { content: 'edit mode requires "old_text" (or a non-empty "edits" array).', isError: true }
        return this.editMode(path, editList, workspace)
      } catch (error) {
        return { content: `Failed to write "${path}": ${String(error)}`, isError: true }
      }
    })

    // No Secrets: an authorized/HIL bypass of a read-only file must never be
    // silent — audit + mark. Only fires when the write actually succeeded and
    // the file really was protected (an unprotected write leaves no trace).
    if (bypassedProtection && !result.isError) {
      const reason = isOverride
        ? 'human-approved override'
        : `authorized code bypass (${currentSourceOrUnknown()})`
      workspace.insertLog?.('warn', 'protection', 'bypass', path,
        `Wrote protected read-only file "${path}" — ${reason}`)
      return {
        ...result,
        content: `${result.content} (⚠ protection override: read_only, ${isOverride ? 'human-approved' : 'authorized'}).`
      }
    }
    return result
  }

  /** Read the current content of a path (handles the README/mind aliases). */
  private read(path: string, workspace: AdfWorkspace): string | null {
    if (path === 'README.md' || path === 'document.md') return workspace.readDocument()
    if (path === 'mind.md') return workspace.readMind()
    return workspace.readFile(path)
  }

  /** Write content to a path (handles the README/mind aliases). */
  private commit(path: string, content: string, workspace: AdfWorkspace): void {
    if (path === 'README.md' || path === 'document.md') workspace.writeDocument(content)
    else if (path === 'mind.md') workspace.writeMind(content)
    else workspace.writeFile(path, content)
  }

  /** Reject content exceeding the configured write limit (README/mind exempt). */
  private overSizeLimit(path: string, content: string, workspace: AdfWorkspace): ToolResult | null {
    if (path === 'README.md' || path === 'document.md' || path === 'mind.md') return null
    const max = workspace.getAgentConfig().limits?.max_file_write_bytes ?? 5000000
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > max) {
      const fmt = (b: number) => b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`
      return { content: `Write rejected: result is ${fmt(bytes)} but max_file_write_bytes is ${fmt(max)}.`, isError: true }
    }
    return null
  }

  private writeMode(
    path: string,
    content: string,
    workspace: AdfWorkspace,
    requestedProtection?: 'read_only' | 'no_delete' | 'none',
    encoding?: 'utf8' | 'base64',
    mime_type?: string
  ): ToolResult {
    if (encoding === 'base64') {
      const buffer = Buffer.from(content, 'base64')
      workspace.writeFileBuffer(path, buffer, mime_type)
      return { content: `Successfully wrote "${path}" (${buffer.length} bytes, binary)`, isError: false }
    }

    const tooBig = this.overSizeLimit(path, content, workspace)
    if (tooBig) return tooBig

    if (path === 'README.md' || path === 'document.md') workspace.writeDocument(content)
    else if (path === 'mind.md') workspace.writeMind(content)
    else workspace.writeFile(path, content, requestedProtection)
    return { content: `Successfully wrote "${path}" (${content.length} characters)`, isError: false }
  }

  private appendMode(path: string, content: string, workspace: AdfWorkspace): ToolResult {
    const existing = this.read(path, workspace) ?? ''
    const updated = existing + content
    const tooBig = this.overSizeLimit(path, updated, workspace)
    if (tooBig) return tooBig
    this.commit(path, updated, workspace)
    return { content: `Appended ${content.length} characters to "${path}"`, isError: false }
  }

  private editMode(path: string, edits: EditOp[], workspace: AdfWorkspace): ToolResult {
    const original = this.read(path, workspace)
    if (original === null) {
      return { content: `File not found: "${path}". Use mode="write" with "content" to create it.`, isError: true }
    }

    // Apply all edits in memory; abort (write nothing) if any fails — atomic.
    let doc = original
    let totalReplacements = 0
    for (let i = 0; i < edits.length; i++) {
      const { old_text, new_text, replace_all } = edits[i]
      const label = edits.length > 1 ? `edits[${i}]: ` : ''
      if (old_text === new_text) {
        return { content: `${label}old_text and new_text are identical — no change. Batch aborted, file unchanged.`, isError: true }
      }
      const first = doc.indexOf(old_text)
      if (first === -1) {
        return { content: `${label}old_text not found in ${path}. ${edits.length > 1 ? 'Batch aborted, file unchanged. ' : ''}Use fs_read to verify current content.`, isError: true }
      }
      if (replace_all) {
        const count = doc.split(old_text).length - 1
        doc = doc.split(old_text).join(new_text)
        totalReplacements += count
      } else {
        if (doc.indexOf(old_text, first + 1) !== -1) {
          return { content: `${label}old_text appears multiple times in ${path}. Add surrounding context to make it unique, or set replace_all. ${edits.length > 1 ? 'Batch aborted, file unchanged.' : ''}`, isError: true }
        }
        doc = doc.slice(0, first) + new_text + doc.slice(first + old_text.length)
        totalReplacements += 1
      }
    }

    const tooBig = this.overSizeLimit(path, doc, workspace)
    if (tooBig) return tooBig

    this.commit(path, doc, workspace)
    const summary = edits.length > 1
      ? `Edited ${path}: applied ${edits.length} edits, ${totalReplacements} replacement(s).`
      : `Edited ${path} (${totalReplacements} replacement(s)).`
    return { content: summary, isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
