# Tailnet Peer Discovery — friends' hubs in your landscape

**Status: draft for review — not implemented.**

Goal: a friend joins your tailnet → their runtime's base station appears on
your Age of Agents map (and yours on theirs), with agent tiles and full
message routing — exactly like a same-LAN peer.

## Why mDNS can't do it

Discovery today is multicast DNS-SD on the local broadcast domain. Tailscale
(WireGuard) is a routed overlay: **multicast does not traverse it**, so two
machines on different physical networks never see each other's
announcements, even though they can reach each other's mesh servers
perfectly well (and, since the CGNAT→lan fix, with full `lan`-tier
visibility).

## Design: three discovery sources, one peer table

`MdnsService.discovered` becomes a peer table fed by three sources, each
tagged on the entry (`source: 'mdns' | 'manual' | 'tailnet'`):

1. **mDNS** — unchanged, same-broadcast-domain peers.
2. **Manual peers** — a Settings list of `host:port` entries ("Add peer").
   Works for any reachable runtime: tailnet names (`macbook-pro.tail…​.ts.net`),
   static IPs, port-forwards. Polled with the existing health check.
3. **Tailnet sweep** (the feature): when Tailscale is detected, enumerate
   tailnet machines and probe each for an ADF runtime.

### Tailnet enumeration

Preferred: the **local Tailscale daemon API** — `tailscale status --json`
(CLI, works on macOS/Windows/Linux) or the LocalAPI socket. Both list every
peer machine with its 100.x address, hostname, and online state. No OAuth,
no admin keys — it reads the machine's own view of the tailnet.

Sweep loop (only when `tailscale` is on PATH or the LocalAPI socket exists):
- every 60s: `tailscale status --json` → online peers' addresses
- for each address not already in the peer table: `GET http://<addr>:7295/mesh/ping`
  (2s timeout, one in-flight probe per addr, backoff 10min on refusal)
- a runtime answers with `{ runtime_id, runtime_did?, proto }` → insert into
  the peer table as `source: 'tailnet'`, url `http://<addr>:7295`
- disappearance from tailscale status → expire the entry (same TTL logic as
  mDNS down events)

`/mesh/ping` may need adding if the server has no cheap identity endpoint —
`GET /mesh/directory` works today but is heavier; a ping route returning the
TXT-equivalent fields is one small handler.

**Port assumption:** probe the default mesh port (7295) plus the local
runtime's own configured port if different. Non-standard ports on peers fall
back to the manual list.

### What lights up automatically

Everything downstream already keys off the peer table: the map's peer
station (with per-agent tiles via the directory fetch), agent_discover
scope "all", message delivery, and the Settings "Discovered" list — which
gains a small source badge (`mDNS` / `tailnet` / `manual`).

## Security posture

- Reachability is already gated: tailnet sources classify `lan`
  (100.64/10 branch), so only `lan`/`public`-tier agents are visible —
  same as a physical LAN peer.
- The sweep only *probes* machines Tailscale itself says are yours/shared;
  no broadcast, no scanning beyond the tailnet peer list.
- A friend's hub appearing means: they run ADF, their mesh server is
  LAN-bound, and their agents opted into `lan` visibility. All three are
  deliberate acts.

## Difficulty: 5/10

Main-process only. The sweep service (~150 lines), a ping route, peer-table
source tagging, and the Settings manual-peer list + badges. No renderer map
changes needed beyond what already ships.

## Open questions

1. Should tailnet peers be **on by default** or behind a Settings toggle
   ("Discover peers over Tailscale")? Proposal: on by default — enrollment
   is consent — with the toggle available.
2. Manual peers: persist per-app (settings) — any need for per-agent scoping?
   Proposal: no, discovery is runtime-level.
3. Probe cadence vs. battery on laptops: 60s sweep of a large tailnet is
   cheap (one status call + a handful of pings), but back off when the
   window is hidden?
