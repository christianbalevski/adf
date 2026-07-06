# ADF Identity & Key Protection — Spec v0.1 (draft)

Status: **draft for review** — extends `ADF_SPEC_v0.2.md` §5.2 and §8; builds on the
key-backed identity work in `660b17c` (mnemonic-rooted owner DID, runtime delegation,
attestations). Amendments to the main spec are listed in §9.

## 1. Motivation

Agent identity keys are becoming mandatory (lineage, signing, the fleet map), which
means every `.adf` file would otherwise carry a plaintext Ed25519 private key plus
whatever credentials the agent stored via `set_identity`. `.adf` files are meant to
move — copied between machines, shared with another person, leaked by accident.
This spec makes that safe:

- A leaked or copied file **cannot impersonate** the agent (identity is bound to the
  owner, not the file).
- A leaked file **does not disclose credentials** (API keys, MCP secrets).
- A file **deliberately shared with a password** runs for the recipient with the
  sender's credentials, as a *new* agent with recorded provenance.
- The owner mnemonic **recovers everything** on a new machine; the seed stays cold
  during normal operation.

Non-goals are listed in §11 — notably, this spec does **not** encrypt loop history,
memory, or inbox/outbox content, and does not claim a shared file is unreadable.

## 2. Identity roles (existing, for grounding)

| Role | Key | Where | Source |
|------|-----|-------|--------|
| **Owner** | Ed25519 at SLIP-0010 `m/44'/0'/0'` from BIP-39 mnemonic | mnemonic in `safeStorage`; key derived on demand | `mnemonic-identity.ts`, `owner-identity.service.ts` |
| **Runtime** | Ed25519, freshly minted per install, owner-signed delegation | `safeStorage` (`runtimePrivateKey`) | `owner-identity.service.ts:111` |
| **Agent** | Ed25519 per `.adf` | `adf_identity` rows `crypto:signing:{private,public}_key` | `adf-workspace.ts:266` |

Attestations (`adf_attestations` in `adf_meta`, public by design) bind agent DID →
owner/runtime (`attestation.service.ts`). This spec adds **encryption** keys and an
**envelope** layer; it does not change the signing/attestation model.

## 3. Decisions

Each decision is normative for the implementation.

**D1 — Agent identity keys are mandatory at creation.**
Every creation path (`AdfWorkspace.create`, `sys_create_adf`, clone, template
instantiation) provisions an Ed25519 keypair, sets `adf_did`, stamps
`adf_owner_did`/`adf_runtime_did` (readonly), and issues attestations — the same
sequence the clone path performs today (`ipc/index.ts:1234-1239`). Key-less ADFs
created by older versions are provisioned lazily on first open (same pattern as
the owner-DID restamp lazy fallback).

**D2 — The DID is the agent's identity; `config.id` is demoted to a local runtime
handle.** `config.id` (nanoid-12, minted at `adf-database.ts:1275`) remains for
audit labels, event `agentId`s, and log continuity, but no new feature may treat it
as identity. Lineage, ACLs, addressing, attestations, and the fleet map speak DID.
This **contradicts** ADF_SPEC §5.2/§8.1 ("upgrades `config.id` to a DID") — which
the code never implemented; see §9 for the amendment. Rationale: rotation/claim
mints a new DID, and mutating the identifier every internal subsystem logs against
would destroy audit continuity; identifier resolution already matches either form
(`runtime-service.ts:1543`).

**D3 — DID rotation preserves history.** `generateIdentityKeys()` currently
overwrites `adf_did` blind (`adf-workspace.ts:286`). It MUST first append the old
value to `adf_did_history` (readonly meta, JSON array, newest last). Applies to
manual regeneration, claim, and clone-with-fresh-identity.

**D4 — Lineage resolves through a cascade, read-time only.** `adf_parent_did`
continues to store the parent's DID (D1 guarantees one exists at spawn). The fleet
registry resolves a parent reference by: current `adf_did` → `adf_did_history`
membership → legacy `config.id` (files written before D1). Unresolved parents render
as roots ("orphaned lineage"). No write-time repair sweeps of children — a child
file is never mutated because its parent rotated.

**D5 — Secrets are envelope-encrypted with keyslots.** A random per-envelope
32-byte DEK encrypts secret rows (AES-256-GCM, the existing cipher). The DEK is
wrapped once per slot; any slot opens the envelope. Slot types: `owner`, `runtime`,
`password`.

**D6 — Two envelopes with different slot policies.**

| Envelope | Covers (`adf_identity` purposes) | Allowed slots |
|----------|----------------------------------|---------------|
| `identity` | `crypto:signing:private_key` (private key only) | `owner`, `runtime`, `password`* |
| `credentials` | everything else: `set_identity` rows, `mcp:*`, provider keys | `owner`, `runtime`, `password` |

Identity is non-transferable: the `identity` envelope never gets a password slot
via the share flow. (*Exception: the legacy whole-file password mode, §6.6, where
password is the *only* slot on both envelopes — protection against local access,
not a sharing mechanism.)
`crypto:signing:public_key` and `crypto:kdf:*` rows stay plain — they are not secrets.

**D7 — Owner and runtime get X25519 encryption keys, separate from signing keys.**
Ed25519 signing keys never encrypt. Owner: derive at `m/44'/0'/1'` (hardened,
same SLIP-0010 code path; the 32-byte output is the X25519 scalar). The owner
*public* encryption key is stored in settings so wrapping-to-owner never touches
the mnemonic — the seed stays cold; the private half is derived from the mnemonic
only on the recovery path. Runtime: mint an X25519 keypair alongside the existing
runtime key, private half in `safeStorage` (`runtimeEncPrivateKey`), public in
settings.

**D8 — Wrap constructions.**
- Key slot (`owner`/`runtime`): ephemeral X25519 → ECDH with recipient public key →
  HKDF-SHA256 (salt = ephemeral pub, info = `"adf-envelope-v1:" + envelope name`) →
  AES-256-GCM over the DEK. Slot stores `{type, recipient_did, ephemeral_pub, iv,
  wrapped_dek}`. (This is the age/ECIES recipient shape, built from Node crypto
  primitives — `diffieHellman` supports X25519 natively; no new dependency.)
- Password slot: `scryptSync(password, salt, 32)` with `N=2^17, r=8, p=1` (Node
  built-in) → AES-256-GCM over the DEK. Slot stores `{type, salt, kdf: 'scrypt',
  kdf_params, iv, wrapped_dek}`. New password slots MUST NOT use PBKDF2/100k
  (ADF_SPEC §8.3 amendment, §9); existing password-locked files are converted on
  unlock (§8).

**D9 — Storage layout.** Envelope descriptors are `adf_identity` rows
`crypto:envelope:identity` and `crypto:envelope:credentials` (`value` = JSON slot
array, `encryption_algo = 'plain'` — slots are wrapped, not secret). Rows covered
by an envelope use `encryption_algo = 'env:identity'` / `'env:credentials'`; their
`value` is `iv || ciphertext || authtag` under that envelope's DEK, `salt` unused.
The existing per-row `aes-256-gcm` password format remains readable for migration.

**D10 — Unwrap cascade at open.** For each envelope: try `runtime` slot → try
`owner` slot (derives mnemonic key; on success, immediately re-wrap adding a
`runtime` slot for this install) → if a `password` slot exists, mark envelope
*locked* and prompt when first needed → otherwise mark *foreign*. DEKs live in
memory per open workspace (same lifecycle as `derivedKey` today) and are never
persisted.

**D11 — Foreign identity envelope ⇒ claim.** If the `identity` envelope is
foreign, the file cannot sign; the app surfaces the existing claim flow
(`IPC.IDENTITY_CLAIM`, `ipc/index.ts:5630`), which already deletes signing keys,
mints fresh ones (new DID), stamps the local owner/runtime, and re-issues
attestations. Additions: append the unclaimable old DID to `adf_did_history`
(provenance for lineage/дedup, D3), and record a `clone` attestation
(`role: 'clone'`, `scope: <old agent DID>`) so the copy's origin is auditable.
Claim MUST NOT be automatic — it is offered, user-confirmed (an agent arriving at
the wrong machine should not silently become someone else's).

**D12 — Password share flow (credentials only).** "Share with password" adds a
password slot to the `credentials` envelope. On the recipient's machine, after
password unlock succeeds, the runtime re-wraps the credentials DEK to the local
owner + runtime slots and **drops the password slot** — the password is a transit
artifact, not a standing secret. The share dialog states plainly: the recipient
gains the enclosed API keys; revocation = rotate them upstream. UI SHOULD offer a
generated passphrase.

**D13 — Identity-envelope rows are runtime-only, unconditionally.** `get_identity`
/ code execution MUST NOT return `crypto:signing:private_key` regardless of
`code_access` (consistent with the standing rule that runtime-held keys never
reach agent code). Credential rows keep existing `code_access` semantics; an
envelope-encrypted row is readable by code only when its envelope is unlocked.

**D14 — `safeStorage` unavailable ⇒ degrade loudly, don't block.** Runtime private
keys fall back to plaintext settings storage with a persistent Settings warning
(the `safeStorageAvailable` flag already exists). Envelopes are still created —
they protect the *file* in transit even when local settings storage is weak.

**D15 — Attestations move to a dedicated `adf_attestations` table (phase 4).**
Two lifecycle classes emerge with this spec: *current-state* certs
(`owner`/`operator` — invalidated and replaced on re-key) and *append-only facts*
(`clone` per D11; `rotation`/`revocation` later). The current single
`adf_attestations` meta key is replaced wholesale by `issueOwnerAttestation()`,
which would silently erase clone provenance. Table columns mirror
`AlfAttestation` (`issuer, subject, role, issued_at, expires_at, scope,
signature`) plus the raw canonical JSON (verification never depends on column
round-tripping). Rows are plain/unencrypted — public by design, readable at
card-build time under password lock (the property that put them in `adf_meta`
originally). Wholesale replacement is scoped to `role IN ('owner','operator')`;
other roles are append-only. Migration copies the meta array in; the meta key is
retired. Not one-meta-key-per-attestation (pseudo-table with no indexing), and
not `adf_config` (agent-editable document; writes deauthorize per §8.6). No
generic "signed facts" store until a non-attestation-shaped artifact exists.

**D16 — Runtime keys stay random; no device-derived DIDs.** Considered and
rejected: deriving the runtime key from owner seed + device identifier (MAC /
machine-id) so reinstalls keep their runtime DID. Rejected because (a) reinstall
wipes `userData`, including the safeStorage-encrypted mnemonic ciphertext — the
recovery path already requires mnemonic re-import, after which
`importMnemonic()` re-delegates and the `legacyRuntimeDids` restamp restores
continuity at the owner level; (b) MACs are randomized/mutable and machine-ids
change on OS reinstall; (c) seed-derived runtime keys lose independent rotation
and warm the seed, inverting the cold-seed design. Corollary: nothing may anchor
trust or ACLs on a runtime DID — it is operational metadata; the owner
attestation is the trust root.

**D17 — Peer attestations are agent-negotiable via three code primitives.**
`attestation_list` / `attestation_add` / `attestation_issue` join the
`get_identity` family (code-execution methods, gated by `code_execution`
config). Negotiation is plain messaging — a requester asks, an issuer signs
with its agent key and replies, the requester stores; no protocol machinery.
Boundary rules: `attestation_add` requires a verifying signature, subject =
own DID, non-reserved role, and is idempotent on duplicate signatures;
`attestation_issue` rejects reserved roles (`owner`/`operator`/`runtime`/
`clone`/`rotation` stay runtime-only), self-attestation, and non-`did:key`
subjects, and is in the default `restricted_methods` list (authorized code
only). Certs are returned, not stored, by the issuer — attestations live
with their subject. Verification/policy (who trusts which issuer for what)
is deliberately out of scope until a real consumer exists (mesh middleware,
fleet map trust edges, group ADFs).

## 4. Meta & settings key additions

| Key | Where | Protection | Content |
|-----|-------|------------|---------|
| `adf_did_history` | `adf_meta` | readonly | JSON array of prior agent DIDs, newest last |
| `crypto:envelope:identity` | `adf_identity` | plain row | JSON slot array (D9) |
| `crypto:envelope:credentials` | `adf_identity` | plain row | JSON slot array (D9) |
| `ownerEncPublicKey` | settings | plain | base64 X25519 public key (D7) |
| `runtimeEncPrivateKey` | settings | secret (`safeStorage`) | base64 X25519 private key |
| `runtimeEncPublicKey` | settings | plain | base64 X25519 public key |

`adf_did_history` and the envelope rows join the well-known key registry
(ADF_SPEC §3.3).

## 5. Flows

### 5.1 Create (any path)
1. Generate Ed25519 agent keypair; random DEKs for both envelopes.
2. Wrap each DEK to owner + runtime slots (public keys only — seed stays cold).
3. Store private key under `env:identity`; set `adf_did`, `adf_owner_did`,
   `adf_runtime_did` (readonly); `adf_parent_did` when spawned by an agent.
4. Issue owner/operator attestations.

### 5.2 Open
Run the D10 cascade per envelope. Outcomes: *unlocked* (normal), *locked*
(password prompt on first secret access), *foreign identity* (banner + claim
offer, D11), *foreign credentials* (credential-dependent features disabled;
prompt if a password slot exists).

### 5.3 Rotate / regenerate
Append old DID to history (D3) → new keypair → new `identity` DEK + re-wrap →
re-issue attestations (existing wholesale replacement,
`attestation.service.ts:87`). Credentials envelope untouched.

### 5.4 Same-owner migration (new machine, mnemonic imported)
Owner slot unwraps (mnemonic-derived X25519) → re-wrap adds the new runtime's
slot → same agent, same DID, no claim. Complements the existing owner-DID
restamp; the registry's duplicate-DID detection (below) covers the case where the
*original* machine still runs the source file.

### 5.5 Duplicate detection
The fleet registry flags two live files presenting the same `adf_did` — possible
only for same-owner copies once envelopes land (foreign copies can't unwrap and
get claimed to new DIDs). Resolution UI: "regenerate identity on the copy"
(safe: D3 history keeps lineage intact).

## 6. Legacy password mode (§8.4 locked/unlocked)

The existing whole-file password maps onto slots: both envelopes carry a
`password` slot **only** (no owner/runtime slots — its threat model is "someone
at my machine", so warm keys must not bypass it). Unlock caches DEKs in memory,
matching current locked/unlocked semantics. Forgotten password = keys
unrecoverable, unchanged from today. Files password-locked in the legacy per-row
format are converted to this shape on first unlock (§8).

## 7. Threat model summary

| Scenario | Before | After |
|----------|--------|-------|
| `.adf` leaked accidentally | plaintext signing key + credentials | attacker reads config/loop/memory; cannot sign or read secrets |
| File copied to second machine, same owner | duplicate key, silent impersonation | owner slot unwraps; duplicate-DID flagged; one-click re-key |
| File given to another person (no password) | full impersonation + credential theft | claim flow: new DID, provenance attested, no credentials |
| File shared with password | n/a | credentials transfer once; identity still re-minted; password slot dropped after claim |
| Mnemonic lost | owner DID unrecoverable | additionally: owner slots unrecoverable (runtime slots still work locally) — backup-confirmed flow already exists |
| Mnemonic stolen | owner impersonation | additionally: all owner-slot envelopes decryptable — unchanged severity class, wider blast radius; noted in Settings backup copy |

Out of scope (unchanged): plaintext loop/memory/inbox tables (a shared file is
*readable*); post-compromise continuity (a rotation after key theft cannot prove
continuity to remote peers — future signed-rotation-chain, §11).

## 8. Migration

Mirrors the proven restamp pattern (`restampLocalAdfs` + lazy fallback on open):

1. **Boot sweep** over tracked `.adf` files; **lazy fallback** on `FILE_OPEN`.
2. Per file: no keys → provision (D1). Plain keys → wrap into envelopes.
   Legacy per-row password encryption → convert to password-slot envelopes on
   next successful unlock (can't convert without the password).
3. Idempotent: presence of `crypto:envelope:*` rows short-circuits.
4. Failures reported, retried next launch — same contract as `RestampResult`.

## 9. Amendments required in ADF_SPEC_v0.2.md

- **§5.2 / §8.1**: delete "upgrades `config.id` to a DID" (never implemented;
  contradicts D2). New wording: `id` is a permanent local handle; identity is
  `adf_did`; rotation history in `adf_did_history`.
- **§8.2**: add envelope rows to the purposes table.
- **§8.3**: envelope encryption becomes the normative at-rest scheme; scrypt
  parameters for new password slots; legacy PBKDF2/100k documented read-only.
- **§8.4**: locked/unlocked re-expressed as password-only-slot envelopes (§6).
- **§3.3**: register `adf_did_history`; retire the `adf_attestations` meta key
  once D15 lands (table supersedes it).
- **§4 table registry**: add `adf_attestations` (D15).
- **§8.6/8.7 vicinity**: D13 (identity rows never code-readable).

## 10. Implementation phases

| Phase | Scope | Difficulty |
|-------|-------|-----------|
| 1 | D3 history + D4 resolver cascade (unblocks fleet-map lineage) | 3/10 |
| 2 | D7 X25519 keys (owner path + runtime mint) + wrap primitives + tests | 4/10 |
| 3 | Envelopes: D5/D6/D9/D10 storage + unwrap cascade + D1 mandatory keys + §8 migration | 6/10 |
| 4 | D11 claim integration + D12 share flow + duplicate detection UI + D15 attestation table | 6/10 |
| 5 | Spec amendments + docs (`security-and-identity.md`) | 2/10 |

Phase 1 ships independently inside fleet-map milestone 1. Phases 2–3 are the
core; 4 is where the UX risk lives and deserves its own design pass on dialog
copy before build.

## 11. Non-goals / future

- **Content privacy of shared files** — a deliberate "export for sharing" that
  strips identity + loop/audit tables is a separate feature; envelopes are leak
  damage-control, not sharing privacy.
- **Signed rotation chains** (old key attests new DID) for remote-peer
  continuity — design slot exists (`role: 'rotation'` attestation), not built.
- **Hardware-backed owner keys**, multi-owner files, threshold recovery.
