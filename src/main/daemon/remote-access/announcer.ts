/**
 * How remote access is announced (docs/design/remote-access.md §5.1): its
 * fields join the one `_adf-runtime._tcp` record of the process's discovery
 * service (RuntimeDiscovery.remoteAnnouncer, mdns-service.ts), while remote
 * access is on and a LAN address of an allowed network listens. TXT: `v`,
 * `fp` (fingerprint), `pair` (window open), `daemon_port`, `api`, `name`.
 * Never a token, a code, an owner DID, a path or a user name.
 *
 * The separate `_adf-daemon._tcp` announcement of this PR's intermediate
 * commits is gone; mdns-service.ts still browses it for one release.
 */

export interface Announcement {
  /** The computer name (the runtime alias, else the host name). */
  name: string
  /** The runtime alias, when the user set one (the instance name when the mesh is hidden). */
  alias?: string | null
  /** The daemon's port. */
  port: number
  /** The LAN address to announce from: one that listens, so on an allowed network. */
  iface: string
  /** The tailnet addresses the daemon listens on (TXT `ts`): clients merge this LAN record with the tailnet hello. */
  tailnet?: string[]
  txt: { v: string; fp: string; pair: '0' | '1'; api: string }
}

export interface Announcer {
  announce(a: Announcement): Promise<void>
  stop(): Promise<void>
  readonly announcing: boolean
  readonly problem: string | null
}

/** No discovery service in this process (tests, tools): nothing is announced; remote access works by address. */
export const NO_ANNOUNCER: Announcer = {
  announce: async () => {},
  stop: async () => {},
  announcing: false,
  problem: null,
}
