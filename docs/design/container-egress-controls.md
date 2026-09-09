# Container egress controls (planned)

Status: **planned / not yet implemented.** This note captures the design and the
investigation behind it so the work isn't lost. Do not treat any of this as shipped.

## Why

Compute containers (`compute_exec`, container-run MCP servers, the playwright browser)
run with `--network=bridge` and no egress controls — the code comment in
`podman.service.ts` even says *"network access is the job, not the risk."* So an agent
with container access can reach the network directly, bypassing the `sys_fetch` /
`ws_connect` SSRF guard that protects the loop/sandbox. We want per-container egress
policy the owner controls.

## What already protects us (so this is defense-in-depth, not an open hole)

- **The daemon control API (127.0.0.1:7385) is already safe.** It binds loopback by
  default and *refuses* to bind a non-loopback interface without `ADF_DAEMON_TOKEN`
  (`daemon-host.ts`). Empirically, a host **loopback**-bound service is not reachable
  from a bridge container on the tested Windows/WSL rootful-podman setup
  (`host.containers.internal` → `169.254.1.2` link-local; bridge gw `10.88.0.1`; both
  connection-refused to a `127.0.0.1` listener).
- **Mesh visibility tiers are now enforced on every mesh route** (shipped in #56 — was
  previously only on `/inbox`). A `localhost`/`directory`-tier agent is now off-box
  invisible, so a container/LAN peer can't reach non-public agent endpoints.

The remaining exposures are cross-platform: **cloud metadata `169.254.169.254`** on
cloud-Linux (bridge NATs link-local straight out) and any host service bound to
`0.0.0.0`. Those are what an egress policy would close by default.

## Proposed model

`ComputeConfig` gains:

- `network: 'open' | 'guarded' | 'allowlist' | 'airgap'` (default **guarded**)
- `allowed_hosts?: string[]` (for `allowlist`)

Modes:

| Mode | Behavior |
|---|---|
| `open` | Current behavior — unrestricted bridge egress. |
| `guarded` (default) | Internet + LAN + agent/mesh endpoints allowed; **block cloud metadata (169.254.0.0/16) and the host-gateway/daemon path**. |
| `allowlist` | Deny all egress except a user-specified set of hosts/domains (needs DNS-aware filtering). |
| `airgap` | `--network=none`, no network at all. |

- **adf-mcp shared container**: default to `guarded` (it may legitimately need internet;
  only the control-plane/metadata paths are blocked).
- **Air-gap ↔ browser**: `--network=none` is incompatible with the noVNC `-p` publish and
  the browser needs network, so `airgap` disables the browser stack for that container.
- **Apply on existing + new containers**: changing the mode requires a container restart;
  surface this in the UI.

## Enforcement mechanism (needs finalizing via the podman spike)

Candidates evaluated: `--network=none` (airgap — trivial); in-container firewall
(`ip route add unreachable …` / nft, needs CAP_NET_ADMIN + tooling in the image); a
custom podman network with restricted routes; `--add-host host.containers.internal:127.0.0.1`
to neuter the named host path; a host-side filtering proxy forced via `HTTP_PROXY`
(likely required for DNS-name allowlisting). The spike was to pick the reliable
per-mode mechanism on the actual rootful-bridge setup before implementation.

## Integration points

- `src/shared/types/adf-v02.types.ts` + `src/main/adf/adf-schema.ts` — `ComputeConfig`.
- `src/main/services/podman.service.ts` — the three `--network=bridge` run-arg sites
  (`ensureContainerRunning`, `spawnImageProcess`).
- `src/renderer/components/agent/AgentConfig.tsx` — Compute settings UI + restart flow.
- `docs/guides/compute.md` — document the modes.

## Risks / breakage watch

adf-mcp and MCP servers that legitimately need host access; the browser stack under
airgap; cross-platform differences (rootful Windows/WSL vs. Linux cloud bridge vs.
macOS). Ship `guarded` conservatively and validate on each platform.
