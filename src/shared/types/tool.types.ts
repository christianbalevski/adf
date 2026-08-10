export type ProtectionKind = 'file_protection' | 'meta_protection' | 'config_lock'

/**
 * Structured detail attached to a denial caused by a data protection
 * (file read_only/no_delete, meta readonly/increment, config locks).
 * Protection-aware callers use it to start a HIL override approval;
 * denials without it are hard boundaries and never prompt.
 */
export interface ProtectionDenial {
  kind: ProtectionKind
  /** File path, meta key, or config dot-path that is protected. */
  target: string
  /** 'read_only' | 'no_delete' | 'readonly' | 'increment' | 'locked' | 'locked_fields' */
  level: string
  /**
   * Compact plain-English description of the requested operation, phrased as
   * the human-facing consequence (e.g. 'Delete notes.md — file is protected
   * (read_only)', 'Enable fs_delete — changing a locked setting'). Rendered as
   * the HIL approval title so a human sees WHAT they are approving, not raw
   * JSON. Every producer fills this from the sentence it already builds for the
   * rejection message.
   */
  description?: string
}

export interface ToolResult {
  content: string
  isError: boolean
  /** When true, the agent's current turn ends immediately after this tool result is submitted. */
  endTurn?: boolean
  /** Present when the error is a human-overridable protection denial. */
  protection?: ProtectionDenial
}

export interface ToolProviderFormat {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
