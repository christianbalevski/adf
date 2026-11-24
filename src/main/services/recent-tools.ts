import type { AdfWorkspace } from '../adf/adf-workspace'

/**
 * Read recent tool calls from an agent's workspace loop table.
 * Extracts tool_use/tool_result pairs from the last ~30 loop entries.
 * Used by MESH_GET_RECENT_TOOLS in Studio and GET /fleet/recent-tools in the daemon.
 */
export function readRecentToolsFromWorkspace(
  workspace: Pick<AdfWorkspace, 'getLoopTail'>,
  limit: number,
  onError?: (error: unknown) => void
): { name: string; args?: string; isError?: boolean; timestamp: number }[] {
  try {
    const entries = workspace.getLoopTail(30)

    const toolUseMap = new Map<string, { name: string; args?: string; timestamp: number }>()
    const tools: { name: string; args?: string; isError?: boolean; timestamp: number }[] = []

    for (const entry of entries) {
      for (const block of entry.content_json) {
        if (block.type === 'tool_use' && block.name && block.id) {
          let args: string | undefined
          if (block.input) {
            try {
              const input = block.input as Record<string, unknown>
              if (typeof input._reason === 'string' && input._reason) {
                args = input._reason
              } else {
                const str = typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
                args = str.length > 40 ? str.slice(0, 40) + '...' : str
              }
            } catch { /* ignore */ }
          }
          toolUseMap.set(block.id, { name: block.name, args, timestamp: entry.created_at })
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          const matched = toolUseMap.get(block.tool_use_id)
          if (matched) {
            tools.push({ ...matched, isError: !!block.is_error })
            toolUseMap.delete(block.tool_use_id)
          }
        }
      }
    }

    // Unmatched tool_use (still in progress)
    for (const pending of toolUseMap.values()) {
      tools.push(pending)
    }

    return tools.slice(-limit)
  } catch (error) {
    onError?.(error)
    return []
  }
}
