import type { ToolRegistry } from '../../tool-registry'
import type { AdfWorkspace } from '../../../adf/adf-workspace'
import { isTextMime, isVisionMime, isAudioInputMime, isVideoInputMime } from '../../built-in/mime-utils'

export { isTextMime }

export interface ShellFileRow {
  content: string
  mime_type?: string
  size?: number
  path?: string
}

/** Media mimes a multimodal model can actually consume — routed as media
 *  markers instead of base64 into stdout. Aligned with the executor's
 *  injection sets (isVisionMime/isAudioInputMime/isVideoInputMime) so a `cat`
 *  marker never promises an attachment the model won't receive (e.g. svg,
 *  which is image/* but not a vision mime). */
export function isMediaMime(mime: string | undefined): boolean {
  return isVisionMime(mime) || isAudioInputMime(mime) || isVideoInputMime(mime)
}

/** True when the fs_read row's content is decodable text (not base64 binary). */
export function isTextRow(row: ShellFileRow): boolean {
  return isTextMime(row.mime_type)
}

/**
 * Shell helper: calls fs_read, parses the JSON row, returns the full row
 * (content + mime_type/size/path metadata).
 * Returns [row, null] on success, [null, errorMessage] on error.
 */
export async function shellReadFileRow(
  toolRegistry: ToolRegistry,
  workspace: AdfWorkspace,
  path: string,
  options?: { start_line?: number; end_line?: number }
): Promise<[ShellFileRow, null] | [null, string]> {
  const input: Record<string, unknown> = { path }
  if (options?.start_line !== undefined) input.start_line = options.start_line
  if (options?.end_line !== undefined) input.end_line = options.end_line

  const result = await toolRegistry.executeTool('fs_read', input, workspace)
  if (result.isError) {
    return [null, result.content]
  }

  try {
    const row = JSON.parse(result.content)
    return [{
      content: row.content ?? '',
      mime_type: row.mime_type,
      size: row.size,
      path: row.path ?? path,
    }, null]
  } catch {
    return [null, `Failed to parse fs_read result`]
  }
}

/**
 * Shell helper: calls fs_read, parses JSON row, returns raw text content.
 * Returns [content, null] on success, [null, errorMessage] on error.
 */
export async function shellReadFile(
  toolRegistry: ToolRegistry,
  workspace: AdfWorkspace,
  path: string,
  options?: { start_line?: number; end_line?: number }
): Promise<[string, null] | [null, string]> {
  const input: Record<string, unknown> = { path }
  if (options?.start_line !== undefined) input.start_line = options.start_line
  if (options?.end_line !== undefined) input.end_line = options.end_line

  const result = await toolRegistry.executeTool('fs_read', input, workspace)
  if (result.isError) {
    return [null, result.content]
  }

  try {
    const row = JSON.parse(result.content)
    return [row.content ?? '', null]
  } catch {
    return [null, `Failed to parse fs_read result`]
  }
}
