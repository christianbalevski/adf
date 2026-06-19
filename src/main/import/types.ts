import type { CreateAgentOptions } from '../../shared/types/adf-v02.types'

/** A file to seed into the new agent's file store (adf_files). */
export interface ImportSeedFile {
  /** Path within the agent's file store, e.g. "imported/SKILL.md". */
  path: string
  content: string
}

/** A conversation-history turn to seed into the loop (adf_loop). */
export interface ImportLoopEntry {
  role: 'user' | 'assistant'
  text: string
}

/**
 * The normalized intermediate representation every source adapter produces.
 * The emitter turns one of these into a `.adf` file. Keeping adapters and the
 * emitter decoupled means a new source (or a new target) never touches the
 * other side.
 */
export interface ImportResult {
  /** Which source format this came from. */
  source: 'openclaw' | 'hermes'
  /** The agent config, ready for AdfWorkspace.create. */
  options: CreateAgentOptions
  /** Long-term memory → mind.md. */
  mind?: string
  /** Knowledge / memory / skill docs → adf_files. */
  files: ImportSeedFile[]
  /** Conversation history → adf_loop (usually empty; most exports drop it). */
  loop: ImportLoopEntry[]
  /** Human-readable notes about anything that did not map cleanly. */
  warnings: string[]
  /**
   * Surfaces that are host bindings, not agent identity, and so are
   * deliberately not carried — the user re-provisions them on the new host
   * (HTTP routes, websocket connections, conversation history).
   */
  notTransferred: string[]
}

/** Options accepted by every adapter. */
export interface ImportSourceOptions {
  /** Absolute or relative path to the source workspace/profile directory. */
  srcPath: string
  /** Override the agent name (defaults to the source directory basename). */
  name?: string
  /**
   * Flatten the persona into `instructions` instead of writing editable
   * `imported/*.md` files referenced via `{{path}}` injection. Default false.
   */
  inline?: boolean
}

/** A blank result skeleton an adapter fills in. */
export function emptyResult(
  source: ImportResult['source'],
  options: CreateAgentOptions,
): ImportResult {
  return { source, options, files: [], loop: [], warnings: [], notTransferred: [] }
}
