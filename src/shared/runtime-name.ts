/**
 * How the local runtime is named wherever runtime names show
 * (docs/design/multi-runtime.md §1.3): `<runtime name> (Local)`, e.g.
 * "laptop-1 (Local)". The runtime name is the runtime alias (Settings →
 * Identity), else the computer's host name. With no name known: "Local".
 * A remote shows its saved name; the UI adds the remote icon (tooltip
 * "Remote"), never "(Remote)".
 *
 * Shared by main, the CLI and the renderer; no Electron, no Node.
 */

/** The local runtime with no name known, and the mode's label (Settings → Connections). */
export const LOCAL_LABEL = 'Local'

/** The tooltip of the remote icon beside a remote runtime's name. */
export const REMOTE_TIP = 'Remote'

/** `<name> (Local)`; "Local" when `name` is empty. */
export function localRuntimeName(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed ? `${trimmed} (${LOCAL_LABEL})` : LOCAL_LABEL
}
