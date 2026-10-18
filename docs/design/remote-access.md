# Allow other computers to connect

Design for letting Studio's local daemon be reached from another computer, by copy-paste (address + token) or by LAN pairing (discovery + 6-digit code). Status: design, nothing built. Branch `feat/remote-access`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

Read with: [daemon-backend.md](daemon-backend.md) §5.3.1 (the token is equivalent to the owner phrase), §8 (lifecycle), §9 (remote mode); [remote-daemon.md](../cli/remote-daemon.md); [studio-backend.md](../guides/studio-backend.md#remote-computer).

## 1. Goal

Today (remote-daemon.md Option 2) a user who wants a second computer to reach this one sets `ADF_DAEMON_TOKEN` and `ADF_DAEMON_ALLOWED_HOSTS`, runs `adf daemon --host 0.0.0.0` in the foreground, adds a firewall rule and finds the token. Studio cannot do it at all: `buildDaemonEnv` forces `ADF_DAEMON_HOST=127.0.0.1` (`backend/daemon-process.ts:158`) and `DaemonHost.start` refuses a non-loopback bind without `ADF_DAEMON_TOKEN` (`daemon/daemon-host.ts:182`).

After this change:

- Host: Settings → Backend → This computer → **Allow other computers to connect** (or `adf daemon remote on`). A panel shows the addresses (Copy), a token for copy-paste (New token, Show, Copy), the paired computers with who is connected now, and **Pair a computer** (6-digit code).
- Client: Settings → Backend → Remote computer lists the ADF computers found on the LAN and the tailnet. Choose one, type the code shown on the host, the host confirms, done. Or paste address and token. `adf pair` does the same in the terminal.
- No environment variable, no foreground daemon, no hand-made firewall rule on Windows or macOS.

Non-goals: TLS in the daemon (§9.2 of daemon-backend.md stands); scoped (less than full) tokens; access from the internet; more than one OS user per daemon.

## 2. Decisions

| # | Decision | Section |
|---|---|---|
| R1 | Turning remote access on or off does not restart the daemon. The daemon opens extra listeners live; agents keep running. (The request said "Studio restarts its own daemon"; see Q1.) | §3.2 |
| R2 | Extra listeners bind each private LAN address (RFC 1918, IPv6 ULA) and each Tailscale address, never `0.0.0.0`, never a public address. Re-evaluated every 10 s. | §3.3, §3.4 |
| R3 | The setting lives in the daemon's settings directory (`remote-access.json`), so Studio, `adf daemon start`, auto-start and a service all apply it. No env var. | §3.1 |
| R4 | Per-device tokens, SHA-256 hashed at rest, with label, created, last seen. Revoking one closes that device's sessions and streams. | §4 |
| R5 | The install's file token (the master token) is never accepted on a remote listener. Device tokens are never accepted on local-only routes or on the remote-access management routes, from anywhere. | §4.4, §4.5 |
| R6 | "New token" creates a device token and shows it once. "Show" works only while that dialog is open. | §4.6 |
| R7 | Pairing: 6-digit code, window 120 s, 5 wrong codes close it, AND the host MUST confirm "Allow *name*?". Code alone never suffices. | §5 |
| R8 | No PAKE, no X25519 in v1. Every later request carries the bearer token in clear over http, so protecting only the claim buys nothing against a sniffer. The transport answer is Tailscale (WireGuard) and `tailscale serve` (https). | §5.6, §5.7 |
| R9 | Firewall: rely on the OS prompts (Windows, macOS); never add a rule ourselves; detect a block where it can be read without elevation and say how to fix it. Linux: documented commands. | §6 |
| R10 | Every state change is visible: a status line, the devices list, notices, the daemon log, `adf daemon remote status`. | §8 |

## 3. Host: listeners and addresses

### 3.1 Setting

File `<settings dir>/remote-access.json` (next to `daemon-token`), written with mode 0600 and `protectSecretFile`. Only the daemon writes it, through the management routes (§11.2).

| Field | Type | Content |
|---|---|---|
| `v` | number | `1`. Any other value: the daemon MUST treat remote access as off and log why. |
| `enabled` | boolean | Remote access on. |
| `name` | string | Computer name shown to other computers. Default: OS host name. 1-63 characters, no control or bidi characters. |
| `daemonId` | string | 128-bit random, base32, minted on first enable, never changed. Its display form is the fingerprint (§5.1). |
| `privateNetworks` | `{id, label, addedAt}[]` | macOS and Linux only: networks the owner marked private (§3.3.1). |
| `addresses` | string[] \| absent | Advanced (CLI only, `--address`): bind exactly these addresses instead of the automatic set. Each MUST be a private or Tailscale address (§3.3). |

Device records are a separate file (§4.3) so a corrupt device file never turns remote access on or off.

### 3.2 Listeners

- The main listener stays `127.0.0.1:<port>`, unchanged, for every mode.
- With remote access on, the daemon opens one extra `http.Server` per eligible address, on the same port (`192.168.1.20:7385`, `100.101.102.103:7385`). Binding specific addresses on the same port does not conflict with the loopback bind on Windows, macOS or Linux; a wildcard bind next to it does on Linux (EADDRINUSE) and depends on socket options elsewhere. A wildcard bind would also expose public interfaces.
- Each extra server hands its requests to the same Fastify instance through `fastify.routing(req, res)` (the public router entry used by `serverFactory`), so every hook, guard and route is shared. Each accepted socket is tagged `remoteListener = true` at `connection`; the guard reads the tag (§4.4).
- Disable, daemon stop, or an address going away: the server stops listening and destroys its sockets (`closeAllConnections`), including hijacked SSE responses, which the main server's SSE sweep does not see.
- A listener that fails to bind (EADDRINUSE, EADDRNOTAVAIL) is reported per address (`addresses[].problem`) and retried at the next check; the others keep running.
- `DaemonHost.start`'s check (non-loopback `host` needs `ADF_DAEMON_TOKEN`) stays as it is for the env path (§3.7). The extra listeners do not go through it: they accept device tokens only (§4.4), so no operator-chosen token is needed.

### 3.3 Eligible addresses

From `os.networkInterfaces()` (same API on Windows, macOS and Linux), skipping `internal`:

| Address | Bound | Reason |
|---|---|---|
| IPv4 `10/8`, `172.16/12`, `192.168/16` on a non-virtual interface | Yes | LAN |
| IPv4 `100.64/10` that `tailscale status --json` lists in `Self.TailscaleIPs` | Yes, kind `tailnet` | Tailnet. Without that confirmation the range is carrier-grade NAT (a phone hotspot, some ISPs) and MUST NOT be bound. |
| IPv6 in `fd7a:115c:a1e0::/48` listed in `Self.TailscaleIPs` | Yes, kind `tailnet` | Tailnet |
| IPv6 ULA `fc00::/7` (other) | Yes | LAN |
| IPv6 link-local `fe80::/10` | No | Needs a zone id in every URL; IPv4 or ULA covers the same LAN |
| Any other address (public IPv4, IPv6 global unicast) | No | Would be reachable from the internet where no NAT or router firewall stands in front |
| Any address on a virtual interface | No | Docker, WSL, Hyper-V, VMware, VirtualBox, VPN taps: the regexes of `mdns-service.ts` (`VIRTUAL_IFACE_RE`, `VIRTUAL_IFACE_WIN_RE`), minus the Tailscale names, which are matched by address above |

A LAN address (the first and fourth rows) gets a listener only when its network is private (§3.3.1). Tailscale addresses are never subject to that check: the tailnet authenticates its peers.

The Tailscale check reuses `TailnetDiscovery`'s binary lookup (`tailscale` on PATH, `C:\Program Files\Tailscale\tailscale.exe`, `/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale`; on macOS also `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). Interface names differ per OS (`en0`/`eth0`/`wlan0`, `Wi-Fi`/`Ethernet`, `utun4`/`tailscale0`/`Tailscale`); the decision is by address, the names only exclude virtual adapters.

#### 3.3.1 Private or public network (owner decision O2)

The daemon MUST NOT listen on a network the OS, or the rule below, does not mark private. Remote access stays on; the address is listed with `listening: false`, `network: 'public'` and the problem "Not reachable on this network (Public)." When no address listens for that reason the status is `no_address` with the same sentence.

| OS | Rule |
|---|---|
| Windows | `Get-NetConnectionProfile` (no elevation): `NetworkCategory` `Private` or `DomainAuthenticated` → private; `Public`, an interface without a profile, or a failed or timed-out query → public. Matched by `InterfaceAlias` = the `os.networkInterfaces()` name. Re-read every 60 s and on every address change. |
| macOS, Linux | No OS category exists, so the daemon keeps its own list of private networks (`privateNetworks` in `remote-access.json`). A network is identified by the interface's default gateway: `sha256("<gateway IP>\|<gateway MAC>")`, first 16 hex characters, label `<interface> via <gateway IP>`. Gateway: macOS `netstat -rn -f inet` (`default` rows), Linux `/proc/net/route`. MAC: macOS `arp -an`, Linux `/proc/net/arp`. The networks of the current LAN interfaces are added when remote access is turned on (off → on) and by `PUT /remote-access {trustNetwork: true}` (Studio **Allow on This Network**, `adf daemon remote trust`); `trustNetwork: false` removes them (`adf daemon remote untrust`). Each change is logged and shown. No default gateway on the interface, no MAC for it, a failed command, or a network not in the list → public. |

Rationale for macOS and Linux: neither OS records whether a network is trusted, and nothing in the network itself tells a home from a hotel. The only signal that is not a guess is the owner's own choice on that network; a gateway's MAC address changes with the network, so a hotel never matches home. A spoofed gateway MAC only gets an attacker a listener that still requires a device token.

### 3.4 Network changes

Node has no portable interface-change event. While remote access is on, the daemon re-reads `os.networkInterfaces()` every 10 s (and `tailscale status --json` every 60 s and whenever a 100.64/10 address appears or goes). On a difference it MUST:

1. open listeners for new addresses and close those for vanished ones (§3.2);
2. recompute the allowed host names (§3.5) and the URLs (§7);
3. re-announce mDNS on the current interface (§5.1);
4. log one line naming added and removed addresses, and emit `remote_access` event `addresses_changed`.

With no eligible address the state is `no_address` ("No private network address now; other computers cannot reach this computer."). The setting stays on and listeners return with the network.

### 3.5 Host names

The daemon adds to its Host allow-list, for every listener: the OS host name, `<host name>.local`, and, when Tailscale runs, `Self.DNSName` (the MagicDNS FQDN, trailing dot removed) and its first label. They are merged with `ADF_DAEMON_ALLOWED_HOSTS` (env entries are kept). IP literals on the bound port are already accepted for non-loopback binds (`ipLiteralPort`, request-guard.ts). The list is in the status (`hostNames`).

### 3.6 Lifecycle and keep-running

Remote access works only while this daemon runs.

- The setting is applied at every daemon boot, whoever starts it (Studio, `adf`, `adf daemon start`, a service). A daemon started with remote access on logs `[remote-access] on: listening on <addresses>`.
- Studio-started daemon with **Keep the daemon running** off: quitting Studio stops the daemon and every remote client loses it. The remote-access panel MUST say so next to the toggle ("Other computers lose the connection when Studio quits.") with a button **Keep Running When Studio Quits** that sets `keepDaemonRunning`. Studio MUST NOT change `keepDaemonRunning` by itself.
- Sessions opened with a device token MUST NOT hold a Studio-requested stop (`daemon_orphan_hold`, §8.3 of daemon-backend.md). Otherwise any paired laptop would keep this computer's daemon running indefinitely after the owner quit Studio.
- Instead, Studio's quit MUST ask, every time a device is connected and the daemon would stop: "*N* computers are connected. Keep the daemon running for them, or stop it?" **Keep Running**, **Stop**, **Cancel**. The answer applies to this quit only: nothing is remembered and `keepDaemonRunning` is not changed (owner decision O3).
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

`<settings dir>/daemon-devices.json`, mode 0600, `protectSecretFile` on every write, written atomically (temp + rename).

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

- every route `isLocalOnlyRoute` lists (owner create / restore / import / unlock / lock / confirm-backup, trust-daemon, untrust-daemon, value reveal, provider key reveal, shutdown, credential reload, `GET /client/sessions`), except the three client-session routes whose handlers decide per request: `POST /client/sessions`, `POST /client/sessions/:id/quit`, `PUT /client/sessions/:id/exit-when-closed` (a remote Studio opens and quits its session; `exitDaemonWhenClosed` and `stopDaemon` still refuse a device token through `requireLocalCaller`). Code: `isDeviceRefusedRoute` (local-access.ts);
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

### 5.1 mDNS announcement

While remote access is on, the daemon announces `_adf-daemon._tcp` with `bonjour-service`, on the interface `pickMdnsInterface` chooses (`ADF_MDNS_INTERFACE` overrides), separate from the mesh's `_adf-runtime._tcp`.

| Item | Value |
|---|---|
| Instance name | `name` (§3.1). A collision gets bonjour's ` (2)` suffix; clients identify by `fp`, not by name. |
| Port | The daemon port |
| Host | `<host name>.local` (`ensureLocalSuffix`) |
| TXT `v` | `1` |
| TXT `fp` | Fingerprint: first 40 bits of `sha256(daemonId)`, base32, as `XXXX-XXXX` |
| TXT `pair` | `1` while a pairing window is open, else `0` (`Service.updateTxt`) |
| TXT `api` | `CLIENT_API_VERSION` |

The announcement MUST NOT carry a token, a code, a claim id, the runtime DID, the owner DID, a path or a user name. The fingerprint is a label that tells the owner's computers apart and dedups LAN and tailnet entries; it is not authenticated (anyone can copy it, §10).

### 5.2 Hello

`GET /remote/hello`, no token, on every listener while remote access is on: `{v: 1, name, fingerprint, pairingOpen, clientApiVersion}`. Same content as the announcement. It serves clients that cannot hear mDNS: a tailnet peer (multicast does not cross WireGuard), a typed address. Rate limit: 30 per minute per source address.

### 5.3 Pairing window

Opened by **Pair a computer** in Studio or `adf daemon pair` (`POST /remote-access/pairing`).

- Code: `crypto.randomInt(0, 1_000_000)`, six digits zero-padded, shown on the host only (panel, CLI). Never logged, never in an event payload, never announced.
- Lifetime 120 s from opening. Opening again replaces the window with a new code.
- 5 wrong codes in total (across all source addresses) close the window ("Pairing closed after 5 wrong codes."). The owner opens a new one by hand; nothing reopens by itself.
- One correct claim moves the window to `claim_pending`; further claims get 409 `pairing_busy`. The window closes when the host decides or when it expires, whichever is first.
- Closing (**Cancel**, Ctrl+C in `adf daemon pair`, expiry, remote access off, daemon stop) discards the code and any pending claim.

### 5.4 Claim, host confirmation, delivery

```text
client                                   host daemon                         host UI (Studio / adf daemon pair)
  POST /pair/claim {code, deviceName, clientKind}
                      ── code ok ──▶ claim pending ── event claim_pending ──▶ "Allow agent-2 laptop?"
  ◀── 202 {claimId, expiresAt}
  GET /pair/claims/:claimId?wait=25  (long poll, repeated)
                                                    ◀── POST /remote-access/pairing/claims/:claimId {allow}
  ◀── {state: approved, token, device, daemon}   (delivered once, then the claim is deleted)
```

- `deviceName`: 1-64 characters, control and bidi characters refused (400), trimmed. It becomes the device label.
- `claimId`: 128-bit random, known only to the claimant; it is the capability to collect the token.
- Host confirmation is REQUIRED in addition to the code. The prompt shows: device name, source address, how it arrived (`lan`, `tailnet`, `proxy`), the client kind, and, on a tailnet, the peer's Tailscale login from `tailscale whois <addr>` when available. Text: "Allow *agent-2 laptop* (192.168.1.31, this network) to control this computer's ADF daemon? It gets the same power as your seed phrase." Buttons **Allow** / **Deny**. Studio shows it as a modal in the window and, when the window is not focused, an OS notification that opens it. `adf daemon pair` prompts `Allow …? [y/N]`. The first decision from any local client wins.
- Why both: the code proves the person at the client sees the host's screen, so a stranger on the LAN cannot spam "Allow?" prompts under a plausible name; the confirmation proves the owner consents and lets them check the address, which is the only defence against a relayed code (§10).
- Approval creates the device record (`origin: 'paired'`) before the token is released. The token is returned once, to the first poll after approval, with `Cache-Control: no-store`; the claim is then deleted. A token never collected (client gone) leaves a device the owner sees in the list with "Never connected" and can revoke.
- Denial: poll answers `{state: 'denied'}`; the client says "*host* did not allow this computer."

### 5.5 Brute force and abuse

| Control | Value |
|---|---|
| Code space | 10^6; 5 guesses per window, so 5 × 10^-6 per window an owner opens |
| Per source address | 1 claim per 2 s, 10 per 10 minutes; over that: 429 `rate_limited` with `Retry-After` |
| Wrong code | 403 `wrong_code` with `attemptsLeft`, answered after a fixed 1 s delay |
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

- Windows: `Get-NetFirewallApplicationFilter -Program <exe> | Get-NetFirewallRule` for an enabled inbound Block rule (`blocked`: "Windows Firewall blocks ADF Studio. Open Windows Security → Firewall → Allow an app, and allow ADF Studio on Private networks."), and `Get-NetConnectionProfile` for a Public profile on a bound interface ("Windows treats this network as Public; the firewall blocks other computers unless you allowed Public networks.").
- macOS: `socketfilterfw --getglobalstate`, `--getblockall`, `--getappblocked <exe>`.
- Linux and anything unreadable: `unknown` with the documented commands.

A host cannot test its own firewall by connecting to its own LAN address (that traffic is not filtered). The client's failure sentence for a timeout on a LAN address adds "The host's firewall may block port 7385."

## 7. What the host panel shows

Settings → Backend → This computer (Studio in `local` mode; in `embedded` or `remote` the toggle is disabled with the reason):

1. Toggle **Allow other computers to connect**, with the sentence "Other computers you pair or give a token get full control of this computer's agents and the same power as your seed phrase." and the keep-running line (§3.6).
2. Status line (§8).
3. **Name** (editable), **Fingerprint** `XXXX-XXXX`.
4. **Addresses**: each URL with Copy and its encryption label (§5.7): Tailscale https, tailnet IP, each LAN IP, `<host>.local`. The automatic host names are under Details.
5. **Pair a computer**: opens the window; shows the code in large digits, a countdown, attempts left; then the Allow / Deny prompt.
6. **Token for copy-paste**: **New token** (§4.6).
7. **Computers**: label, paired / token, created, last seen (address), Connected now, **Remove** (confirm: "Remove *label*? It is disconnected now and its token stops working.").
8. Firewall and Tailscale rows when they have something to say.

`adf daemon remote status` prints the same items as text (`--json`: the status object).

## 8. Visibility

| Event | Studio | CLI | Daemon log |
|---|---|---|---|
| On / off | Status line "Reachable from other computers at 192.168.1.20, 100.101.102.103" / "Not reachable from other computers"; a status-bar indicator while on | `adf daemon remote on/off` prints the result; `adf daemon status` gains a `remote` line | `[remote-access] on: listening on …` / `off: closed N connections` |
| Addresses change, no address, bind failure | Status line, address rows with the problem | `remote status` | One line each |
| Pairing opened / closed (reason) | Panel; notice when closed by wrong codes | `adf daemon pair` output | Line, without the code |
| Claim pending | Modal + OS notification | Prompt | Line: address, name |
| Device added (paired or token) | Notice "*label* can now connect to this computer." | Output | Line |
| Device revoked | Notice "*label* was removed and disconnected." | Output | Line with counts |
| Device first connection after start, disconnect | Devices list (live); no notice | `devices list` | Line |
| Refusals (`master_token_remote`, `device_revoked`, rate limit) | — | — | Rate-limited line with count |

Studio gets them through the client push topic `remote_access` and the daemon event bus (umbilical `daemon.remote_access`): `{type, deviceId?, label?, claimId?, reason?}`, `type`: `enabled`, `disabled`, `addresses_changed`, `networks_changed` (§3.3.1), `pairing_opened`, `pairing_closed` (`reason`: `wrong_codes`, `expired`, `cancelled`, `paired`, `denied`, `disabled`), `claim_pending` (`claimId`, `label` = the device name; Studio shows "Allow *label*?" and answers with `POST /remote-access/pairing/claims/:claimId`), `device_added`, `device_revoked`, `device_connected`, `device_disconnected`. A status whose LAN addresses are all on non-private networks reports `firewall.state: 'public_network'` on every OS; it then re-reads `GET /remote-access`. Event payloads MUST NOT carry tokens or codes. Studio main also writes each notice to `main.log`.

## 9. Client side

### 9.1 Studio

Settings → Backend → Remote computer gains, above the URL and token fields:

- **Computers on this network**: Studio main browses `_adf-daemon._tcp` while the section is open, and, when Tailscale runs, probes `GET /remote/hello` on each online tailnet peer on port 7385 (the `TailnetDiscovery` sweep, 2.5 s timeout). Entries merge by fingerprint; each shows name, fingerprint, address kind (tailnet / LAN), "Ready to pair" when `pairingOpen`, and "Already paired" when the saved remote has that fingerprint. Browsing stops when the section closes. The renderer never sees a token.
- **Pair…** opens the dialog: name and fingerprint of the host ("Check that the host shows the same fingerprint."), this computer's device name (default: OS host name), the plain-http confirmation when the address needs it (§5.7), the 6-digit field, then "Waiting for *host* to allow this computer…" with Cancel. On approval main saves URL and token (§9.3) and offers **Switch to This Daemon** (the existing switch dialog).
- Paste stays as it is; a pasted `adfd_` token is stored the same way.

IPC (new, Studio main): `REMOTE_DISCOVERY_START`, `REMOTE_DISCOVERY_STOP`, push `REMOTE_DISCOVERY_UPDATE {entries}`, `REMOTE_PAIR_START {url, deviceName, allowInsecureHttp}` → `{claimId}`, `REMOTE_PAIR_SUBMIT_CODE {code}`, push `REMOTE_PAIR_STATE {state, attemptsLeft?, message}`, `REMOTE_PAIR_CANCEL`. Host side: `REMOTE_ACCESS_GET`, `REMOTE_ACCESS_SET {enabled, name?}`, `REMOTE_ACCESS_DEVICE_ADD {label}` → `{device, token}`, `REMOTE_ACCESS_DEVICE_REMOVE {id}`, `REMOTE_ACCESS_PAIRING_OPEN`, `REMOTE_ACCESS_PAIRING_CLOSE`, `REMOTE_ACCESS_CLAIM_DECIDE {claimId, allow}`, `REMOTE_ACCESS_TAILSCALE_SERVE {enabled}`, push `REMOTE_ACCESS_CHANGED`. All `local`-mode channels proxied to the management routes with the master token and the local proof.

### 9.2 CLI

```text
adf pair [<host>[:<port>]] [--name <device name>] [--as <remote name>]
adf remotes                       list saved remotes; * marks the default
adf remotes use <name> | local    choose the default for adf commands and the terminal app
adf remotes forget <name>         delete the saved URL and token (the host still lists the device: remove it there)
```

- Without `<host>`, `adf pair` browses mDNS for 3 s and probes tailnet peers, prints a numbered list (name, fingerprint, address, ready to pair) and asks which. With `<host>` it calls `/remote/hello` first and shows name and fingerprint.
- On plain http to a LAN address it asks "The token is sent unencrypted on this network. Continue? [y/N]" (`--yes` for scripts).
- Then "Code shown on *host*:", the claim, "Waiting for *host* to allow this computer…" (Ctrl+C cancels), and on approval: "Paired with *host* as *name*. Use it by default? [Y/n]".
- Resolution order for every command: `--url`/`--token` > `ADF_DAEMON_URL`/`ADF_DAEMON_TOKEN` > `--remote <name>` / `ADF_REMOTE` > the default remote > this machine's daemon. A default remote never auto-starts a local daemon (as any non-local URL today).

### 9.3 Token storage on the client

| Client | URL and metadata | Token |
|---|---|---|
| Studio | `studio-backend.json` `remote.url`, `remote.allowInsecureHttp`, new `remote.paired: {fingerprint, name, deviceId, label} \| null` | `remote.token` as `safe:` (safeStorage), unchanged; sent only to that origin |
| CLI | `<data dir>/cli-remotes.json` `{v: 1, default, remotes: {<name>: {url, fingerprint, deviceId, label, pairedAt}}}` | OS keychain, service `ADF`, account `remote-token:<fingerprint>` (`@napi-rs/keyring`, already a CLI dependency); without a keychain `<data dir>/cli-remote-tokens.json`, 0600 / own ACL, and `adf pair` says so |

When a saved remote stops answering at its IP, Studio and the CLI SHOULD look the fingerprint up in mDNS and offer the new address ("*host* is now at 192.168.1.44. Use it?"); they MUST NOT switch silently.

## 10. Security review

Assets: device tokens (each = the owner phrase, §4.5), the pairing code during its window, the master token (stays on the host).

| Attacker | Can | Mitigation | Accepted |
|---|---|---|---|
| Passive sniffer on the LAN | Read every plain-http request, including the bearer token, and chat and file content | Tailnet listener (WireGuard) and `tailscale serve` (TLS) are offered first and labelled; plain LAN http needs an explicit "I trust this network" on the client | Yes, for plain LAN http the owner confirmed. Same as copy-paste today. |
| Sniffer during pairing | Read the code (single use, consumed by the legitimate claim) and the token in the poll answer | As above | Yes (the token leaks on the next request anyway, §5.6) |
| Active attacker on the LAN (ARP spoof, rogue AP) | Everything a sniffer can, plus modify traffic, impersonate host or client | Host confirmation shows source address; encrypted transports | Yes on plain http. Not defended without TLS or WireGuard. |
| Rogue mDNS responder | Announce a fake "*owner*'s PC" with `pair=1` and the real fingerprint; learn the code the user types; relay it to the real host within the window | Host prompt names the source address and arrival path; the client's dialog shows the address it is talking to; one claim per window; the window is short and owner-opened | Partly: an owner who allows without reading the address is fooled. SPAKE2 would close this; deferred (§5.6, Q3). |
| LAN guesser | Guess codes | 5 guesses per owner-opened window, per-address rate limit, host confirmation | Residual 5 × 10^-6 per window, and still needs Allow |
| LAN stranger without a code | Spam claims, probe hello | 404 without a window; rate limits; hello carries no secret | Learns name and fingerprint (also in mDNS) |
| Web page in the user's browser | CSRF / DNS rebinding to the daemon | Existing Host, Origin, `Sec-Fetch-Site` checks on every listener and route | — |
| Paired device turned hostile, or a lost laptop | Full control, run code, read the owner phrase | Revocation closes everything now; owner moves agents to a new owner if the phrase may have been read (remote-daemon.md) | Inherent in full-power tokens |
| Device token holder | Mint more tokens, lock the owner out | §4.5: management and local-only routes refuse device tokens | — |
| Public / hostile Wi-Fi with private addresses (hotel 10.x) | Reach the listeners, attempt pairing | Token required; pairing only in an owner-opened window; Windows' Public profile usually blocks; the status line names the addresses | Yes; see Q4 |
| Carrier-grade NAT peers | Reach a 100.64/10 listener | Bound only when Tailscale confirms the address | — |
| Process of the same OS user on the host | Read `daemon-token`, `daemon-devices.json`, mint via the proof | Out of scope, as in daemon-backend.md §5.4.1 | Yes |

## 11. API (the fixed contract)

Step 0 commits `src/shared/types/remote-access.types.ts` with the shapes below and the openapi additions, before parts A and B start.

### 11.1 Types

```ts
type RemoteAccessState = 'off' | 'on' | 'no_address' | 'env_bind' | 'error'
interface RemoteAddress { address: string; family: 'IPv4' | 'IPv6'; kind: 'lan' | 'tailnet'; iface: string; network: 'private' | 'public' | 'tailnet'; listening: boolean; problem: string | null }
interface RemoteUrl { url: string; kind: 'tailscale-https' | 'tailnet' | 'lan' | 'mdns-name'; encrypted: boolean }
interface RemoteDevice { id: string; label: string; origin: 'paired' | 'token'; createdAt: string; createdBy: 'studio' | 'cli'; lastSeenAt: string | null; lastSeenAddress: string | null; connected: boolean; connections: number; sessions: number }
interface PairingClaimView { claimId: string; deviceName: string; clientKind: 'studio' | 'cli'; address: string; via: 'lan' | 'tailnet' | 'proxy'; tailnetLogin: string | null; at: string }
interface PairingWindowView { code: string; name: string; fingerprint: string; openedAt: string; expiresAt: string; attemptsLeft: number; claim: PairingClaimView | null }
interface RemoteAccessStatus {
  enabled: boolean; state: RemoteAccessState; message: string; problem: string | null
  name: string; fingerprint: string | null; port: number
  addresses: RemoteAddress[]; urls: RemoteUrl[]; hostNames: string[]
  tailscale: { state: 'absent' | 'stopped' | 'running'; serve: 'on' | 'off' | 'unknown'; httpsUrl: string | null; serveCommand: string | null }
  mdns: { announcing: boolean; problem: string | null }
  firewall: { state: 'ok' | 'blocked' | 'public_network' | 'unknown'; message: string; commands: string[] }
  devices: RemoteDevice[]
  pairing: PairingWindowView | null
}
interface RemoteHello { v: 1; name: string; fingerprint: string; pairingOpen: boolean; clientApiVersion: number }
interface PairClaimRequest { code: string; deviceName: string; clientKind: 'studio' | 'cli' }
interface PairClaimAccepted { claimId: string; expiresAt: string }
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
| `PUT /remote-access` | `{enabled?: boolean, name?: string, trustNetwork?: boolean}` (at least one) | 200 `RemoteAccessStatus` |
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
| `GET /remote/hello` | — | 200 `RemoteHello` |
| `POST /pair/claim` | `PairClaimRequest` | 202 `PairClaimAccepted` |
| `GET /pair/claims/:claimId?wait=<0-25>` | — | 200 `PairClaimResult` (holds up to `wait` s while pending) |

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
| 409 | `pairing_busy` | A correct claim is already waiting for the host |
| 409 | `claim_decided` | Decision on a claim already decided |
| 409 | `env_bind` | Enable while `ADF_DAEMON_HOST` is non-loopback |
| 409 | `network_category_os` | `trustNetwork` on Windows, where the OS network category decides (§3.3.1) |
| 409 | `network_unidentified` | `trustNetwork: true` where no network with a default gateway and a known gateway MAC is found |
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
| A3 | Daemon | `_adf-daemon._tcp` announcer, `/remote/hello`, pairing window, claim, long poll, rate limits, `remote_access` events, log lines | 5/10 |
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
| O2 | Turn remote access off on networks not seen before? | No listener on a network the OS marks Public; remote access stays on and only private and Tailscale addresses listen. Status: "Not reachable on this network (Public)." Windows uses the NetConnectionProfile category; macOS and Linux use the documented conservative rule, unsure = not private (§3.3.1). |
| O3 | Paired devices keep a Studio-started daemon alive after Studio quits? | No. Studio's quit asks every time a device is connected: "*N* computers are connected. Keep the daemon running for them, or stop it?" Nothing is remembered (§3.6). |
| O4 | Token shown once, or a standing token with Show? | Shown once at creation; only the hash is stored (§4.3, §4.6). |

Contract changes made with these decisions (additive, against 1c2e5441): `RemoteAddress.network`; `PUT /remote-access` body `trustNetwork` and optional `enabled`; errors `409 network_category_os` and `409 network_unidentified`; `remote-access.json` `privateNetworks`; event type `networks_changed`; the device-token refusal list of §4.5 spelled out per route.
