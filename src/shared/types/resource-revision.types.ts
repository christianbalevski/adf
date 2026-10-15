/**
 * Resource revisions (W3-F): every config, document and internal-file write
 * of an agent gets a revision, so a client can save "over what I last saw"
 * and learn when someone else wrote in between.
 *
 * Shared by the daemon, Studio main (both backends), the renderer and the
 * terminal app.
 */

/**
 * Who made a change. `agent`: the agent's own runtime (its tools, triggers,
 * lambdas, mesh deliveries) or a change no client announced. `client`: a
 * client session (`client` is its name: `studio`, `tui`, …; never the session
 * id, which frames to other sessions must not carry); embedded Studio writes
 * as `{ kind: 'client', client: 'studio' }`. `cli`: a daemon request
 * that named no client session (the CLI, scripts, other API callers).
 */
export type ResourceWriter =
  | { kind: 'agent' }
  | { kind: 'client'; client: string }
  | { kind: 'cli' }

/**
 * A write refused because the resource changed since the writer's base
 * revision (HTTP `409 stale_revision`; Studio's `{ success: false, conflict }`).
 * `content` is the current text when the answer carries it (Studio main reads
 * it for the renderer); `config` the current config for a config conflict.
 */
export interface ResourceConflict {
  /** `config`, `document`, or the internal file path. */
  resource: string
  revision: number
  writer: ResourceWriter | null
  content?: string | null
  config?: unknown
}

/** The sentence part naming a writer: "the agent", "the terminal app", … */
export function describeWriter(writer: ResourceWriter | null | undefined): string {
  if (!writer) return 'someone else'
  switch (writer.kind) {
    case 'agent': return 'the agent'
    case 'cli': return 'the CLI or another API client'
    case 'client':
      // A Studio never sees its own writes as conflicts: no echo comes back,
      // and a refused save over its own text is retried (edit-conflict.ts).
      if (writer.client === 'studio') return 'another Studio window'
      if (writer.client === 'tui') return 'the terminal app'
      return `another client (${writer.client})`
  }
}
