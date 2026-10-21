# Remote access

Design for letting Studio's local daemon be reached from another computer, by copy-paste (address + token) or by LAN pairing (discovery + 6-digit code). Status: daemon and CLI built on `feat/remote-access` (`src/main/daemon/remote-access/`, `routes/remote-access-routes.ts`, `src/main/cli/{remote-access-cli,pair,remotes,daemon-discovery}.ts`); Studio UI on `feat/remote-access-ui`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

Read with: [daemon-backend.md](daemon-backend.md) §5.3.1 (the token is equivalent to the owner phrase), §8 (lifecycle), §9 (remote mode); [remote-daemon.md](../cli/remote-daemon.md); [studio-backend.md](../guides/studio-backend.md#remote-computer).

## 1. Goal

Today (remote-daemon.md Option 2) a user who wants a second computer to reach this one sets `ADF_DAEMON_TOKEN` and `ADF_DAEMON_ALLOWED_HOSTS`, runs `adf daemon --host 0.0.0.0` in the foreground, adds a firewall rule and finds the token. Studio cannot do it at all: `buildDaemonEnv` forces `ADF_DAEMON_HOST=127.0.0.1` (`backend/daemon-process.ts:158`) and `DaemonHost.start` refuses a non-loopback bind without `ADF_DAEMON_TOKEN` (`daemon/daemon-host.ts:182`).

After this change:

- Host: Settings → Networking → **Remote access** (or `adf daemon remote on`). The section shows the addresses (Copy), **Add device** (a token shown once), **Devices** with who is connected now and **Revoke**, and **Pair device** (6-digit code). Settings → Backend → This computer shows one line, "Remote access: On · *N* devices", with a link to Networking.
- Client: Settings → Backend → Remote computer → **Discovered** lists the ADF computers found on the LAN and the tailnet. Choose one, type the code shown on the host, the host confirms, done. Or paste address and token. `adf pair` does the same in the terminal.
- No environment variable, no foreground daemon, no hand-made firewall rule on Windows or macOS.

Non-goals: TLS in the daemon (§9.2 of daemon-backend.md stands); scoped (less than full) tokens; access from the internet; more than one OS user per daemon.

## 2. Decisions

| # | Decision | Section |
|---|---|---|
| R1 | Turning remote access on or off does not restart the daemon. The daemon opens extra listeners live; agents keep running. (The request said "Studio restarts its own daemon"; see Q1.) | §3.2 |
| R2 | Extra listeners bind each private LAN address (RFC 1918, IPv6 ULA) and each Tailscale address on a network the user allowed, never `0.0.0.0`, never a public address. Re-evaluated every 10 s. | §3.3, §3.3.1, §3.4 |
| R3 | The setting lives in the daemon's settings directory (`remote-access.json`), so Studio, `adf daemon start`, auto-start and a service all apply it. No env var. | §3.1 |
| R4 | Per-device tokens, SHA-256 hashed at rest, with label, created, last seen. Revoking one closes that device's sessions and streams. | §4 |
| R5 | The install's file token (the master token) is never accepted on a remote listener. Device tokens are never accepted on local-only routes or on the remote-access management routes, from anywhere. | §4.4, §4.5 |
| R6 | "New token" creates a device token and shows it once. "Show" works only while that dialog is open. | §4.6 |
| R7 | Pairing: 6-digit code, window 120 s, 5 wrong codes lock that source out, 20 in total close it, AND the host MUST confirm "Allow *name*?". Code alone never suffices. | §5 |
| R8 | No PAKE, no X25519 in v1. Every later request carries the bearer token in clear over http, so protecting only the claim buys nothing against a sniffer. The transport answer is Tailscale (WireGuard) and `tailscale serve` (https). | §5.6, §5.7 |
| R9 | Firewall: rely on the OS prompts (Windows, macOS); never add a rule ourselves; detect a block where it can be read without elevation and say how to fix it. Linux: documented commands. | §6 |
| R10 | Every state change is visible: a status line, the devices list, notices, the daemon log, `adf daemon remote status`. | §8 |

## 3. Host: listeners and addresses

### 3.1 Setting

File `<settings dir>/remote-access.json` (next to `daemon-token`), written with `writeSecretFileAtomic` (§10.1). The daemon writes it through the management routes (§11.2). Studio without a daemon (embedded mode) changes only `allowedNetworks`, for the mesh's LAN mode.

| Field | Type | Content |
|---|---|---|
| `v` | number | `1`. Any other value: the daemon MUST treat remote access as off and log why. |
| `enabled` | boolean | Remote access on. |
| `name` | string | Computer name shown to other computers. Default: OS host name. 1-63 characters, no control or bidi characters. |
| `daemonId` | string | 128-bit random, base32, minted on first enable, never changed. Its display form is the fingerprint (§5.1). |
| `allowedNetworks` | `{id, kind, label, addedAt}[]` | Networks the user allowed (§3.3.1). Remote access and the mesh's LAN mode read the same list. |
| `addresses` | string[] \| absent | Advanced (CLI only, `--address`): bind exactly these addresses instead of the automatic set. Each MUST be a private or Tailscale address (§3.3). |

Device records are a separate file (§4.3) so a corrupt device file never turns remote access on or off.

### 3.2 Listeners

- The main listener stays `127.0.0.1:<port>`, unchanged, for every mode.
- With remote access on, the daemon opens one extra `http.Server` per eligible address, on the same port (`192.168.1.20:7385`, `100.101.102.103:7385`). Binding specific addresses on the same port does not conflict with the loopback bind on Windows, macOS or Linux; a wildcard bind next to it does on Linux (EADDRINUSE) and depends on socket options elsewhere. A wildcard bind would also expose public interfaces.
- Each extra server hands its requests to the same Fastify instance through `fastify.routing(req, res)` (the public router entry used by `serverFactory`), so every hook, guard and route is shared. Each accepted socket is tagged `remoteListener = true` at `connection`; the guard reads the tag (§4.4).
- Disable, daemon stop, or an address going away: the server stops listening and destroys its sockets (`closeAllConnections`), including hijacked SSE responses, which the main server's SSE sweep does not see.
- Turning off takes effect at once (device tokens refused, no listener may open) and closes the listeners in the same serialized chain as the address checks, after any check in flight. Each listener asks "still on?" before it opens and again once it listens, closing at once otherwise, so no listener outlives "off" (security review item 6).
- A listener that fails to bind (EADDRINUSE, EADDRNOTAVAIL) is reported per address (`addresses[].problem`) and retried at the next check; the others keep running.
- `DaemonHost.start`'s check (non-loopback `host` needs `ADF_DAEMON_TOKEN`) stays as it is for the env path (§3.7). The extra listeners do not go through it: they accept device tokens only (§4.4), so no operator-chosen token is needed.

### 3.3 Eligible addresses

From `os.networkInterfaces()` (same API on Windows, macOS and Linux), skipping `internal`:

| Address | Bound | Reason |
|---|---|---|
| IPv4 `10/8`, `172.16/12`, `192.168/16` on a non-virtual interface | Yes | LAN |
| IPv4 `100.64/10` that `tailscale status --json` lists in `Self.TailscaleIPs` | Yes, kind `tailnet` | Tailnet. Without that confirmation the range is carrier-grade NAT (a phone hotspot, some ISPs) and MUST NOT be bound. |
| IPv6 in `fd7a:115c:a1e0::/48` listed in `Self.TailscaleIPs` | Yes, kind `tailnet` | Tailnet |
| IPv6 ULA `fc00::/7` (other) | Yes, only on an interface without a private IPv4 address | LAN. ULA privacy addresses come several at a time and rotate; IPv4 reaches the same LAN |
| IPv6 link-local `fe80::/10` | No | Needs a zone id in every URL; IPv4 or ULA covers the same LAN |
| Any other address (public IPv4, IPv6 global unicast) | No | Would be reachable from the internet where no NAT or router firewall stands in front |
| Any address on a virtual interface | No | Docker, WSL, Hyper-V, VMware, VirtualBox, VPN taps: the regexes of `mdns-service.ts` (`VIRTUAL_IFACE_RE`, `VIRTUAL_IFACE_WIN_RE`), minus the Tailscale names, which are matched by address above |

Any of these gets a listener only on a network the user allowed (§3.3.1), the tailnet included.

The Tailscale check reuses `TailnetDiscovery`'s binary lookup (`tailscale` on PATH, `C:\Program Files\Tailscale\tailscale.exe`, `/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale`; on macOS also `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). Interface names differ per OS (`en0`/`eth0`/`wlan0`, `Wi-Fi`/`Ethernet`, `utun4`/`tailscale0`/`Tailscale`); the decision is by address, the names only exclude virtual adapters.

#### 3.3.1 Consent per network (owner decision 2026-10-18 b)

The daemon MUST NOT listen without the user's consent, given once per network, the same on every OS. On the first visit to a network nothing listens. Remote access stays on; each address is listed with `allowed: false`, `listening: false` and the problem "Not allowed on this network." When nothing listens for that reason the state is `paused` with "Paused on <network label>." The mesh's LAN mode follows the same rule and the same list (`allowedNetworks` in `remote-access.json`).

Consent applies on every network, the tailnet and a Windows Private network included. None of these count as consent: Windows' Private/Public category, any macOS or Linux heuristic, being on the tailnet.

| Network | Identity (`NetworkView.id`) |
|---|---|
| LAN | `lan-` + the first 16 hex characters of `sha256("<gateway MAC>\|<subnet>\|<Wi-Fi name>")`. Gateway and MAC: Windows `route print -4 0.0.0.0` and `arp -a`, macOS `netstat -rn -f inet` and `arp -an`, Linux `/proc/net/route` and `/proc/net/arp`. Subnet: the interface's IPv4 network (`192.168.1.0/24`), else its IPv6 /64. Wi-Fi name: only where reading it never asks for a permission: Linux `iwgetid <iface> -r`; macOS `ipconfig getsummary <iface>`, which macOS 14.4 and later answer `<redacted>` without location access (then no name); never on Windows, whose WLAN API needs location access (Windows 11 24H2 may ask) and whose connection-profile name needs PowerShell and can be renamed. Label: `<Wi-Fi name or interface> (<subnet>)`. The MAC is never taken from an earlier check: a switch between two checks, or sleep and wake, cannot be seen. Every check first sends one UDP datagram to the gateway's discard port (9) from the interface's address, so the OS resolves the gateway by ARP, then reads the table; a MAC still missing is probed again, up to 3 tries 200 ms apart. A gateway that answers keeps its network (an ARP entry that merely aged out is no change); a gateway that gives no MAC after the tries leaves the network unidentified (`id: null`, label "Unidentified network"): it never matches consent, its listeners close, and it cannot be allowed. |
| Tailnet | `tailnet-` + the first 16 hex characters of `sha256(<tailnet name>)`; the name is `tailscale status --json` `CurrentTailnet.Name`, else the MagicDNS suffix. Label: `Tailnet <name>`. |

Consent:

- `POST /remote-access/networks {id}` allows a network this computer is on now; `DELETE /remote-access/networks/:id` removes one and its listeners close at once. Both are management routes (§11.2): local caller, local proof, never a device token. They work while remote access is off. Each change is logged, emits `networks_changed`, and the daemon's mesh re-syncs its LAN listeners at once.
- Studio, when remote access or the mesh's LAN mode is on and this computer is on a network not allowed, shows a non-modal strip in the window, never a dialog (consent review 3): "Remote access paused on <network label>." with **Allow on this network** and **Not now** (an unidentified network: **Open Networking** instead of Allow). On a LAN the OS reports Public, or does not report (macOS, Linux), one more line: "Public network. The token is sent unencrypted." It shows once per network identity per Studio session: Wi-Fi that drops and comes back never shows it again; the status line keeps showing the state. Allow, Not now or leaving the network takes the strip away. Settings → Networking lists **Allowed networks** with **Remove**.
- The CLI shows the networks in `adf daemon remote status` and changes consent with `adf daemon remote allow-network [<id|label>]` and `forget-network <id|label>`.

Windows' category (`Get-NetConnectionProfile`, no elevation, re-read every 60 s and on a network change) is read only for the warning line (`NetworkView.osCategory`).

Rationale: no OS tells a home from a hotel reliably, and the same rule on every OS is simpler to explain and to test. The gateway's MAC address and the subnet change with the network, so a hotel never matches home. A spoofed gateway MAC only gets an attacker a listener that still requires a device token.

### 3.4 Network changes

Node has no portable interface-change event. While remote access is on, the daemon re-reads `os.networkInterfaces()` every 10 s (and `tailscale status --json` every 60 s and whenever a 100.64/10 address appears or goes). On a difference it MUST:

1. open listeners for new addresses and close those for vanished ones (§3.2);
2. recompute the allowed host names (§3.5) and the URLs (§7);
3. re-announce mDNS on the current interface (§5.1);
4. log one line naming added and removed addresses, and emit `remote_access` event `addresses_changed`.

The network identity (§3.3.1) is read at every check (cheap: `/proc/net/route` and `/proc/net/arp` on Linux, `netstat -rn` and `arp -an` on macOS, `route print -4 0.0.0.0` and `arp -a` on Windows). When an interface's addresses or network differ from the last read, the daemon MUST close that interface's LAN listeners first, before any slower read, and open them again only on an allowed network (security review 2026-10-18, item 2). The MAC comes from this check's ARP probe only (§3.3.1): a known different MAC or gateway is another network, and no MAC after the probe is an unidentified network; both close the interface's listeners.

With no eligible address the state is `no_address` ("No LAN or tailnet address."). When every address is allowed but none listens (the port is taken), the state is `error` with the first reason ("Not listening: another program uses port 7385 on 192.168.1.20."). The setting stays on and listeners return with the network.

### 3.5 Host names

The daemon adds to its Host allow-list, for every listener: the OS host name, `<host name>.local`, and, when Tailscale runs, `Self.DNSName` (the MagicDNS FQDN, trailing dot removed) and its first label. They are merged with `ADF_DAEMON_ALLOWED_HOSTS` (env entries are kept). IP literals on the bound port are already accepted for non-loopback binds (`ipLiteralPort`, request-guard.ts). The list is in the status (`hostNames`).

### 3.6 Lifecycle and keep-running

Remote access works only while this daemon runs.

- The setting is applied at every daemon boot, whoever starts it (Studio, `adf`, `adf daemon start`, a service). A daemon started with remote access on logs `[remote-access] on: listening on <addresses>`.
- Studio-started daemon with **Keep the daemon running** off: quitting Studio stops the daemon and every remote client loses it. The Remote access section MUST say so next to the toggle (row **On quit**: "Devices lose the connection when Studio quits.") with a button **Keep running** that sets `keepDaemonRunning`. Studio MUST NOT change `keepDaemonRunning` by itself.
- Sessions opened with a device token MUST NOT hold a Studio-requested stop (`daemon_orphan_hold`, §8.3 of daemon-backend.md). Otherwise any paired laptop would keep this computer's daemon running indefinitely after the owner quit Studio.
- Instead, Studio's quit MUST ask, every time a device is connected and the daemon would stop: dialog **Quit**, "*N* devices connected", "Keep the daemon running for them, or stop it." **Keep running**, **Stop daemon**, **Cancel**. The answer applies to this quit only: nothing is remembered and `keepDaemonRunning` is not changed (owner decision O3).
- Sleep, reboot, logout: the daemon is gone or unreachable; clients use their existing retry (remote connector, 2 s to 30 s).

### 3.7 The env path stays

`adf daemon --host <addr>` with `ADF_DAEMON_TOKEN` (remote-daemon.md Option 2) is unchanged. While `ADF_DAEMON_HOST` is non-loopback, `PUT /remote-access {enabled:true}` answers 409 `env_bind` and the status state is `env_bind`; the two mechanisms never stack. `tailscale serve` and TLS proxies in front of the loopback listener (Options 3, 4) keep working, and device tokens are accepted through them (§4.4).

## 4. Tokens

### 4.1 Kinds

| | Master token | Device token |
|---|---|---|
| What | `<settings dir>/daemon-token` (or `ADF_DAEMON_TOKEN`), as today | One per paired or copy-paste device |
| Who | Studio main, `adf` on this machine | Another computer |
| Stored on the host | Plain, 0600 / own ACL (unchanged) | SHA-256 of the secret, in `daemon-devices.json` |
| Revocable alone | No (rotate = every local client re-reads the file) | Yes |
| Power | Everything | Everything but local-only and management routes. Still equivalent to the owner phrase (§4.5). |

### 4.2 Format

`adfd_<id>_<secret>`: `id` = 10 base32 characters (50 bits, unique per daemon), `secret` = 32 random bytes, base64url (43 characters). The whole string matches the existing header-safe rule (`[A-Za-z0-9_-]`, ≥ 32 characters), so clients that store a pasted token today accept it unchanged. The prefix lets the guard find the record by `id` without comparing against every hash and lets a leaked token be recognised in logs and scanners.

### 4.3 Store

`<settings dir>/daemon-devices.json`, written with `writeSecretFileAtomic` on every write (§10.1).

```json
{ "v": 1,
  "devices": [{ "id": "k3j9q2m7xa", "label": "agent-2 laptop", "origin": "paired",
                "createdAt": "2026-10-18T09:12:03Z", "createdBy": "studio",
                "secretSha256": "<hex>", "lastSeenAt": "2026-10-18T11:40:00Z",
                "lastSeenAddress": "192.168.1.31" }],
  "revoked": [{ "id": "p0c4w8e1rt", "label": "old tablet", "revokedAt": "2026-10-01T08:00:00Z" }] }
```

- A plain SHA-256 is enough: the secret has 256 bits of entropy, so no slow KDF is needed. Comparison is constant-time (`tokensEqual`).
- `lastSeenAt` / `lastSeenAddress` are exact in memory and written to the file at most once per 5 minutes per device, and at shutdown.
- `revoked` tombstones are kept 30 days so a revoked device gets a sentence instead of a bare 401.
- An unreadable or malformed file: no device token is accepted, remote access reports `problem`, the daemon logs it. It is never replaced silently (unlike `daemon-token`), because that would revoke every device without the owner knowing.

Honest limit: the master token sits in plain text in the same directory. Hashing device tokens protects copies of `daemon-devices.json` (a backup, a synced folder), not a process that can read the directory.

### 4.4 Where each token is accepted

| Request arrives on | Master token | Device token, remote access on | Device token, remote access off |
|---|---|---|---|
| Loopback listener, no proxy header | Yes | Yes, except §4.5 routes | 401 `remote_access_off` |
| Loopback listener via `tailscale serve` / a TLS proxy | Yes (unchanged) | Yes, except §4.5 routes | 401 `remote_access_off` |
| Remote listener (§3.2) | 401 `master_token_remote` | Yes, except §4.5 routes | (no listener) |

The guard (`DaemonRequestGuard.check`) changes from one token to a `TokenVerifier` that returns `{kind: 'master'} | {kind: 'device', id} | refusal` and decorates the request with `authKind`, `deviceId`. `master_token_remote` says: "This computer's own token is not accepted from other computers. Pair this computer, or create a token for it on the host: adf daemon devices add <label>."

Rationale for refusing the master token remotely: it cannot be revoked without breaking this machine's own clients, and nobody needs it remotely once device tokens exist. `adf daemon token` keeps printing it; its help and output (stderr) point other computers to `adf daemon devices add`.

### 4.5 What a device token cannot do

A device token MUST be refused (403 `device_token_refused`), on every listener, for:

- every route `isLocalOnlyRoute` lists (owner create / restore / import / unlock / lock / confirm-backup, trust-daemon, untrust-daemon, value reveal, provider key reveal, shutdown, credential reload, `GET /client/sessions`), except the three client-session routes whose handlers decide per request: `POST /client/sessions`, `POST /client/sessions/:id/quit`, `PUT /client/sessions/:id/exit-when-closed` (a remote Studio opens and quits its session; `exitDaemonWhenClosed` and `stopDaemon` still refuse a device token through `requireLocalCaller`). Code: `isDeviceRefusedRoute` (local-access.ts). The guard judges the route Fastify matched (`request.routeOptions.url`, the pattern), or, with no match, the percent-decoded path with repeated and trailing slashes and `;` parameters removed: never the raw URL, which `GET /client/session%73` used to slip past (security review item 5). Handlers of local-only routes refuse a device token again themselves (`requireLocalCaller`, `requireLocalProof`, `GET /client/sessions`);
- every `/remote-access` management route (§11.2): a device cannot mint tokens, list or revoke devices, open pairing or turn remote access on or off.

`isLocalOnlyRoute` gains `/remote-access` and `/remote-access/*`; `requireLocalCaller` gains the token-kind check, so the refusal does not depend on the peer address (an SSH tunnel to loopback with a device token is still refused). The management routes also require the local proof in every mode, as `POST /identity/import` does, because they create credentials.

This does not make device tokens weak. A device token can attach a stdio MCP server or adapter with a chosen command and start the agent, which runs code as the daemon's OS user and reads the owner phrase from the keychain (daemon-backend.md §5.3.1). Every device token MUST be treated as the 12 words. The UI says so where a token is created or a pairing is confirmed (§7, §5.4).

### 4.6 Copy-paste: New token

**New token** (Studio) / `adf daemon devices add <label>` (CLI) asks for a label ("Which computer is this for?", default "Computer added <date>"), calls `POST /remote-access/devices`, and shows the token once, masked, with **Show** and **Copy**, until the dialog closes. Only the hash is stored, so the token cannot be shown again; a lost token is revoked and a new one made. The CLI prints the token alone on stdout and the label, id and warning on stderr (pipeable, like `adf daemon token`).

### 4.7 Revocation

`DELETE /remote-access/devices/:id`, in order:

1. remove the record and write the tombstone (file first, so a crash cannot resurrect the device);
2. drop the id from the in-memory verifier: the next request with the token gets 401 `device_revoked` ("This computer's access to *name* was removed on *date*.");
3. end every client session the device opened: the stream gets control frame `session.ended {reason: 'device_revoked'}`, then closes; documents are released as on expiry;
4. destroy every socket that authenticated with the device's token (tracked per device from the guard's decoration), including hijacked SSE responses and keep-alive sockets;
5. log `[remote-access] revoked <id> "<label>": closed <s> sessions, <c> connections`, emit `device_revoked`.

The answer reports `closedSessions` and `closedConnections`. Turning remote access off does steps 3-4 for every device but keeps the records.

### 4.8 "Connected now"

A device is connected while it has an open client session, an open SSE stream, or made a request in the last 60 s. `connections` counts its open sockets. Shown live in the devices list.

## 5. Discovery and pairing

### 5.1 One announcement, one discovery feed

Each process has one mDNS announcement and one browser (`mdns-service.ts`), and each computer one discovery feed: the daemon's discovery service (`runtime-discovery.ts`) in local mode, Studio main's own in embedded and remote mode, `adf pair`'s own only when no daemon runs here. The mesh's `_adf-runtime._tcp` record carries remote access too; there is no separate service type.

**Announcement.** `_adf-runtime._tcp`, host `<host name>.local`; instance `adf-<runtime_id>` while the mesh is visible. It is published while the mesh is LAN-visible (an agent with `lan` or `public` visibility, mesh LAN mode on an allowed network) or remote access is on and a LAN address of an allowed network listens (§3.3.1), and only from such an address. On a network not allowed nothing is announced. A change (pairing window, remote access on or off) re-publishes the record; the browser is untouched.

| TXT | When | Value |
|---|---|---|
| `runtime_id`, `proto`, `directory`, `runtime_did` | the mesh visible | The mesh's fields, as before (`runtime_did` only when known) |
| `v` | remote access on | `1` |
| `fp` | remote access on | Fingerprint: first 40 bits of `sha256(daemonId)`, base32, as `XXXX-XXXX` |
| `pair` | remote access on | `1` while a pairing window is open, else `0` |
| `daemon_port` | remote access on | The ADF daemon's port |
| `api`, `name` | remote access on and the mesh visible | `CLIENT_API_VERSION`; the computer name (§3.1) |

The mesh hidden and remote access on (discovery review 2): the record carries only `v`, `fp`, `pair` and `daemon_port`, on the daemon's port, under the runtime alias when the user set one, else `adf-<12 random hex>`, new on every network. No runtime id, runtime DID or directory, so a hidden runtime cannot be followed from network to network by them. A browser keys such a record by fingerprint and shows the alias, else the host name.

The record MUST NOT carry a token, a code, a claim id, the owner DID, a path or a user name. The fingerprint is a label that tells the owner's computers apart and dedups LAN and tailnet entries; it is not authenticated (anyone can copy it, §10).

**Legacy.** This PR's intermediate commits announced remote access as `_adf-daemon._tcp` (TXT `v`, `fp`, `pair`, `api`; instance name = computer name). The browser still reads it for one release, so such a daemon is found; nothing announces it. To be removed after the next release (`LEGACY_DAEMON_SERVICE_TYPE`).

**Feed.** One cache of entries (`NetworkPeer`), each with both capabilities: `mesh` (base URL and port, when visible) and `remote` (URL, port, fingerprint, pairing open, `lan` or `tailnet`). Sources: the browser, and the one tailnet sweep (`TailnetDiscovery`): every 45 s it asks each online tailnet peer for `GET /ping` on the mesh ports and `GET /remote/hello` on the daemon port (§5.2); a tailnet sighting wins over a LAN one (encrypted). One event stream, `peers_changed`.

| Reader | How |
|---|---|
| Mesh peer list (Settings → Networking, the fleet map, `agent_discover`) | `getDiscoveredRuntimes`: the entries with a mesh, decorated |
| Studio's Discovered list (Settings → Backend → Remote computer) | Local mode: `GET /network/peers`, re-read on the daemon's `remote_access` push `{type: 'peers_changed'}`. Embedded mode: Studio's mesh service while it runs, else its own browse-only one. Remote mode: its own browse-only one |
| `adf pair` | `GET /network/peers?wait=3000` from this computer's daemon; without one, its own browse-only service and hello sweep for 3 s |

**Intake** (discovery review 3). What other computers send is untrusted. An announcement whose TXT record is over 4 KB, or has a value over 255 bytes, is dropped; so is a hello body over 4 KB (not read further), a fingerprint not shaped `XXXX-XXXX`, or a version other than 1. Every name is cleaned at intake (terminal sequences, control, bidi and invisible characters dropped, whitespace collapsed, at most 63 characters, `cleanDisplayName`). `adf pair` and `adf remotes` strip control characters and escape sequences from everything they print. The cache keeps each sighting per source (an announcement instance, a tailnet address): a LAN and a tailnet sighting of a fingerprint are one computer only when that LAN record lists that exact tailnet IP (the tailnet address is WireGuard-authenticated, so nobody else can make the real host name theirs); the tailnet address and its own name are shown. Any other two sightings of one fingerprint are a clash: every address is its own entry (`clash: N` in `GET /network/peers`), never one silently replacing another, neither preferred. Studio and `adf pair` show no warning for it: the fingerprint check when pairing tells the real host apart, and a saved connection is pinned. A mesh runtime joins an entry only when it comes from the same source address as that entry (discovery re-check).

`GET /network/peers` is local-only (`isLocalOnlyRoute`: this machine's own clients with the local proof, never a device token). It keeps the daemon's discovery running for a minute (a client that only pairs needs no mesh and no remote access of its own); `wait` (0-5000 ms) lets a browser that just started hear answers.

### 5.2 Hello

`GET /remote/hello`, no token, on every listener while remote access is on: `{v: 1, name, fingerprint, pairingOpen, clientApiVersion, helloProof: 1}`. Same content as the announcement. It serves clients that cannot hear mDNS: a tailnet peer (multicast does not cross WireGuard), a typed address. Rate limit: 30 per minute per source address.

Nothing in this answer is authenticated. The fingerprint is a name for display and for comparison by people, not a key: it is the first 40 bits of SHA-256 of `daemonId` (§3.1), and anything at an address can show it.

#### 5.2.1 Authenticated hello (review round 2, R2A-2)

Before a client sends a saved device token, it MUST check that the computer at the address holds that device's record. The fingerprint does not name a signing key, so the proof is keyed by the device credential that both sides already hold.

- Request: `GET /remote/hello?nonce=<n>&device=<id>&origin=<o>`. `n` is 32 random bytes, base64url, new for each hello. `id` is the device id of the client's `adfd_<id>_<secret>` token (§4.2). `o` is the origin the client dialed (scheme, host, port). The three go together; a partial or malformed set answers 400 `bad_request`.
- Key: `K = SHA-256(secret)`, raw 32 bytes. The daemon keeps it (`daemon-devices.json` `secretSha256`, §4.3); the client computes it from its token. The token itself is never sent.
- Message: `"adf-remote-hello-v1\n" + n + "\n" + fingerprint + "\n" + o + "\n" + id`.
- Answer: the hello plus `device` (`known`, `unknown`, `revoked`) and `proof` = base64url(HMAC-SHA256(K, message)), null unless `device` is `known`. The same rate limit applies.
- The client verifies the proof in constant time against its own nonce, the pinned fingerprint and the origin it dialed. Only `verified` with the pinned fingerprint lets the token go. A different fingerprint is "another computer"; a wrong proof, `unknown` or `revoked` is a refusal; the token is not sent in any case.
- An answer without `helloProof: 1` or without `proof` is an older ADF. It is refused with "*name* runs an older ADF; update it." There is no unsigned fallback (owner decision).
- Checked on every dial and re-dial wherever a pin is checked: Studio's remote connector (launch and every attempt), the connection's pin check (after a drop, on wake, on Reconnect), Add connection with a token, `adf` before any command with a saved token (the terminal app is launched through the same check).
- Pairing: a fresh pairing pins the fingerprint only after the address it saves (and any encrypted address it switches to, §5.7) proved, with the token just delivered, that it issued it. `adf pair` and Studio refuse a host whose plain hello has no `helloProof` before the code is typed, so no device is left on an older host.

Why this and not a signature: a signature needs a public key the fingerprint commits to, and the fingerprint commits to `daemonId`, a random id. A new key and a new fingerprint would change every saved pin, and 40 bits would still be too short to bind a key. The device token is already a 256-bit secret shared with exactly one host. The proof binds the answer to it, to the nonce (no replay) and to the origin.

What it does not stop: an active attacker on the path who relays the whole hello to the real host and then reads the token from the next plain-http request. That is the plain-http risk of §5.6 and §10, and it is why encrypted transports come first. A fresh pairing with an impostor that runs its own pairing gives the client that impostor's own token: no token of the real host leaks.

### 5.3 Pairing window

Opened by **Pair a computer** in Studio or `adf daemon pair` (`POST /remote-access/pairing`).

- Code: `crypto.randomInt(0, 1_000_000)`, six digits zero-padded, shown on the host only (panel, CLI). Never logged, never in an event payload, never announced.
- Lifetime 120 s from opening. Opening again replaces the window with a new code.
- 5 wrong codes from one source lock that source out of the window: its later claims, the right code included, answer 429 `rate_limited` until the window closes. The owner is told each time (event `pairing_lockout`, `PairingWindowView.lockedSources`, a log line naming the address) and the window stays open for everyone else, so one stranger on the LAN cannot close it (security review item 8). 20 wrong codes in total close the window ("Pairing closed after 20 wrong codes."). The owner opens a new one by hand; nothing reopens by itself.
- One correct claim moves the window to `claim_pending`; further claims get 409 `pairing_busy`. The window closes when the host decides or when it expires, whichever is first.
- Closing (**Cancel**, Ctrl+C in `adf daemon pair`, expiry, remote access off, daemon stop) discards the code and any pending claim.

### 5.4 Claim, host confirmation, delivery

```text
client                                   host daemon                         host UI (Studio / adf daemon pair)
  POST /pair/claim {code, deviceName, clientKind}
                      ── code ok ──▶ claim pending ── event claim_pending ──▶ GET /remote-access → "Allow agent-2 laptop?"
  ◀── 202 {claimId, expiresAt, collectSecret}
  GET /pair/claims/:claimId?wait=25, X-ADF-Pair-Secret: collectSecret  (long poll, repeated)
                                                    ◀── POST /remote-access/pairing/claims/:claimId {allow}
  ◀── {state: approved, token, device, daemon}   (delivered once, then the claim is deleted)
```

- `deviceName`: 1-64 characters after whitespace runs are collapsed to one space and the ends trimmed. Refused (400): C0/C1 controls, every bidi control (U+061C, U+200E/F, U+202A-E, U+2066-9), U+2028/9, zero-width characters (U+200B-D, U+2060), U+FEFF, and input over 256 characters. It becomes the device label. Labels and the computer name follow the same rule (`cleanDisplayName`, security review item 4).
- `claimId`: 128-bit random. The owner's clients see it (`GET /remote-access` → `pairing.claim`) and answer with it; it does not collect anything.
- `collectSecret`: 256-bit random, only in the 202 answer, never in the status, an event or the log. Collecting the result needs it as `X-ADF-Pair-Secret`, compared in constant time; a missing or wrong one answers 404 `claim_not_found`, as an unknown claim does. So a paired device, or anything that learns the claim id, cannot collect a new device's token (security review 2026-10-18, item 1).
- `claim_pending` means "pending claims changed" and carries nothing; Studio and `adf daemon pair` read the claim through the local-only `GET /remote-access`.
- Host confirmation is REQUIRED in addition to the code. The prompt shows: device name, source address, how it arrived (`lan`, `tailnet`, `proxy`), the client kind, and, on a tailnet, the peer's Tailscale login from `tailscale whois <addr>` when available. Text: "Allow *agent-2 laptop* (192.168.1.31, this network) to control this computer's ADF daemon? It gets the same power as your seed phrase." Buttons **Allow** / **Deny**. Studio shows it as a modal in the window and, when the window is not focused, an OS notification that opens it. `adf daemon pair` prompts `Allow …? [y/N]`. The first decision from any local client wins.
- Why both: the code proves the person at the client sees the host's screen, so a stranger on the LAN cannot spam "Allow?" prompts under a plausible name; the confirmation proves the owner consents and lets them check the address, which is the only defence against a relayed code (§10).
- Approval creates the device record (`origin: 'paired'`) before the token is released. The token is returned once, to the first poll after approval, with `Cache-Control: no-store`; the claim is then deleted. A token never collected (client gone) leaves a device the owner sees in the list with "Never connected" and can revoke.
- Denial: poll answers `{state: 'denied'}`; the client says "*host* did not allow this computer."

### 5.5 Brute force and abuse

| Control | Value |
|---|---|
| Code space | 10^6; at most 20 guesses per window (5 per source), so at most 2 × 10^-5 per window an owner opens, and a correct guess still needs the owner's Allow |
| Per source address | 1 claim per 2 s, 10 per 10 minutes; over that: 429 `rate_limited` with `Retry-After` |
| What a source is | The socket's peer address. `X-Forwarded-For` and other forwarded headers are never read (any process on this machine can send them to the loopback listener). Behind `tailscale serve` only (`ADF_DAEMON_BEHIND_PROXY` set, loopback peer), the `Tailscale-User-Login` / `Tailscale-User-Name` headers serve sets name the tailnet user: the prompt shows it and the limits count per user. `tailscale whois` runs only on the socket address of a tailnet listener, never on a header value (security review item 3) |
| Memory | The per-source counters (`/remote/hello`, `/pair/claim`) keep at most 1024 sources, dropping the least recently seen |
| Wrong code | 403 `wrong_code` with `attemptsLeft` (the smaller of this source's and the window's), answered after a fixed 1 s delay |
| Window closed / never opened | 404 `pairing_closed`, same body whether a window existed or not |
| Remote access off | `/remote/hello`, `/pair/*` answer 404 `remote_access_off` on loopback; remote listeners do not exist |
| Bearer guessing | 256-bit secrets, no lockout needed; 401s from one source are logged at most once a minute with a count |
| Browser pages | The existing Host / Origin / `Sec-Fetch-Site` checks apply to the unauthenticated routes too (DNS rebinding, CSRF) |

Each claim (address, device name, result) is logged; the code is not.

### 5.6 Crypto: why no PAKE or X25519 in v1

- After pairing, every request carries `Authorization: Bearer adfd_…` over the same transport. On plain http a passive sniffer reads it from the first request. Hiding the token inside the claim (X25519 box) or never sending the code (SPAKE2) changes nothing for that attacker.
- SPAKE2 would stop one specific attack: a rogue mDNS responder learning the code and relaying it (§10). An attacker who can answer mDNS on the LAN can, with the same tools, ARP-spoof and read every later plain-http request. The host confirmation with the source address is the v1 defence.
- Protection against a passive sniffer would need the token to stop travelling, for example HMAC-signed requests keyed by the device secret. That changes every client (Studio, CLI, SSE resume) and still leaves responses (chat, files) readable. Listed as a possible follow-up, not designed here.
- Decision: the code is an authorization factor, not a key. Encryption comes from the transport (§5.7).

### 5.7 Transport and the nudge toward encryption

| Address | Encrypted | Notes |
|---|---|---|
| `https://<machine>.<tailnet>.ts.net` (`tailscale serve`) | Yes (TLS, trusted certificate) | Preferred. Arrives on the loopback listener with forwarded headers, so it is never "local" |
| `http://100.x.y.z:7385` (tailnet listener) | Yes (WireGuard between tailnet nodes) | Accepted by Studio without the plain-http confirmation (daemon-backend.md §9.2) |
| `http://192.168.x.y:7385`, `http://<host>.local:7385` | No | Anyone who can see the traffic on this network can take the token |

- Host panel: URLs are listed in that order with "Encrypted" / "Not encrypted" labels. When Tailscale runs and serve is off, a row offers **Turn On https with Tailscale**. It runs nothing until the owner confirms a dialog naming the exact command (`tailscale serve --bg <port>`); the daemon then runs it, shows its output, and re-reads `tailscale serve status --json`. If it fails (Linux without `tailscale set --operator=$USER`, an older client), the dialog shows the command to run by hand. The daemon MUST NOT run `tailscale serve` without that confirmation, and **Turn Off** removes only the entry for this port (exact command fixed during implementation, verified against the installed client; never `tailscale serve reset`).
- Client: a daemon found both on the LAN and on the tailnet (same `fp`) is one entry; pairing and the saved URL use https serve, else the tailnet address. Pairing over LAN http requires the existing confirmation "I trust this network; the token is sent unencrypted." inside the pairing dialog, before the code field is enabled. The claim answer lists the host's URLs; when it contains an encrypted one the client saves that one, after checking it answers `/remote/hello` with the same fingerprint.

## 6. Firewall

| OS | What happens | Decision |
|---|---|---|
| Windows | The first time a program listens on a non-loopback address, Windows Defender Firewall asks "Allow access" for that executable (Studio: `ADF Studio.exe`, which runs the daemon with `ELECTRON_RUN_AS_NODE`; CLI: `node.exe`). The default ticks Private networks only. Allow needs an administrator; Cancel creates Block rules for the program. | Rely on the prompt. The panel says before enabling: "Windows may ask whether ADF Studio may accept connections. Choose Allow on private networks." Never add a rule (needs elevation). |
| macOS | The application firewall (off by default) asks "accept incoming network connections?" for unsigned binaries; a signed app is allowed when "Automatically allow downloaded signed software" is on. macOS 15 also asks for **Local Network** access before an app uses multicast (mDNS) or connects to LAN addresses, on both host and client. | Rely on the prompts. Studio's `Info.plist` MUST gain `NSLocalNetworkUsageDescription` and `NSBonjourServices` (`_adf-daemon._tcp`, `_adf-runtime._tcp`) via `electron-builder.yml` `mac.extendInfo`; without them the Local Network prompt cannot show and mDNS fails silently. |
| Linux | No prompt. ufw or firewalld may drop the port. | Document: `sudo ufw allow from 192.168.0.0/16 to any port 7385 proto tcp`; `sudo firewall-cmd --zone=home --add-port=7385/tcp --permanent && sudo firewall-cmd --reload`. Status shows the commands. |

Detection, no elevation, refreshed at enable and with `GET /remote-access?refresh=1`, result in `firewall`:

- Windows: `Get-NetFirewallApplicationFilter -Program <exe> | Get-NetFirewallRule` for an enabled inbound Block rule (`blocked`: "Windows Firewall blocks ADF Studio. Open Windows Security → Firewall → Allow an app, and allow ADF Studio on Private networks.").
- macOS: `socketfilterfw --getglobalstate`, `--getblockall`, `--getappblocked <exe>`.
- Linux and anything unreadable: `unknown` with the documented commands.

A host cannot test its own firewall by connecting to its own LAN address (that traffic is not filtered). The client's failure sentence for a timeout on a LAN address adds "The host's firewall may block port 7385."

## 7. What the host panel shows

Settings → Networking (Studio in `local` mode; in `embedded` or `remote` the toggle is disabled with the reason). Copy rule (owner, 2026-10-18): headings, labels, buttons and dialog titles are plain nouns or short verb phrases; at most one short sentence under a heading.

0. The tab's status line, shared with the mesh: the networks (each allowed or not), LAN address, Tailscale, firewall; "Remote access paused on <network>." with **Allow on this network** (and the Public warning, §3.3.1) for each network not allowed; then **Allowed networks**, each with **Remove**.
1. Section and toggle **Remote access**, with "A device token is as powerful as your seed phrase." and the **On quit** row (§3.6).
2. Status line under the toggle (§8): "Listening on …", "Off.", "Paused on <network>.".
3. Name: the runtime alias (settings `runtimeAlias`), else the host name; one name in mDNS, hello, pairing and device lists. **Fingerprint** `XXXX-XXXX` in the Pair device window.
4. **Addresses**: each URL with Copy and its encryption label (§5.7): Tailscale https, tailnet IP, each LAN IP, `<host>.local`; **Enable Tailscale https**.
5. **Pair device**: opens the **Pair device** window; shows the code in large digits, a countdown, attempts left; then the **Allow device** dialog.
6. **Add device** (§4.6): a token shown once, Copy, Done.
7. **Devices**: label, Paired / Token, last seen (address), Connected now, **Revoke** (dialog **Revoke device**: "*label* is disconnected now and its token stops working.").
8. Firewall row when it has something to say.

`adf daemon remote status` prints the same items as text (`--json`: the status object).

## 8. Visibility

| Event | Studio | CLI | Daemon log |
|---|---|---|---|
| On / off | Status line "Listening on 192.168.1.20, 100.101.102.103." / "Off." | `adf daemon remote on/off` prints the result; `adf daemon status` gains a `remote` line | `[remote-access] on: listening on …` / `off: closed N connections` |
| Addresses change, no address, bind failure | Status line, address rows with the problem | `remote status` | One line each |
| Pairing opened / closed (reason) | Panel; notice when closed by wrong codes | `adf daemon pair` output | Line, without the code |
| Claim pending | Modal + OS notification | Prompt | Line: address, name |
| Device added (paired or token) | Notice "Device added: *label*." | Output | Line |
| Device revoked | Notice "Device revoked: *label*." | Output | Line with counts |
| Device first connection after start, disconnect | Devices list (live); no notice | `devices list` | Line |
| Refusals (`master_token_remote`, `device_revoked`, rate limit) | — | — | Rate-limited line with count |

Studio gets them through the client push topic `remote_access`, which goes to this computer's own client sessions only: never to a session opened with a device token, and never onto the umbilical bus (`GET /events` serves device tokens, and agents' taps read it). `{type, deviceId?, label?, reason?}`, `type`: `enabled`, `disabled`, `addresses_changed`, `networks_changed` (§3.3.1), `pairing_opened`, `pairing_closed` (`reason`: `wrong_codes`, `expired`, `cancelled`, `paired`, `denied`, `disabled`), `claim_pending` (no fields: Studio reads `GET /remote-access` → `pairing.claim`, shows the **Allow device** dialog for it and answers with `POST /remote-access/pairing/claims/:claimId`), `device_added`, `device_revoked`, `device_connected`, `device_disconnected`. On `networks_changed` Studio re-reads `GET /remote-access` (a status with no allowed network has `state: 'paused'`). Event payloads MUST NOT carry tokens or codes. Studio main also writes each notice to `main.log`.

## 9. Client side

### 9.1 Studio

Settings → Backend → Remote computer gains, above the URL and token fields:

- **Discovered**: the entries with remote access of this computer's one discovery feed (§5.1), read while the section is open: the daemon's in local mode, Studio main's own otherwise. LAN (`_adf-runtime._tcp`, legacy `_adf-daemon._tcp`) and tailnet (`GET /remote/hello` in the one `TailnetDiscovery` sweep) sightings merge by fingerprint; each shows name, fingerprint, address kind (tailnet / LAN), "Pairing open" when `pairingOpen`, and "Paired" when the saved remote has that fingerprint. Studio's own browser stops when the section closes; the daemon's runs on for the mesh, remote access or a minute. The renderer never sees a token.
- **Pair** opens the **Pair** dialog: name and fingerprint of the host ("Check that the host shows the same fingerprint."), **Device name** (default: the runtime alias, else the OS host name), the plain-http confirmation when the address needs it (§5.7), **Code**, then "Waiting for *host* to allow this device…" with Cancel. On approval main saves URL and token (§9.3) and offers **Switch to This Daemon** (the existing switch dialog).
- Paste stays as it is; a pasted `adfd_` token is stored the same way.

IPC (new, Studio main): `REMOTE_DISCOVERY_START`, `REMOTE_DISCOVERY_STOP`, push `REMOTE_DISCOVERY_UPDATE {entries}`, `REMOTE_PAIR_START {url, deviceName, allowInsecureHttp}` → `{claimId}`, `REMOTE_PAIR_SUBMIT_CODE {code}`, push `REMOTE_PAIR_STATE {state, attemptsLeft?, message}`, `REMOTE_PAIR_CANCEL`. Host side: `REMOTE_ACCESS_GET`, `REMOTE_ACCESS_SET {enabled, name?}`, `REMOTE_ACCESS_DEVICE_ADD {label}` → `{device, token}`, `REMOTE_ACCESS_DEVICE_REMOVE {id}`, `REMOTE_ACCESS_PAIRING_OPEN`, `REMOTE_ACCESS_PAIRING_CLOSE`, `REMOTE_ACCESS_CLAIM_DECIDE {claimId, allow}`, `REMOTE_ACCESS_TAILSCALE_SERVE {enabled}`, push `REMOTE_ACCESS_CHANGED`. All `local`-mode channels proxied to the management routes with the master token and the local proof.

### 9.2 CLI

```text
adf pair [<host>[:<port>]] [--name <device name>] [--as <remote name>]
adf remotes                       list saved remotes; * marks the default
adf remotes use <name> | local    choose the default for adf commands and the terminal app
adf remotes forget <name>         delete the saved URL, then the token unless another name holds that computer (the host still lists the device: remove it there)
```

- Without `<host>`, `adf pair` browses mDNS for 3 s and probes tailnet peers, prints a numbered list (name, fingerprint, address, ready to pair) and asks which. With `<host>` it calls `/remote/hello` first and shows name and fingerprint.
- On plain http to a LAN address it asks "The token is sent unencrypted on this network. Continue? [y/N]" (`--yes` for scripts).
- Then "Code shown on *host*:", the claim, "Waiting for *host* to allow this computer…" (Ctrl+C cancels), and on approval: "Paired with *host* as *name*. Use it by default? [Y/n]".
- Resolution order for every command: `--url`/`--token` > `ADF_DAEMON_URL`/`ADF_DAEMON_TOKEN` > `--remote <name>` / `ADF_REMOTE` > the default remote > this machine's daemon. A default remote never auto-starts a local daemon (as any non-local URL today).

### 9.3 Token storage on the client

| Client | URL and metadata | Token |
|---|---|---|
| Studio | `studio-backend.json` `remote.url`, `remote.allowInsecureHttp`, new `remote.paired: {fingerprint, name, deviceId, label} \| null` | `remote.token` as `safe:` (safeStorage), unchanged; sent only to that origin |
| CLI | `<data dir>/cli-remotes.json` `{v: 1, default, remotes: {<name>: {url, fingerprint, deviceId, label, pairedAt}}}` | OS keychain, service `ADF`, account `remote-token:<fingerprint>` (`@napi-rs/keyring`, already a CLI dependency); without a keychain `<data dir>/cli-remote-tokens.json`, written with `writeSecretFileAtomic` (§10.1), and `adf pair` says so; both CLI files are written that way |

When a saved remote stops answering at its IP, Studio and the CLI SHOULD look the fingerprint up in mDNS and offer the new address ("*host* is now at 192.168.1.44. Use it?"); they MUST NOT switch silently.

Host pinning in the CLI (security review item 7, trust on first use):

- `adf pair` refuses an approval whose `daemon.fingerprint` differs from the fingerprint `/remote/hello` showed before the code was typed; nothing is saved, and the output names the device to remove on the host.
- A saved remote is pinned to the fingerprint it was paired with. Pairing another fingerprint under its name is refused ("forget it first"); re-pairing the same computer replaces its address or token only after the user says yes (`--yes` accepts).
- The saved URL is the one the user typed or chose. A URL the host lists replaces it only when it is `https://*.ts.net` or a 100.64/10 / `fd7a:115c:a1e0::/48` address that this computer's own Tailscale lists as a peer, answers with the same fingerprint, and the user agrees.
- Before any command sends a saved device token, `adf` asks the authenticated hello (§5.2.1) at that URL; another fingerprint, a proof that does not verify, an older ADF, or no answer as that computer refuses the command and the token is not sent. A token given with `--token` / `ADF_DAEMON_TOKEN` is not checked. The terminal app (`adf tui`) asks it again after every failed request or dropped event stream, before the token goes out again (multi-runtime.md §19).
- `adf pair` refuses a host without `helloProof` before the code is typed, and saves a pairing only after the saved address proved, with the delivered token, that it issued it.

## 10. Security review

Assets: device tokens (each = the owner phrase, §4.5), the pairing code during its window, the master token (stays on the host).

| Attacker | Can | Mitigation | Accepted |
|---|---|---|---|
| Passive sniffer on the LAN | Read every plain-http request, including the bearer token, and chat and file content | Tailnet listener (WireGuard) and `tailscale serve` (TLS) are offered first and labelled; plain LAN http needs an explicit "I trust this network" on the client | Yes, for plain LAN http the owner confirmed. Same as copy-paste today. |
| Sniffer during pairing | Read the code (single use, consumed by the legitimate claim) and the token in the poll answer | As above | Yes (the token leaks on the next request anyway, §5.6) |
| Active attacker on the LAN (ARP spoof, rogue AP) | Everything a sniffer can, plus modify traffic, impersonate host or client | Host confirmation shows source address; encrypted transports | Yes on plain http. Not defended without TLS or WireGuard. |
| Rogue mDNS responder | Announce a fake "*owner*'s PC" with `pair=1` and the real fingerprint; learn the code the user types; relay it to the real host within the window | Host prompt names the source (socket) address and arrival path, never a forwarded header; `adf` pins the fingerprint and refuses an approval from another one; the client's dialog shows the address it is talking to; one claim per window; the window is short and owner-opened | Partly: an owner who allows without reading the address is fooled. SPAKE2 would close this; deferred (§5.6, Q3). |
| LAN guesser | Guess codes; or enter wrong codes to close the owner's window | 5 wrong codes per source (then locked out), 20 per window, per-source rate limit, host confirmation | Residual 2 × 10^-5 per window, and still needs Allow; one source cannot close the window |
| LAN stranger without a code | Spam claims, probe hello | 404 without a window; rate limits; hello carries no secret | Learns name and fingerprint (also in mDNS) |
| Anything at a saved address (a reused DHCP lease, an mDNS or tailnet name taken over) | Show the saved fingerprint and receive the device token over plain http | The authenticated hello (§5.2.1): no token goes out until the address proves it holds the device's record, keyed by SHA-256 of the device secret, over a fresh nonce and the dialed origin; an older ADF is refused | An active attacker on the path who relays the hello to the real host: the plain-http risk above |
| Anyone who sends hellos with a known device id | Get proofs over nonces of its choosing | The MAC is keyed by a 256-bit secret's hash: no offline guessing; rate limit per source; the device id comes only from the token | — |
| Web page in the user's browser | CSRF / DNS rebinding to the daemon | Existing Host, Origin, `Sec-Fetch-Site` checks on every listener and route | — |
| Paired device turned hostile, or a lost laptop | Full control, run code, read the owner phrase | Revocation closes everything now; owner moves agents to a new owner if the phrase may have been read (remote-daemon.md) | Inherent in full-power tokens. It cannot see or collect other devices' pairing claims (no remote_access events, collect secret), nor reach local-only routes by any URL spelling |
| Device token holder | Mint more tokens, lock the owner out | §4.5: management and local-only routes refuse device tokens | — |
| Someone who knows the home gateway's MAC address (a former guest) clones it on their own access point, same subnet | Get a listener on a network the user allowed at home | Accepted residual risk: the network identity is the gateway MAC plus the subnet (plus the Wi-Fi name on Linux and on macOS before 14.4); a clone matches it. The clone gets a listener only; every request still needs a device token, and pairing still needs an owner-opened window and the owner's Allow. A gateway that gives no MAC after this check's ARP probe (3 tries, 200 ms apart) is never a match, whatever an earlier check saw (§3.3.1). Not covered: an OS that still lists a stale entry for the old gateway after a switch, until it expires it | Yes |
| Public / hostile Wi-Fi with private addresses (hotel 10.x) | Reach the listeners, attempt pairing | Nothing listens until the user allows that network (§3.3.1); then a token is required; pairing only in an owner-opened window; the status line names the addresses | Yes; see Q4 |
| Carrier-grade NAT peers | Reach a 100.64/10 listener | Bound only when Tailscale confirms the address | — |
| Process of the same OS user on the host | Read `daemon-token`, `daemon-devices.json`, mint via the proof | Out of scope, as in daemon-backend.md §5.4.1 | Yes |

### 10.0 Security review 2026-10-18 (FIX), daemon and CLI

| # | Finding | Fix |
|---|---|---|
| 1 | `claim_pending` carried the claim id to every session and the umbilical bus; a paired device could collect the next device's token | Collecting needs the 202's `collectSecret` (`X-ADF-Pair-Secret`, constant time); events carry no claim; `remote_access` goes to this computer's own sessions only, never to device sessions or `/events` (§5.4, §8) |
| 2 | Network categories cached 60 s by interface name: a new network inherited "private" | Category keyed on the interface's addresses and gateway, re-read on any change with that interface's listeners closed meanwhile (§3.4) |
| 3 | `X-Forwarded-For` from any local process set the prompt's address, reset the limits and reached `tailscale whois` | Socket address only; Tailscale-User-* headers only behind serve in proxy mode; whois on socket addresses only; bounded counters (§5.5) |
| 4 | Device-name filter missed U+061C, U+2028/9, zero-width characters, U+FEFF | Full set refused, whitespace collapsed, length capped (§5.4) |
| 5 | Percent-encoded paths (`/client/session%73`) slipped past the device refusal | The guard judges the matched route pattern or the decoded, normalised path (§4.5) |
| 6 | "Off" raced an address check: a listener opened after `closeAll` | Off is serialized with the checks; each listener re-checks before and after it opens (§3.2) |
| 7 | The CLI trusted the approval's fingerprint and URLs | Fingerprint must match the hello; saved remotes pinned (TOFU); URL switch only to tailnet addresses after asking; token never sent to another fingerprint (§9.3) |
| 8 | 5 wrong codes from anyone closed the owner's window | 5 per source lock that source out (owner told), 20 in total close it (§5.3) |
| 9 | Secret files written before they were restricted; failures only logged | Restricted temp file, then rename; failure fails the write visibly (§10.1) |

### 10.1 Secret files

`remote-access.json`, `daemon-devices.json`, `cli-remotes.json` and `cli-remote-tokens.json` are written by `writeSecretFileAtomic` (`src/main/utils/secret-write.ts`): the content goes into a temp file that is already readable by the current user only, then the temp file is renamed over the target. On POSIX the temp file is created exclusively with mode 0600; on Windows it is created empty, given its own ACL (`icacls /inheritance:r /grant:r <user>:F`), and only then filled. A restriction that fails MUST fail the write: nothing is written, the caller gets `SecretFileError`, the daemon answers the error (no device token is issued), and `adf pair` says the token was not saved and which device to remove on the host. Nothing reports "readable by you only" for a file that is not (security review item 9).

## 11. API (the fixed contract)

Step 0 commits `src/shared/types/remote-access.types.ts` with the shapes below and the openapi additions, before parts A and B start.

### 11.1 Types

```ts
type RemoteAccessState = 'off' | 'on' | 'paused' | 'no_address' | 'env_bind' | 'error'
interface RemoteAddress { address: string; family: 'IPv4' | 'IPv6'; kind: 'lan' | 'tailnet'; iface: string; networkId: string | null; allowed: boolean; listening: boolean; problem: string | null }
interface NetworkView { id: string | null; kind: 'lan' | 'tailnet'; label: string; allowed: boolean; osCategory: 'private' | 'public' | 'unknown'; ifaces: string[]; addresses: string[] }
interface AllowedNetwork { id: string; kind: 'lan' | 'tailnet'; label: string; addedAt: string }
interface RemoteUrl { url: string; kind: 'tailscale-https' | 'tailnet' | 'lan' | 'mdns-name'; encrypted: boolean }
interface RemoteDevice { id: string; label: string; origin: 'paired' | 'token'; createdAt: string; createdBy: 'studio' | 'cli'; lastSeenAt: string | null; lastSeenAddress: string | null; connected: boolean; connections: number; sessions: number }
interface PairingClaimView { claimId: string; deviceName: string; clientKind: 'studio' | 'cli'; address: string; via: 'lan' | 'tailnet' | 'proxy'; tailnetLogin: string | null; at: string }
interface PairingWindowView { code: string; name: string; fingerprint: string; openedAt: string; expiresAt: string; attemptsLeft: number; lockedSources: number; claim: PairingClaimView | null }
interface RemoteAccessStatus {
  enabled: boolean; state: RemoteAccessState; message: string; problem: string | null
  name: string; fingerprint: string | null; port: number
  addresses: RemoteAddress[]; urls: RemoteUrl[]; hostNames: string[]
  tailscale: { state: 'absent' | 'stopped' | 'running'; serve: 'on' | 'off' | 'unknown'; httpsUrl: string | null; serveCommand: string | null }
  mdns: { announcing: boolean; problem: string | null }
  firewall: { state: 'ok' | 'blocked' | 'unknown'; message: string; commands: string[] }
  devices: RemoteDevice[]
  pairing: PairingWindowView | null
  networks: NetworkView[]; allowedNetworks: AllowedNetwork[]; meshLan: boolean
}
interface RemoteHello { v: 1; name: string; fingerprint: string; pairingOpen: boolean; clientApiVersion: number; helloProof?: 1 }
interface RemoteHelloProved extends RemoteHello { helloProof: 1; device: 'known' | 'unknown' | 'revoked'; proof: string | null }  // ?nonce&device&origin (§5.2.1)
interface PairClaimRequest { code: string; deviceName: string; clientKind: 'studio' | 'cli' }
interface PairClaimAccepted { claimId: string; expiresAt: string; collectSecret: string }
type PairClaimResult =
  | { state: 'pending' }
  | { state: 'denied' }
  | { state: 'approved'; token: string; device: { id: string; label: string }; daemon: { name: string; fingerprint: string; urls: RemoteUrl[] } }
```

`stopsWithStudio` is not part of the daemon status: Studio computes it from `GET /version` `startedBy` and its own `keepDaemonRunning`.

### 11.2 Management routes

Master token, local caller (`requireLocalCaller`), local proof in every mode (`requireLocalProof`); a device token gets 403 `device_token_refused`.

| Method, path | Body | 2xx answer |
|---|---|---|
| `GET /remote-access[?refresh=1]` | — | 200 `RemoteAccessStatus` (`refresh` re-runs the firewall and Tailscale probes) |
| `PUT /remote-access` | `{enabled?: boolean, name?: string}` (at least one) | 200 `RemoteAccessStatus` |
| `POST /remote-access/networks` | `{id: string}` (a current `networks[].id`) | 200 `RemoteAccessStatus` |
| `DELETE /remote-access/networks/:id` | — | 200 `RemoteAccessStatus` |
| `POST /remote-access/devices` | `{label: string}` | 201 `{device: RemoteDevice, token: string}` |
| `DELETE /remote-access/devices/:id` | — | 200 `{device: RemoteDevice, closedSessions: number, closedConnections: number}` |
| `POST /remote-access/pairing` | `{}` | 201 `PairingWindowView` (replaces an open window) |
| `DELETE /remote-access/pairing` | — | 204 |
| `POST /remote-access/pairing/claims/:claimId` | `{allow: boolean}` | 200 `{state: 'approved', device: RemoteDevice} \| {state: 'denied'}` |
| `POST /remote-access/tailscale-serve` | `{enabled: boolean}` | 200 `{tailscale: RemoteAccessStatus['tailscale'], output: string}` |

### 11.3 Unauthenticated routes

Host / Origin checks apply; no bearer token; all answers `Cache-Control: no-store`.

| Method, path | Body | 2xx answer |
|---|---|---|
| `GET /remote/hello[?nonce&device&origin]` | — | 200 `RemoteHello`; with the query, `RemoteHelloProved` (§5.2.1); 400 `bad_request` for a partial query |
| `POST /pair/claim` | `PairClaimRequest` | 202 `PairClaimAccepted` |
| `GET /pair/claims/:claimId?wait=<0-25>` | header `X-ADF-Pair-Secret` = the 202's `collectSecret` | 200 `PairClaimResult` (holds up to `wait` s while pending) |

### 11.4 Error codes

Body `{error: string, code: string}` as today; `error` is the sentence clients show.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Malformed body, label or device name out of rules, code not six digits |
| 401 | `unauthorized` | Unknown or missing token (existing) |
| 401 | `device_revoked` | Token of a tombstoned device |
| 401 | `remote_access_off` | Valid device token while remote access is off |
| 401 | `master_token_remote` | Master token on a remote listener |
| 403 | `loopback_only` | Management route from a non-local caller, or without a valid local proof (existing `requireLocalCaller` / `requireLocalProof`) |
| 403 | `device_token_refused` | Device token on a local-only or management route |
| 403 | `host_not_allowed`, `cross_origin` | Existing guard |
| 403 | `wrong_code` | Wrong pairing code; body adds `attemptsLeft` |
| 404 | `remote_access_off` | `/remote/hello`, `/pair/*` while off |
| 404 | `pairing_closed` | No open window (expired, closed, never opened, locked by wrong codes) |
| 404 | `claim_not_found` | Unknown, expired or already collected claim |
| 404 | `device_not_found` | Unknown device id |
| 404 | `network_not_found` | Allowing a network this computer is not on now, or removing one that is not allowed |
| 409 | `pairing_busy` | A correct claim is already waiting for the host |
| 409 | `claim_decided` | Decision on a claim already decided |
| 409 | `env_bind` | Enable while `ADF_DAEMON_HOST` is non-loopback |
| 429 | `rate_limited` | Per-address limits; `Retry-After` header |
| 502 | `tailscale_failed` | The `tailscale` command failed; body adds `output` and `command` |
| 503 | `devices_unreadable` | `daemon-devices.json` cannot be read; no device token is accepted |

### 11.5 openapi.json

- Paths: the 8 management and 3 unauthenticated operations above, tag `Remote access`.
- Schemas: `RemoteAccessStatus`, `RemoteAddress`, `RemoteUrl`, `RemoteDevice`, `PairingWindowView`, `PairingClaimView`, `RemoteHello`, `PairClaimRequest`, `PairClaimAccepted`, `PairClaimResult`, the error codes above in the shared `Error` schema's `code` description.
- The three unauthenticated operations carry `security: []` (like `/health`).
- `bearerAuth` description: "The install's token from `<settings dir>/daemon-token` (this machine only), or a device token (`adfd_…`) from pairing or `adf daemon devices add`."
- `tests/openapi-coverage.test.ts` covers the new routes; `npm run docs:api:lint` passes.

## 12. Work plan

Parts A and B run in parallel against §11 after step 0.

| Step | Owner | Content | Difficulty |
|---|---|---|---|
| 0 | Lead | `remote-access.types.ts`, openapi additions, IPC channel names (§9.1) in the channel map with stub handlers | 2/10 |
| A1 | Daemon | `daemon-devices.json` store, `TokenVerifier` (master / device), guard decoration, `master_token_remote`, `device_token_refused` in `requireLocalCaller`, per-device socket and session tracking, revocation, tombstones, lastSeen throttle | 6/10 |
| A2 | Daemon | `remote-access.json`, `RemoteListeners` (per-address `http.Server` → `fastify.routing`), eligible-address filter, 10 s watcher, Tailscale self lookup, host names, `env_bind`, shutdown hooks, device sessions excluded from `daemon_orphan_hold` | 6/10 |
| A3 | Daemon | announcer (first `_adf-daemon._tcp`, now in `_adf-runtime._tcp`, §5.1), `/remote/hello`, pairing window, claim, long poll, rate limits, `remote_access` events, log lines | 5/10 |
| A4 | Daemon | Firewall probes (Windows PowerShell, macOS `socketfilterfw`), `tailscale serve` on/off and status, `tailscale whois` | 4/10 |
| A5 | CLI | `adf daemon remote on/off/status`, `adf daemon devices [list/add/revoke]`, `adf daemon pair`; `adf pair`, `adf remotes`, `cli-remotes.json`, keychain storage, resolution order, help text | 5/10 |
| A6 | Daemon | Tests: listener binding and address filter (fake interfaces), token matrix of §4.4 on real sockets, revocation closes SSE, pairing (expiry, 5 wrong codes, busy, deny, single delivery), rate limits, CLI flows against a spawned daemon | 5/10 |
| B1 | Studio | This computer panel (§7), claim modal and OS notification, status-bar indicator, notices, quit confirmation (§3.6), New token dialog | 5/10 |
| B2 | Studio | Main: mDNS browse + tailnet hello probe, pairing client (claim, poll, cancel), storage (`remote.paired`), relocation offer; renderer: discovered list and pairing dialog | 5/10 |
| B3 | Studio | `Info.plist` keys (§6), handler tests against a fake daemon, parity of the IPC map | 3/10 |
| C | Lead | Docs: remote-daemon.md "Option 0: Allow other computers to connect", studio-backend.md sections, daemon-backend.md §9.2 (device tokens), operations.md files list; manual checklist on Windows, macOS, Linux (firewall prompts, Local Network prompt, Wi-Fi change, sleep) | 3/10 |

Agentic duration: step 0 about 20 minutes; A about 3 hours; B about 2 hours in parallel; C and the cross-OS manual pass about 1 hour plus the owner's time on three machines. Overall 6/10: the risky parts are A1 (one guard on every route) and A2 (listeners outside Fastify's own server).

## 13. Owner decisions (2026-10-18)

The owner answered the questions of the first draft on 2026-10-18.

| # | Question | Decision |
|---|---|---|
| O1 | Restart the daemon to apply the toggle, or open listeners live? Refuse the master token from other computers? SPAKE2 for pairing? | As recommended: live listeners only, no restart (§3.2); the master token is refused on remote listeners (§4.4); SPAKE2 is deferred, `tailscale serve` (https) is the encrypted option (§5.6, §5.7). |
| O2 | Turn remote access off on networks not seen before? | (Replaced by O2 b below.) No listener on a network the OS marks Public; remote access stays on and only private and Tailscale addresses listen. Status: "Not reachable on this network (Public)." Windows uses the NetConnectionProfile category; macOS and Linux use the documented conservative rule, unsure = not private (§3.3.1). |
| O3 | Paired devices keep a Studio-started daemon alive after Studio quits? | No. Studio's quit asks every time a device is connected: "*N* computers are connected. Keep the daemon running for them, or stop it?" Nothing is remembered (§3.6). |
| O4 | Token shown once, or a standing token with Show? | Shown once at creation; only the hash is stored (§4.3, §4.6). |
| O2 b (2026-10-18) | The network rule, redefined | Never listen without the user's consent, given once per network, the same on every OS; it replaces "never on Public" (O2). The OS category, macOS/Linux heuristics and the tailnet are not consent. LAN identity: gateway MAC + subnet (+ Wi-Fi name where readable without a prompt); tailnet: its name. Consent lives in `remote-access.json` `allowedNetworks`, shared with the mesh; consent routes are local-only (§3.3.1). |

Contract changes made with these decisions (additive, against 1c2e5441): optional `enabled` in `PUT /remote-access`; event type `networks_changed`; the device-token refusal list of §4.5 spelled out per route. O2 b replaced O2's `RemoteAddress.network`, `trustNetwork`, `409 network_category_os`, `409 network_unidentified`, `firewall.state: 'public_network'` and `privateNetworks` with `RemoteAddress.networkId`/`allowed`, state `paused`, `networks`, `allowedNetworks`, `meshLan`, `POST`/`DELETE /remote-access/networks` and `404 network_not_found`.
