# MCP Credential Files in the Agent Identity Keystore

**Status**: Implemented (Phases A+B+C) · **Difficulty**: 7/10 overall (Phase A: 3, Phase B: 5, Phase C: +2)
**Depends on**: ADF_IDENTITY_SPEC_v0.1 (implemented, schema v24), containerized auth preflight (2026-08-24)

## 1. Motivation

An agent's OAuth grants currently live wherever the MCP server process happened to write them — the container filesystem for containerized servers (`/root/.config/google-drive-mcp/tokens.json`), the host home dir for host-routed ones. The `.adf` file is supposed to *be* the agent, but its most operationally valuable credentials are not in it:

- **Move the .adf to another machine** → every OAuth grant is silently lost; the principal redoes every consent flow.
- **Container rebuild** (the documented clean-slate recovery) → same loss on the same machine.
- **Shared container** (`adf-mcp`) → worse than loss: `/root/.config/...` is *container*-scoped, not *agent*-scoped. Two agents using the same Drive server share and clobber one token file.
- **Prerequisite files** (`gcp-oauth.keys.json`) must be hand-copied into the container (`docs/guides/mcp-integration.md:174`) and die with it.

Meanwhile the identity keystore already solves exactly this problem for *env-var* credentials: `mcp:<ns>:<key>` rows in `adf_identity`, sealed in the `credentials` envelope (envelope-crypto routes every non-`crypto:` purpose there automatically — `envelope-crypto.ts:231-235`), resolved at connect time by `resolveMcpEnvVars` (`mcp-spawn-utils.ts:234`), redacted in `sys_get_config`. This spec extends that pipeline to *file-shaped* credentials.

## 2. Current state (verified anchors)

| Fact | Anchor |
|---|---|
| `adf_identity(purpose PK, value BLOB, encryption_algo, salt, kdf_params, code_access)` — no size cap | `adf-database.ts:259-266` |
| `setIdentity(purpose, value, codeAccess=false)` seals via cached `credentials`-envelope DEK; **silently degrades to plaintext when no DEK cached** | `adf-workspace.ts:220-230`, hazard noted `:544` |
| Env-cred namespace drift: `mcp_install` writes `mcp:<serverName>:<key>`; `resolveMcpEnvVars` reads `mcp:<pkg>:<key>` **then** `mcp:<name>:<key>` | `mcp-install.tool.ts:186-195`, `mcp-spawn-utils.ts:243-246` |
| D6: `credentials` envelope covers "everything else: `set_identity` rows, `mcp:*`, provider keys" | ADF_IDENTITY_SPEC §3 D6 (`:81-86`) |
| D12: password-share of the credentials envelope **transfers the enclosed keys** — "revocation = rotate them upstream" | ADF_IDENTITY_SPEC §3 D12 (`:151`), §7 threat table |
| D13: envelope rows readable by code only while the envelope is unlocked; identity-envelope rows never | ADF_IDENTITY_SPEC §3 D13 (`:158`) |
| Daemon never calls `setWorkspaceIdentityHooks` (only `ipc/index.ts:1151`), so `env:credentials` rows decrypt to `null` in the daemon today | `identity-provisioner.ts:25`, `daemon/index.ts` |
| Container write plumbing exists: `copyToContainer` (`:919`), `stageBytes` (`:943`, currently unreferenced), `copyFromContainer` (`:934`), `execInContainer` (`:1532`) | `podman.service.ts` |
| `PodmanStdioTransport.buildExecArgs` passes env as `-e K=V` argv (host-visible in process listings) | `podman-stdio-transport.ts:290-324` |
| Zod `McpServerConfigSchema` strips undeclared fields (types and zod must move in lockstep) | `adf-schema.ts:535-572`, `assemble-agent.ts:190` |
| `McpCredentialFileInfo` name is TAKEN (means "an .adf file holding creds") — do not reuse | `ipc.types.ts:406-413` |
| Current schema version 28; adding an optional config field needs **no** ladder step (zod strip tolerates old files) | `adf-database.ts:702`, `:1496` |

## 3. Design

### D-A: Agent-scoped credential home in the shared container (Phase A)

Declared credential paths use `~` and it expands to an **agent-scoped home**, not the container root's:

- Shared container: `HOME=/workspace/<agentId>/home`, exported via `-e HOME=...` in `PodmanStdioTransport.buildExecArgs` and in the auth preflight's `podman exec` env.
- Isolated container: same rule for uniformity (the container is already agent-scoped; the redirect is harmless).
- Host-routed servers: `~` = the real host home (unchanged — host routing already implies the principal granted host access).

This alone fixes the shared-container clobbering, independent of the keystore work. **Risk**: servers that resolve config relative to `$HOME` get a fresh home and "lose" creds stored under `/root` by earlier versions — a one-time re-auth per agent, called out in the migration note in `docs/guides/mcp-integration.md` (which also covers servers that ignore `$HOME` via getpwuid/hardcoded `/root`: declare the absolute container path for those). Servers using absolute paths outside `$HOME` are unaffected (their declarations just use absolute paths).

### D-B: `credential_files` declaration on `McpServerConfig`

```ts
/** A file-shaped credential the server reads/writes in its runtime filesystem. */
export interface McpCredentialFileSchema {
  /** Absolute path or ~-relative path in the server's runtime FS. */
  path: string
  /** Connect fails plainly when neither keystore nor runtime FS has it. Default false. */
  required?: boolean
  /** Capture into the keystore after a successful auth preflight. Default true. */
  write_back?: boolean
}
// on McpServerConfig:
credential_files?: McpCredentialFileSchema[]
```

Added to `adf-v02.types.ts` and mirrored in `adf-schema.ts` in the same commit (zod-strip rule). The declaration is **metadata only — file content never appears in agent config**, so `sys_get_config` redaction needs no change. No schema-version bump.

`mcp_install` gains a matching `credential_files` input. Content ingestion paths, in preference order: (1) Studio UI upload via a new IPC on the existing `McpCredentialPanel` — **future, UI not yet built** (error messages must not reference it until it exists); (2) `fs_transfer` + a `capture` step for files already in a workspace; (3) inline `content` string on the install input — same exposure model as the existing `env` values (they already transit the loop; No Secrets is about auditability, not prevention).

### D-C: Identity storage form

- **Purpose**: `mcp:<ns>:file:<declared path verbatim>` where `<ns>` follows the *read* order the env pipeline already uses: `npm_package ?? pypi_package ?? name` (`mcpCredentialNamespace`, `mcp-config.ts:16`). Writes use the package namespace — deliberately fixing, for files, the name-vs-package drift the env path has; the resolver still checks name-namespace as fallback for parity.
- **Value**: JSON `{"encoding":"base64","data":"<...>","mode":384,"captured_at":"<iso>"}`. Base64 uniformly (binary-safe, no content sniffing — deterministic).
- **Size cap**: 256 KiB decoded, enforced at capture with a plain error naming the cap. (Real-world targets: `gcp-oauth.keys.json` ~600 B, `tokens.json` ~1 KB.)
- **Envelope**: automatic — non-`crypto:` purpose → `credentials` envelope (D6). If the envelope DEK is not cached at capture time, **fail the capture plainly** instead of inheriting `setIdentity`'s silent plaintext fallback: token files are the highest-value rows in the store and must never be written unsealed. This needs a `setIdentitySealed` variant (or an option) that throws when the envelope is locked/absent.
- **`code_access`**: `false`. Agents interact with credentials through the connect/preflight machinery, not by reading raw token files; `get_identity` listing still shows the purpose exists.

### D-D: Materialization (keystore → runtime FS)

At every server spawn — the three connect paths and the auth preflight, immediately after env resolution:

1. For each declared file, resolve `mcp:<pkg>:file:<path>` then `mcp:<name>:file:<path>`.
2. Found → write it: container targets via temp file (mode 0600) + `copyToContainer` (parent `mkdir -p` is built in); host targets via direct write with `~` expansion. Keystore copy **overwrites** the runtime copy — the keystore is the source of truth once populated.
3. Not found and `required` → fail plainly: name the missing purpose, the declared path, and the available ingestion routes from D-B (the built ones only).
4. Not found and not required → leave runtime FS untouched (bootstrap mode: the server may create it during auth).

Idempotent, deterministic, no diffing.

### D-E: Write-back (runtime FS → keystore)

Immediately after the auth preflight settles successfully (interactive: confirm accepted or clean early exit; headless: exit 0), for each declared file with `write_back !== false`:

- `copyFromContainer` / host-read the declared path; if present, capture per D-C (sealed-or-fail).
- Absent is not an error (a flow may legitimately not produce every declared file).

**v1 scope**: write-back happens *only* at auth-preflight success. Providers with refresh-token *rotation* (tokens mutate during normal operation) will drift stale in the keystore; Google-style stable refresh tokens — the actual target servers — do not. A future amendment can add write-back on graceful disconnect; do not build it speculatively.

### D-F: Portability, share, and claim — policy statement, not new machinery

File credentials inherit the existing envelope model wholesale:

- **Same-owner move**: credentials envelope unlocks via owner/runtime slots (D10) → grants travel with the .adf. This is the headline win.
- **Password share (D12)**: recipient gains the grants — *exactly* as they gain shared API keys today; the spec already prescribes upstream rotation as revocation. OAuth grants additionally support provider-side revocation (e.g. Google account → third-party access), which the docs should mention.
- **Claim (D11)**: user-confirmed, never automatic — unchanged.
- A `portable: false` per-file flag is **deferred**: envelope-level sealing cannot exclude individual rows without a third envelope. If demand materializes, spec a `grants` envelope then. Not now.

### D-G: Daemon runtime keyslot (Phase C — implemented)

The daemon has no safeStorage, so its envelope key is a file, and trust is explicit:

1. **Daemon keypair**: on boot the daemon ensures an X25519 keypair at `<settings dir>/runtime-enc-key` (0600 JSON; shareable public half in `runtime-enc-key.pub`) and logs the public key. The key is minted once and never silently replaced — a corrupt key file throws with recovery instructions rather than re-minting, since a fresh key would orphan every slot wrapped to the old one (`daemon-enc-key.ts`).
2. **Trust registration**: Studio settings key `trustedDaemonEncKeys: string[]` (base64 raw 32-byte X25519 public keys; set via the generic `SETTINGS_SET` IPC — no dedicated UI yet, add the key to settings manually or via devtools). Whenever Studio unlocks or provisions a workspace's envelopes, `OwnerIdentityService.ensureTrustedDaemonSlots` wraps the **credentials** DEK to every trusted daemon key lacking a slot — idempotent per file, keyed by the stable `daemon:<sha256 fingerprint>` label (`AdfWorkspace.addEnvelopeKeySlot`, which refuses the identity envelope, mirroring D12's restriction).
3. **Daemon unlock**: daemon boot registers the workspace identity hooks with an unlock-only implementation (it holds no owner key, so it never provisions envelopes or mints identities). Daemon slots are ordinary `runtime`-type key slots, so the existing D10 cascade opens them with the daemon's key — no new unlock machinery. After that, `getIdentityDecrypted` works for `env:credentials` rows and credential-file materialization + `resolveMcpEnvVars` work headless.
4. **Fail plainly**: an `.adf` never opened in Studio since the daemon key was trusted has no slot — required-file materialization still fails with the locked-envelope error, now suffixed with the daemon's concrete recovery hint (its `runtime-enc-key.pub` path + the `trustedDaemonEncKeys` setting + "open the agent in Studio once").

Trust asymmetry is deliberate: a daemon key gets slots only on the **credentials** envelope, only after the user listed it as trusted, and only for files Studio subsequently unlocks — the daemon can never grant itself access.

## 4. Flow: the google-drive case end-to-end

1. Principal downloads the OAuth client JSON; hands it to the agent (UI upload or paste).
2. Agent: `mcp_install({ package: "@piotr-agier/google-drive-mcp", auth: true, auth_args: ["auth"], credential_files: [{ path: "~/.config/google-drive-mcp/gcp-oauth.keys.json", required: true }, { path: "~/.config/google-drive-mcp/tokens.json" }] })`.
3. Install: keys file captured to `mcp:@piotr-agier/google-drive-mcp:file:~/.config/google-drive-mcp/gcp-oauth.keys.json` (sealed), materialized into the agent-scoped home in the container.
4. Auth preflight (container-side, tunnel auto-forwarded) → consent → tokens.json written by the server → **write-back** captures it sealed into the keystore.
5. Any later machine/container: materialization repopulates both files before spawn. No re-consent.

## 5. Security summary

- File content never enters agent config, tool results, or `sys_get_config` output; only purposes are listable.
- Sealed-or-fail capture closes the plaintext-fallback hazard for the highest-value rows.
- Materialization into containers uses `podman cp` of 0600 temp files — content never appears on a command line (unlike `-e` env values, a known existing exposure noted at `podman-stdio-transport.ts:290`).
- Host materialization only ever happens for host-routed servers, which already sit behind the two-tier host-access gate, and host destinations are confined to `~` (only `~/`-relative declarations, `..` escapes rejected) — a per-server host approval must not imply arbitrary-host-path writes by ADF itself.
- Write-back stats the server-written file before reading it: an oversized file (a hostile server can write anything) fails that file's write-back plainly instead of being read into memory.
- Materialized credential files are readable by `sys_code` running in the same container — same trust domain as the server process that must read them; the keystore rows themselves stay `code_access: false`.
- Threat-model delta over ADF_IDENTITY_SPEC §7: none structural — file grants are exactly as shared/claimed/revocable as env-var keys; provider-side revocation is an *additional* control.

### Known limitations

- `McpClientManager` auto-reconnect reuses the stored transport and does **not** re-materialize credential files; a container rebuilt mid-session needs `mcp_restart` (which reconnects through the full path and re-materializes).
- On coreutils-free (distroless) images, `$HOME` creation relies on `ensureWorkspace` (`podman exec mkdir -p`) succeeding — the sh-wrapper `mkdir -p "$HOME"` fallback is unavailable there.

## 6. Phases & difficulty

| Phase | Content | Difficulty |
|---|---|---|
| **A** | Agent-scoped `HOME` in shared-container exec + preflight | 3/10 |
| **B** | `credential_files` schema + capture/materialize/write-back + `mcp_install`/UI ingestion + sealed-or-fail `setIdentity` variant + docs | 5/10 |
| **C** | Daemon runtime keyslot (file-based X25519 key + Studio trust list + credentials-envelope slots) — implemented | +2 |

~~Open question~~ **Resolved (2026-08-24)**: `HOME` applies to **all** shared-container MCP servers immediately. The one-time re-auth for pre-existing container-stored grants is accepted; the clobbering bug dies now rather than lingering for undeclared servers.
