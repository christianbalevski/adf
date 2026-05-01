import type { ToolRegistry } from '../../tool-registry'
import type { AdfWorkspace } from '../../../adf/adf-workspace'

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
