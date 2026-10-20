/**
 * Settings → Connections (docs/design/settings-scopes.md §5,
 * docs/design/multi-runtime.md §6.5): This computer, Inside Studio (legacy)
 * while it is in use or saved, the saved remotes (`cli-remotes.json`, shared
 * with `adf`, and the remote URL of `studio-backend.json`), each connected
 * while it is saved, and computers found on the network that are not saved.
 * Never a token.
 */

/** The connection a window uses: its runtime. */
export type ConnectionKind = 'local' | 'embedded' | 'remote'

/** A row's state: a runtime's link state, or Not paired for a computer found on the network. */
export type ConnectionState = 'connected' | 'connecting' | 'retrying' | 'not-connected' | 'not-paired'

/** The words of each state, shared by the Connection page and the status bar's runtime indicator. */
export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  retrying: 'Not connected, retrying',
  'not-connected': 'Not connected',
  'not-paired': 'Not paired',
}

export interface ConnectionCurrent {
  /** `local` or `embedded`: the mode this launch runs (a remote is a runtime of the set, never the current connection). */
  id: string
  kind: ConnectionKind
  /** "This computer" or "Inside Studio". */
  name: string
  /** Remote: the address in use (the indicator's tooltip). */
  url: string | null
  state: Extract<ConnectionState, 'connected' | 'connecting' | 'retrying' | 'not-connected'>
}

export interface ConnectionRow {
  /** As ConnectionCurrent.id, or `found:<fingerprint>@<url>` for a computer found on the network. */
  id: string
  kind: 'local' | 'embedded' | 'saved' | 'found'
  name: string
  /** Null: This computer or Inside Studio while not in use; a saved connection while Inside Studio runs (§7.2). */
  state: ConnectionState | null
  /**
   * At most one action: Connect (This computer or Inside Studio, saved for
   * the next launch), or Add (`pair`) for a computer found on the network.
   */
  action: 'connect' | 'pair' | null
  url: string | null
  /** The host part of `url`, for the detail line. */
  address: string | null
  fingerprint: string | null
  /** Tailnet or https. */
  encrypted: boolean
  /** The host has a pairing window open. */
  pairingOpen: boolean
  /** Remove in the row's More menu: every saved connection. */
  removable: boolean
}

export interface ConnectionsView {
  current: ConnectionCurrent
  /** The mode saved for the next launch when it is not the one this launch runs (multi-runtime.md §7.2). */
  next: { id: string; name: string } | null
  rows: ConnectionRow[]
  /** The network search behind the Not paired rows; null when it is not running. */
  discovery: { browsing: boolean; problem: string | null } | null
  /**
   * The runtime set in its fixed order (docs/design/multi-runtime.md §3.1):
   * This computer first, then the remotes in the order added. Present only
   * while the set has more than one runtime, so a Studio with This computer
   * only sends the list it sent before.
   */
  runtimes?: RuntimeView[]
}

/** A runtime of the runtime set (multi-runtime.md §1.3, §4.5). Its state counts while it is down. */
export interface RuntimeView {
  /** `local`, `remote:<name>` or `remote`. */
  id: string
  kind: 'local' | 'remote'
  /** "This computer", or the saved connection's name. */
  name: string
  /** Remote: the address (the tooltip). */
  url: string | null
  state: ConnectionCurrent['state']
}

export type ConnectionResult =
  | { ok: true; view: ConnectionsView; notices: string[]; id?: string }
  | { ok: false; code: string; error: string }

/** Add connection with a token (settings-scopes.md §5.3). The code path is REMOTE_PAIR_*. */
export interface ConnectionAddRequest {
  url: string
  token: string
  /** The user ticked "I trust this network; the token is sent unencrypted." for this address. */
  allowInsecureHttp?: boolean
}
