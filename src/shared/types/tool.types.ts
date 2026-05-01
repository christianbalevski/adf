export interface ToolResult {
  content: string
  isError: boolean
  /** When true, the agent's current turn ends immediately after this tool result is submitted. */
  endTurn?: boolean
}

export interface ToolProviderFormat {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
