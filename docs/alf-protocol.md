# The ALF Protocol — Agentic Lingua Franca

## Starting Assumptions

Sovereignty requires agency. Agency requires communication. Communication between independent entities requires a shared format.

This protocol is that shared format — the default language sovereign agents use to talk to each other before they've agreed on anything else. It ships with conformant runtimes so that any two stock agents can communicate immediately.

We're making several assumptions that shape the protocol:

**These agents are sovereign.** They carry their own identity, move between runtimes, and may operate on hostile networks. This means the protocol needs to account for portable identity, cryptographic signatures, and optional encryption — things that enterprise agent protocols reasonably skip because they assume trusted infrastructure.

**These agents are primarily LLM-powered.** They have context windows, token budgets, and reason better with structured input. Some fields exist purely for LLM practicality — `subject` helps an agent triage a full inbox without loading every message body into context. `content_type` lets agents route structured content to deterministic handlers without burning tokens parsing unfamiliar JSON. These aren't universal truths about agents; they're practical concessions to how current AI agents work.

**Communication is asynchronous.** Sovereign agents can't assume the other party is online, reachable, or running on the same infrastructure. Store-and-forward is the default. Synchronous communication can be negotiated on top.

**Agents understand web conventions.** LLMs are trained on internet-scale data. They know REST, JSON, HTTP, email patterns. The protocol leverages these rather than inventing new conventions where existing ones work.

Some of these decisions are best guesses. The goal is to simplify common interactions while not preventing alternatives. If something doesn't work, `payload.meta` is always available for agents to develop their own conventions.

---

## What This Protocol Covers

ALF defines the shape of data in flight — the ALF message. The message is the durable artifact: stored in inboxes, signed, forwarded through relays intact. It is the equivalent of an RFC 5322 email message.

The transport layer — HTTP POST URL, WebSocket connection, local same-runtime write — is NOT part of the ALF message. It is equivalent to the SMTP envelope (RFC 5321): it exists during delivery and is discarded after. The same ALF message is delivered identically regardless of transport.

How a runtime stores messages, manages inbox state, chains hashes for audit trails, or presents messages to the agent — those are runtime concerns. Different agent formats will handle storage differently. ALF doesn't have opinions about that.

---

## Conventions Borrowed vs. Invented

Most of ALF is borrowed:

| Decision | Source | Why borrow it |
|----------|--------|--------------|
| `from`/`to`/`reply_to` | SMTP (RFC 5322) | Email message headers. Universally understood. |
| `subject` + `content` | SMTP | Triage without reading the full body. Useful for LLM context management. |
| `content_type` | MIME (RFC 2045) | MIME type for content. Standard across email and HTTP. |
| `thread_id`/`parent_id` | Email/forums | Async threading. Well-established pattern. |
| JSON wire format | Web | Universal data exchange. LLMs parse it natively. |
| DIDs | W3C | Decentralized identity. `did:key` currently — any standard crypto library can parse it without custom resolvers. |
| Ed25519 | Widely deployed | Fast, small signatures. Well-understood security properties. |
| X25519 | Widely deployed | Static key agreement for payload encryption. Stateless, async-friendly. |
| Hashcash v1 | Anti-spam | Baseline spam prevention. No external dependencies. |
| Endpoint-based routing | REST/HTTP | LLMs understand REST natively. Endpoints are transparent and flexible. |
| Open dictionaries | HTTP headers | Request headers vs hop-by-hop headers. Clear ownership model. |
| E2E encryption | Signal | Proven pattern for encrypted payloads over untrusted networks. |
| Ownership attestation | DKIM/DMARC | Sender's owner vouches for the agent. Receiver can verify. |
| Agent card / policy | DKIM selector + DMARC | Discoverable identity and signing policy. |
| SLIP-0010 | HD wallets | Deterministic key derivation for agent recovery. |

A few things are novel because sovereign agents have requirements that existing conventions don't cover:

| Decision | Why it's new |
|----------|-------------|
| Dual signatures | Authorship proof that survives forwarding and re-encryption. No existing convention does this. |
| Aliases inside encrypted payload | Human-readable names that intermediaries can't see. Privacy requirement unique to sovereign communication. |
| `sent_at` inside payload signature | Unforgeable author timestamp. Distinct from the header timestamp which is transport-level. |
| Owner attestation on wire | Fast ownership verification without agent card fetch. Unique to sovereign agent identity. |

---

## Message Schema

The ALF message has five sections. The whole object is the durable artifact — stored, signed, forwarded. Equivalent to an RFC 5322 email message.

```jsonc
{
  // ── 1. HEADER ────────────────────────────────────────────
  // Addressing and routing. Equivalent to RFC 5322 headers.
  "version": "1.0",
  "network": "mainnet",
  "id": "msg_01HQ9ZxKp4mN7qR2wT",
  "timestamp": "2026-02-28T20:00:00Z",
  "from": "did:key:z6MkAlice...",
  "to": "did:key:z6MkBob...",
  "reply_to": "https://alice-server.com/alice/mesh/inbox",

  // ── 2. SENDER META ───────────────────────────────────────
  // Signed by sender. Immutable. Open dictionary for sender-asserted
  // claims about identity and context.
  "meta": {
    "owner": "did:key:z6MkAliceOwner...",
    "owner_sig": "ed25519:...",
    "card": "https://alice-server.com/alice/mesh/card",
    "pow": "1:20:2026-02-28:did:key:z6MkBob...::abc123:0000f"
  },

  // ── 3. PAYLOAD ───────────────────────────────────────────
  // E2E encrypted on public networks. Decrypted by destination runtime.
  "payload": {
    "meta": {},
    "sender_alias": "Alice",
    "recipient_alias": "Bob",
    "thread_id": "thr_abc123",
    "parent_id": null,
    "subject": "Project Schema V1",
    "content_type": "text/plain",
    "content": "Hey Bob, schema is done!",
    "attachments": [
      {
        "filename": "schema.json",
        "content_type": "application/json",
        "transfer": "inline",
        "data": "eyB2ZXJzaW9uOiAi..."
      }
    ],
    "sent_at": "2026-02-28T20:00:00Z",
    "signature": "ed25519:sender_signs_payload..."
  },

  // ── 4. MESSAGE SIGNATURE ─────────────────────────────────
  // Covers header + meta + payload as a unit.
  "signature": "ed25519:sender_signs_message...",

  // ── 5. TRANSIT ───────────────────────────────────────────
  // Append-only. Each intermediary adds its entry. Not sender-signed.
  "transit": {
    "route": [
      {
        "did": "did:key:z6MkRelay...",
        "name": "us-east-relay",
        "timestamp": "2026-02-28T20:00:01Z",
        "signature": "ed25519:relay_signs_its_hop..."
      }
    ]
  }
}
```

| Section | Owner | Mutability | Signed by sender |
|---------|-------|-----------|-----------------|
| Header | Sender | Immutable | Yes |
| Sender Meta | Sender | Immutable | Yes |
| Payload | Sender | Immutable (encrypted) | Yes |
| Signature | Sender | Immutable | — |
| Transit | Network | Append-only | No |

---

### Header

Addressing and routing. Unencrypted so intermediaries can route without reading content. Equivalent to RFC 5322 message headers.

| Field | Type | Required | Why it's here |
|-------|------|----------|--------------|
| `version` | string | Yes | Protocol compatibility. |
| `network` | string | Yes | Prevents cross-network leakage. `"mainnet"`, `"testnet"`, `"devnet"`, or custom. |
| `id` | string | Yes | Globally unique. Minimum 20 characters (~120 bits entropy). Used for deduplication, threading references, and provenance tracking across runtimes. |
| `timestamp` | string | Yes | ISO 8601. Ordering and freshness. |
| `from` | string | Yes | Sender's DID. Portable identity. |
| `to` | string | Yes | Recipient's DID. Signed, so it's proof of intended destination. |
| `reply_to` | string | Yes | URL where replies should be sent. In the message body, not a transport header — survives relay hops without special forwarding logic. Consistent with email's `Reply-To:` which is an RFC 5322 message header, not an SMTP envelope field. |

`from` and `to` are identity (who). `reply_to` is routing (where). `from` and `to` use DIDs because they identify agents portably. `reply_to` uses a URL because it's a delivery address — the sender's preferred inbox endpoint. If omitted, the receiver constructs a default from the sender's DID and connection metadata.

---

### Sender Meta

Open dictionary. Signed by the sender — immutable after creation. This is the sender's space for identity context and transport-level data.

```jsonc
"meta": {
  // Identity context
  "owner": "did:key:z6MkAliceOwner...",
  "owner_sig": "ed25519:...",
  "card": "https://alice-server.com/alice/mesh/card",

  // Anti-spam
  "pow": "1:20:2026-02-28:did:key:z6MkBob...::abc123:0000f",

  // Transport hints
  "sender_address": "https://relay.example.com/mesh/a7f2k9/inbox",
  "ttl": 300,
  "priority": "high",

  // Economics
  "fee_tx": "sol_tx_98765...",

  // Source routing
  "route": ["did:key:z6MkRelayA...", "did:key:z6MkRelayB..."],

  // Runtime attestation
  "runtime": "sha256:abc123..."
}
```

All keys optional. Middleware processes what it recognizes, ignores the rest. New capabilities are meta keys plus middleware, not protocol changes.

#### `meta.owner` and `meta.owner_sig` — Ownership

`owner` is the DID of the entity that owns or operates this agent. Singular on the wire — identifies the current authorizing party.

`owner_sig` is the owner's signature proving they claim this agent. The signed payload is minimal — just the agent DID and owner DID — so that verifiers can reconstruct and check it entirely from information already in the message:

```
owner_sig = sign(owner_private_key, canonical_json({
  agent: "<agent DID from header.from>",
  owner: "<owner DID from meta.owner>"
}))
```

This is deliberately different from the full attestation signatures on the agent card, which cover role, issued_at, expires_at, scope. The wire signature enables fast verification without a card fetch. The card signatures provide full attestation details when needed.

If the agent has no owner attestation, both fields are omitted.

#### `meta.card` — Agent Card URL

The URL where the sender's agent card can be fetched. Equivalent to DKIM's selector + domain pointing to a DNS record.

Receivers fetch this once on first contact, cache the result, and use it for full attestation verification, signing policy lookup, endpoint discovery, and display metadata. Self-hosted by default. Can point to a registry or directory service.

#### Baseline Spam Prevention

A lingua franca needs a default dialect. If Alice uses Hashcash, Bob uses Solana micro-transactions, and Charlie uses a staking mechanism, they can't reach each other without bilateral negotiation — which defeats the purpose of a shared language.

ALF specifies **Hashcash v1** as the Tier 2 baseline for spam prevention. No external dependencies, no blockchain, no payment infrastructure, just CPU. The `pow` meta field uses the standard Hashcash format:

```
pow: "1:20:2026-02-28:did:key:z6MkBob...::abc123:0000f"
```

The difficulty (number of leading zero bits) is set by the recipient and advertised in their agent card. Default: 20 bits.

Agents can upgrade to crypto-economics, staking, reputation systems, or anything else via custom middleware. But if two stock agents meet for the first time with no prior arrangement, Hashcash is the fallback that always works.

---

### Payload

The actual message content. Encrypted on public networks. Intermediaries can't read it.

| Field | Type | Required | Why it's here |
|-------|------|----------|--------------|
| `meta` | object | No | Open dictionary inside the encrypted envelope. Application-level data, adapter context, anything. |
| `sender_alias` | string | No | Human-readable sender name. Inside encryption so intermediaries can't see it. |
| `recipient_alias` | string | No | Human-readable recipient name. Encrypted. |
| `thread_id` | string | No | Groups messages into conversations. Practical for LLMs managing multiple threads. |
| `parent_id` | string | No | Which message this replies to. Enables tree-structured conversations. |
| `subject` | string | No | Short summary for inbox triage. LLM practicality — avoids loading full message bodies into context. |
| `content_type` | string | No | MIME type of the `content` field. Defaults to `text/plain` if omitted. Lets agents route structured content to deterministic handlers without burning tokens parsing unfamiliar JSON. |
| `content` | string/object | Yes | The message body. |
| `attachments` | array | No | Files attached to the message. Each entry is inline (base64) or reference (URL + digest). See Attachments. |
| `sent_at` | string | Yes | ISO 8601. Author's timestamp inside the signature — unforgeable. Different from the header `timestamp` which is transport-level. |
| `signature` | string | No | Payload signature. See Dual Signatures. |

#### `payload.content_type`

| Content Type | Use Case |
|-------------|----------|
| `text/plain` | Human-readable messages (default) |
| `text/markdown` | Formatted messages |
| `application/json` | Structured data exchange between agents |

Receivers that don't understand the content type fall back to treating `content` as plain text. Simple agents ignore the field, sophisticated agents parse structured content.

#### Recommended `payload.meta` Conventions

`payload.meta` is an open dictionary. A few conventions are worth standardizing to prevent fragmentation:

```jsonc
"meta": {
  // Wrapper hint — helps middleware select unwrap behavior
  "wrapper": "fanout",

  // Adapter context — round-trip data for channel adapters
  "source": "telegram-adapter",
  "source_context": { "chat_id": "12345" }
}
```

---

### Message Signature

Sender signs sections 1–3 (header + sender meta + payload as encrypted bytes).

```jsonc
"signature": "ed25519:base64encoded..."
```

Verifiable by anyone using the sender's public key (resolved from DID). On trusted networks the signature may be absent — the agent accepts the risk.

---

### Transit

Append-only. NOT signed by the sender. This is the network's space — each intermediary adds its entry. Equivalent to email's `Received:` headers.

```jsonc
"transit": {
  "route": [
    {
      "did": "did:key:z6MkRelayA...",
      "name": "us-east-relay",
      "timestamp": "2026-02-28T20:00:01Z",
      "signature": "ed25519:relay_signs_its_hop..."
    },
    {
      "did": "did:key:z6MkRelayB...",
      "name": "eu-west-relay",
      "timestamp": "2026-02-28T20:00:03Z",
      "signature": "ed25519:relay_signs_its_hop..."
    }
  ]
}
```

Each route entry identifies the relay, timestamps its hop, and signs its contribution. The `route` array is a standard convention — `transit` remains an open dictionary and intermediaries can write other keys they need.

If `meta.route` exists (source routing), the `transit.route` array records progress against the sender's declared path.

**Two open dictionaries, two owners:**

| Dictionary | Owner | Signed by sender | Purpose |
|-----------|-------|-----------------|---------|
| `meta` | Sender | Yes | Identity context, transport hints, economics |
| `transit` | Network | No | Relay chain, intermediary annotations |

---

## Identity Architecture

### Identity Provider Abstraction

The spec defines what identity looks like (Ed25519 keypairs, DIDs derived from public keys). How keys are generated, stored, and accessed is a runtime concern, abstracted behind an identity provider interface.

The runtime asks the provider: "give me the keypair for this agent" and "sign this payload." The agent stores its DID (public identity) but private key material lives wherever the identity provider puts it.

Three provider models, all producing identical on-the-wire identity:

| Model | Key Storage | Recovery | Tradeoff |
|-------|------------|----------|----------|
| **Sovereign** | User holds seed phrase, derives keys locally | Re-derive from seed + path | Maximum control, maximum responsibility |
| **Platform-managed** | Platform keychain (Secure Enclave, Titan, etc.) | Recover platform account | Transparent to user, platform-dependent |
| **Custodial** | Cloud-hosted (HSM) | Account recovery | Lowest friction, least sovereignty |

From the network's perspective, all three are indistinguishable. A message signed by a DID verifies the same way regardless of where the private key lives. The spec does not define identity providers — it defines that agents have Ed25519 keypairs and DIDs.

### Hierarchical Deterministic Key Derivation

Within any identity provider, agent keypairs SHOULD be derived deterministically from an owner seed using SLIP-0010 (Ed25519 hardened derivation):

```
owner_seed + derivation_path → Ed25519 keypair → DID
```

Same seed + same path = same key = same DID. This enables recovery: wipe the agent, re-derive from the same path, the DID comes back.

Derivation is a private concern. It does not appear on the wire, in the agent card, or in any protocol message. The derived key IS the agent's key — derivation is just how it was produced.

The owner who holds the seed can reconstruct any child agent's private key. The ability to recover and the ability to impersonate are the same capability. This is by design — the agent is sovereign from other agents and other owners, not from its own creator.

### DID Resolution and Transferability

The current `did:key` identifier is derived directly from the public key. This means:

- The DID is the key. Verification is self-contained.
- If the key changes, the DID changes. All existing attestations are invalidated.
- Transfer requires either raw key handoff or re-attestation under a new DID.

Under this model, an agent's identity-linked reputation (attestations, certifications, trust ratings) is non-transferable. The agent has configuration value (its document, tools, knowledge) but its reputation is bound to the original keypair.

**Future path:** To enable clean transfer, the DID method could evolve into a resolvable method where the identifier is a stable random ID and the current public key is resolved through a decentralized mechanism (on-chain registry, gossip, or similar). This would decouple identity from key material, enabling key rotation and ownership transfer without attestation loss. The attestation schema defined below is forward-compatible with resolvable DIDs.

---

## Ownership Attestation

### Concept

Ownership attestation is a signed statement by an owner certifying an agent as theirs. It serves the same role as DKIM in email: the owner vouches for the agent.

Two layers:

- **On the wire (every message):** Owner DID and attestation signature in `meta`. Minimal overhead, fast verification without fetching the agent card.
- **On the agent card (fetched once, cached):** Full attestation objects with metadata, expiry, scope, and multiple attestors.

### Attestation Schema

The agent card carries an `attestations` array. Each attestation is an independent signed claim by an external party about the agent.

```jsonc
"attestations": [
  {
    "issuer": "did:key:z6MkWalmart...",
    "role": "owner",
    "issued_at": "2026-03-01T00:00:00Z",
    "expires_at": null,
    "scope": "full",
    "signature": "ed25519:..."
  },
  {
    "issuer": "did:key:z6MkRetailCert...",
    "role": "verified_merchant",
    "issued_at": "2026-02-15T00:00:00Z",
    "expires_at": "2027-02-15T00:00:00Z",
    "scope": "commerce",
    "signature": "ed25519:..."
  }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issuer` | string (DID) | Yes | DID of the attesting party. |
| `role` | string | Yes | Relationship being attested. `"owner"` is reserved for ownership claims. Other roles are application-defined. |
| `issued_at` | string (ISO 8601) | Yes | When the attestation was created. |
| `expires_at` | string or null | No | When it expires. Null = no expiry. |
| `scope` | string or null | No | What the attestation covers. Application-defined. |
| `signature` | string | Yes | Ed25519 signature by the issuer over the canonical attestation payload. |

**What the issuer signs (card attestation):**

The card attestation signature covers the full attestation payload — more than the minimal wire signature:

```
sign(issuer_private_key, canonical_json({
  agent: "<agent DID>",
  issuer: "<issuer DID>",
  role: "<role>",
  issued_at: "<ISO timestamp>",
  scope: "<scope or null>"
}))
```

This enables detailed verification: what role was attested, when, with what scope and expiry. The wire signature (`meta.owner_sig`) is a separate, minimal signature for fast verification without these details.

### Verification Flow

**Fast path (wire only, no card fetch):**

1. Extract owner's public key from `meta.owner` DID
2. Reconstruct canonical payload: `{ agent: header.from, owner: meta.owner }`
3. Verify `meta.owner_sig` against the reconstructed payload
4. Result: this owner claims this agent. No expiry, scope, or role information.

**Full path (first contact, then cached):**

1. Fast-path verification first
2. Fetch agent card from `meta.card` URL
3. Find attestation(s) with matching `issuer` DID
4. Verify each attestation `signature` against its full canonical payload (agent, issuer, role, issued_at, scope)
5. Check `expires_at`, `scope`, `role` as needed
6. Cache the card — subsequent messages use fast path only

### Multiple Attestations

An agent can carry attestations from multiple independent parties:

- **Co-ownership:** Multiple `role: "owner"` attestations from different parties
- **Certification:** An industry body attests the agent meets standards
- **Marketplace verification:** A platform attests the agent is a verified participant
- **Reputation layering:** Different authorities vouch for different capabilities

The `meta.owner` field on the wire is singular — it identifies the current operator. The full attestation picture is on the card.

### Revocation

Attestation revocation is a distribution problem independent of the format. Three approaches, any of which work:

- **Short-lived credentials:** Set `expires_at` and require periodic renewal
- **Revocation announcement:** Issuer publishes a signed revocation message through the network
- **Registry:** External revocation list (centralized or on-chain)

The spec does not mandate a revocation mechanism. Implementations SHOULD check `expires_at` when present.

---

## Routing

Messages are delivered to endpoints. The endpoint is the URL path the message is POSTed to — the first piece of information available about an incoming message, known before decryption, before parsing, before anything.

Agents advertise their endpoints in agent cards. Senders choose which endpoint to target. Recipients define handlers for their endpoints. The ALF message format is the same regardless of endpoint — only the destination path changes.

The protocol doesn't define which endpoints agents should have. `/inbox` and `/health` will probably become common conventions. Relays will likely expose `/api/register` and `/api/members`. These are conventions that emerge from usage, not protocol mandates.

If agents need message categorization within a single endpoint, `payload.meta` is available for that.

---

## Attachments

Files are attached inside the encrypted payload. Each attachment is self-describing with its own `content_type` and `transfer` mode.

### Inline

Base64-encoded, included directly in the message. Practical for small to medium files.

```jsonc
{
  "filename": "config.json",
  "content_type": "application/json",
  "transfer": "inline",
  "data": "eyB2ZXJzaW9uOiAi..."
}
```

### Reference

Hosted elsewhere. The message includes a URL, content digest, and file size. Practical for large files.

```jsonc
{
  "filename": "model_weights.safetensors",
  "content_type": "application/octet-stream",
  "transfer": "reference",
  "url": "https://host:port/alice/shared/model_weights.safetensors",
  "digest": "sha256:d2a84f4b8b650937ec8f73cd8be2c74add5a911ba64df27458ed8229da804a26",
  "size_bytes": 4294967296
}
```

### Imported (Runtime-Only)

After delivery, the receiving runtime extracts inline attachments to the recipient's local filesystem and changes the `transfer` field from `"inline"` to `"imported"`. This is a **storage-side marker** — it never appears on the wire. It indicates that the file data has been extracted and the `data` field is no longer present.

```jsonc
{
  "filename": "config.json",
  "content_type": "application/json",
  "transfer": "imported",
  "path": "imported/sender-name/config.json",
  "size_bytes": 1024
}
```

The `path` field is a `StoredAttachment` extension (not part of the wire format) pointing to the local file in the recipient's workspace.

### Attachment Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filename` | string | Yes | Human-readable filename. |
| `content_type` | string | Yes | MIME type. |
| `transfer` | string | Yes | `"inline"`, `"reference"`, or `"imported"` (storage-only, post-delivery). |
| `data` | string | If inline | Base64-encoded file content. |
| `url` | string | If reference | URL where the file can be fetched. |
| `digest` | string | If reference | Content hash for integrity verification. Format: `algorithm:hex`. |
| `size_bytes` | integer | No | File size. Useful so the recipient can decide before fetching. |
| `path` | string | If imported | Local filesystem path (runtime extension, not on wire). |

Both modes can coexist in the same message. Attachments are inside the payload, so they're covered by E2E encryption. Reference URLs are also encrypted — intermediaries can't see what files are being shared or where they're hosted.

---

## Dual Signatures

Two signatures for two different purposes.

| Signature | Location | Covers | Purpose |
|-----------|----------|--------|---------|
| Message signature | Top-level `signature` | Entire message (encrypted payload bytes) | Transport integrity — "this DID sent this to that DID" |
| Payload signature | `payload.signature` | Payload content (plaintext) | Authorship proof — "this person wrote these words" |

### Why Both?

The message signature breaks when the payload is re-encrypted (group fan-out, forwarding). The payload signature survives because it covers the plaintext, not the encrypted bytes.

This matters for sovereign agents because accountability requires unforgeable authorship. If Alice sends a message to a group and the group forwards it to Bob, Bob needs to verify Alice wrote it — not just that the group relayed it.

### Flow

```
Alice → Group:
  1. Alice constructs payload, signs it → payload.signature
  2. Alice encrypts payload, signs entire message → top-level signature
  3. POST to group's /inbox

Group → Bob:
  1. Verify Alice's message signature
  2. Decrypt, verify Alice's payload signature
  3. Wrap Alice's message inside a new message
  4. POST to Bob's /inbox

Bob receives:
  1. Verify group's wrapper signature
  2. Unwrap, find Alice's inner message
  3. Verify Alice's payload signature → Alice wrote this
```

### Tradeoffs

**Accountability over deniability.** Deniable encryption is a well-understood and often desirable feature in communication systems — but those systems have primarily been designed for human users, where privacy from third parties is a reasonable default. For AI agents, the calculus is different. Autonomous agents acting on behalf of users, spending resources, making commitments, and interacting with other agents' resources need to be accountable for their actions. We think accountability is the more important default for agentic systems.

Deniability is always available — agents can use middleware to strip payload signatures or implement deniable signature schemes — but it requires both parties to agree and accept the implications. The protocol doesn't prevent it; it just doesn't start there.

Both signatures are optional. Recipients that require them reject messages without them.

---

## The Wrapper Pattern

When an intermediary re-routes a message while preserving the original, it wraps it: the original becomes the `content` of a new message. The inner message is never modified.

### Group Fan-Out Example

Alice sends to the group's `/inbox`:

```jsonc
{
  "version": "1.0",
  "network": "mainnet",
  "id": "msg_01HQ9ZxKp4mN7qR2wT",
  "timestamp": "2026-02-28T20:00:00Z",
  "from": "did:key:z6MkAlice...",
  "to": "did:key:z6MkProjectChat...",
  "reply_to": "https://alice-server.com/alice/mesh/inbox",
  "meta": {
    "owner": "did:key:z6MkAliceOwner...",
    "owner_sig": "ed25519:...",
    "card": "https://alice-server.com/alice/mesh/card"
  },
  "payload": {
    "sender_alias": "Alice",
    "thread_id": "thr_dev_updates",
    "content": "Hey team, schema is done.",
    "sent_at": "2026-02-28T20:00:00Z",
    "signature": "ed25519:alice_payload_sig..."
  },
  "signature": "ed25519:alice_message_sig...",
  "transit": {}
}
```

The group wraps for each member and POSTs to their `/inbox`:

```jsonc
{
  "version": "1.0",
  "network": "mainnet",
  "id": "msg_fanout_bob_01HQ9a...",
  "timestamp": "2026-02-28T20:00:01Z",
  "from": "did:key:z6MkProjectChat...",
  "to": "did:key:z6MkBob...",
  "reply_to": "https://group-server.com/project-chat/mesh/inbox",
  "meta": {
    "card": "https://group-server.com/project-chat/mesh/card"
  },
  "payload": {
    "meta": { "wrapper": "fanout" },
    "content": {
      "version": "1.0",
      "network": "mainnet",
      "id": "msg_01HQ9ZxKp4mN7qR2wT",
      "timestamp": "2026-02-28T20:00:00Z",
      "from": "did:key:z6MkAlice...",
      "to": "did:key:z6MkProjectChat...",
      "reply_to": "https://alice-server.com/alice/mesh/inbox",
      "meta": {
        "owner": "did:key:z6MkAliceOwner...",
        "owner_sig": "ed25519:...",
        "card": "https://alice-server.com/alice/mesh/card"
      },
      "payload": {
        "sender_alias": "Alice",
        "thread_id": "thr_dev_updates",
        "content": "Hey team, schema is done.",
        "sent_at": "2026-02-28T20:00:00Z",
        "signature": "ed25519:alice_payload_sig..."
      },
      "signature": "ed25519:alice_message_sig..."
    },
    "sent_at": "2026-02-28T20:00:01Z",
    "signature": "ed25519:group_payload_sig..."
  },
  "signature": "ed25519:group_message_sig...",
  "transit": {}
}
```

### Recognizing Wrapped Messages

When `content` is an object containing ALF message fields (`version`, `from`, `to`, `signature`), it's a nested message. The optional `payload.meta.wrapper` hint (`"fanout"`, `"forward"`, `"error"`) helps select unwrap behavior, but structural recognition is the primary mechanism.

### Common Patterns

| Pattern | Outer `from` | Inner `from` | `payload.meta.wrapper` |
|---------|-------------|-------------|----------------------|
| Group fan-out | group DID | original author | `"fanout"` |
| Forwarding | forwarder DID | original author | `"forward"` |
| Error bounce | relay DID | relay DID | `"error"` |

---

## Threading

Follows email and forum conventions. Practical for LLMs managing multiple concurrent conversations.

```
if thread_id provided → use it
else if parent_id provided → inherit from parent
else → thread_id = own message id
```

Inner messages in wrappers carry their own threading through wrapping.

---

## Security Levels

Four levels. Agents choose based on their threat model. The protocol doesn't mandate any level.

### Level 0: Open

No signature. No encryption. Localhost, private VPC, development. Fine for twelve agents on a laptop.

### Level 1: Signed

Signature present. No encryption. Content readable by anyone on the path. For public broadcasts, announcements, open coordination — when you want to prove you said something but don't need privacy.

### Level 2: Signed + Encrypted

Signature present. Payload encrypted using **X25519 static key agreement** — the recipient's public key is derived from their `did:key`. Simple, stateless, works for async store-and-forward without requiring session state.

The practical minimum for sovereign agents on public infrastructure. Without it: content is interceptable, aliases leak to intermediaries, authorship isn't provable.

**Tradeoff: no forward secrecy.** Static key encryption means that if an agent's private key is ever compromised, past captured traffic can be retroactively decrypted. This is a deliberate choice — forward secrecy requires session state, which conflicts with the async store-and-forward model. Agents that need forward secrecy upgrade via Level 3.

### Level 3: Advanced

Level 2 plus additional guarantees via middleware and meta conventions. What "advanced" means is up to the agent:

- Forward secrecy — Double Ratchet or similar, ephemeral key material exchanged via `meta` fields
- Path tracing — signed relay chain in `transit`
- Onion routing — layered encryption, each relay sees only the next hop
- Zero-knowledge proofs — prove runtime integrity without revealing code
- Post-quantum cryptography — lattice-based signatures
- Deniable signatures — provable to recipient but not to third parties

Level 3 is a space, not a feature. The protocol provides extensibility mechanisms; agents choose their guarantees.

---

## Middleware Pipeline

Three tiers on both ingress and egress.

### Tier 1: Runtime

Ships with the runtime. Core crypto — signing, encryption, decryption, signature verification, wrapper recognition.

### Tier 2: Standard

Ships with the default stack. Common operations — DID resolution, Hashcash v1 PoW generation/verification, thread resolution, peer auto-discovery, rate limiting, owner attestation verification. Swappable and lockable by owner.

### Tier 3: Custom

Installed by agent owner. PQC, custom DID resolution, content filtering, payment verification, protocol bridges (A2A, ACP), onion routing, ZK attestation, whatever the agent needs.

### Middleware Locking

Owners can lock middleware to prevent modification. A locked encryption requirement can't be downgraded. A locked PoW requirement can't be bypassed.

### DID Resolution

Tier 2. Default resolves from local peer table. Alternatives: relay query, registry lookup, DHT, blockchain. Swap the resolver middleware to change the strategy.

---

## Transport Layer

The transport layer is NOT part of the ALF message. It is the mechanism used to deliver the message — equivalent to the SMTP envelope (RFC 5321). The same ALF message is delivered identically over HTTP, WebSocket, or local same-runtime transfer.

| Transport | Delivery | Confirmation | Use Case |
|-----------|----------|-------------|----------|
| **HTTP POST** | POST to recipient's endpoint | HTTP `202 Accepted` | Default. Direct delivery, relay forwarding. |
| **WebSocket** | Write ALF message as text frame | Socket acceptance | Persistent connections, NAT traversal, relay push. |
| **Local** | Direct inbox write (skip network) | Immediate (same process) | Agents on the same runtime. |

The runtime selects transport automatically on egress: same-runtime → active WebSocket → HTTP POST.

### What Lives in Transport

| Concern | Where | Email equivalent |
|---------|-------|-----------------|
| Delivery address | POST URL / connection target | SMTP `RCPT TO` |
| Bounce address | Transport context, hoisted to inbox on receipt | SMTP `MAIL FROM` → `Return-Path:` |
| Connection metadata | TCP/HTTP/WS context | SMTP connection info |

These never enter the ALF message. The receiver hoists what it needs into inbox columns or transit entries on receipt. The `return_path` (where delivery failure notifications go) is constructed from transport context and stored on the inbox row — separate from `reply_to` because failure notifications are a transport concern, not an application concern.

### WebSocket Authentication Handshake

WebSocket connections use mutual DID authentication before any ALF messages are exchanged:

1. **Client sends auth**: `{ type: "auth", did, nonce: <random-32-bytes-hex>, signature: "ed25519:<base64>", timestamp }`
   - `signature` signs: `did + nonce + timestamp` (concatenated as UTF-8)
2. **Server verifies**: extract pubkey from DID, verify signature, check timestamp within 30s.
   - Invalid → close with code `4001`.
3. **Server responds**: `{ type: "auth_result", success: true, server_did, nonce: <client-nonce>, signature: "ed25519:<base64>" }`
   - `signature` signs: `server_did + client_nonce + timestamp`
4. **Client verifies**: server signature. If expected DID was configured and `server_did` doesn't match → close.
5. Connection authenticated. All subsequent text frames are ALF messages (one per frame).

Auth timeout: 30s from connection open.

**Inbound:** If `security.allow_unsigned: true` on the receiving agent, the handshake is skipped. Clients may still send an optional auth frame to claim a DID — it is accepted without verification and stamped `identity_verified: false`.

**Outbound:** Auth behavior is controlled per-connection via the `auth` field on `WsConnectionConfig` (`auto` | `required` | `none`), independent of the agent's `allow_unsigned` setting. Default `auto` authenticates whenever a private key is available.

### WebSocket Close Codes

| Code | Meaning |
|------|---------|
| `1000` | Normal closure |
| `1001` | Going away (agent unregistered, shutdown) |
| `4001` | Authentication failed |
| `4003` | Invalid frame (not valid JSON or not a valid ALF message) |
| `4004` | No WebSocket route configured |
| `4503` | WebSocket manager not available |

---

## Agent Card

The portable identity and policy document for agent discovery. ALF defines the wire format — how cards are constructed and stored is a runtime concern.

`handle` is the single required identity label — the runtime-unique, URL-safe identifier that appears in every endpoint URL. `description` provides human-readable context. Agent capabilities are expressed through `description` and `shared` files rather than a machine-readable capabilities list.

```jsonc
{
  // Identity
  "did": "did:key:z6MkAgent...",
  "handle": "walmart-support",
  "description": "Customer service agent",
  "public_key": "z6MkAgent...",

  // Resolution — how to verify the current public key for this DID
  "resolution": {
    "method": "self",
    "endpoint": "https://relay.example.com/mesh/walmart-support/card"
  },

  // Endpoints
  "endpoints": {
    "inbox": "https://relay.example.com/mesh/walmart-support/inbox",
    "card": "https://relay.example.com/mesh/walmart-support/card",
    "health": "https://relay.example.com/mesh/walmart-support/health",
    "ws": "wss://relay.example.com/mesh/walmart-support/ws"
  },

  // Attestations
  "attestations": [
    {
      "issuer": "did:key:z6MkWalmart...",
      "role": "owner",
      "issued_at": "2026-03-01T00:00:00Z",
      "expires_at": null,
      "scope": "full",
      "signature": "ed25519:..."
    }
  ],

  // Policies — typed policy objects declaring send/receive behavior
  "policies": [
    {
      "type": "signing",
      "standard": "ed25519",
      "send": "required",
      "receive": "required"
    },
    {
      "type": "owner_attestation",
      "send": "required",
      "receive": "optional"
    }
  ],

  "public": true,
  "shared": ["public/capabilities.md"],

  // Card signature — runtime signs the card on every build
  "signed_at": "2026-03-07T12:00:00Z",
  "signature": "ed25519:..."
}
```

### Policies

Array of typed policy objects declaring send/receive behavior. Each policy has a `type`, optional `standard`, and `send`/`receive` levels:

| Level | On `send` | On `receive` |
|-------|-----------|-------------|
| `"required"` | I always do this | I demand this from you |
| `"optional"` | I can do this | I can handle this |
| `"none"` | I don't do this | I don't care about this |

**Pre-send:** Fetch peer's card, check their `receive` requirements before sending. Peer says `signing.receive: "required"` — you must sign or your message will be rejected.

**Post-receive (spoofing detection):** Check peer's `send` declarations against received message. Peer says `signing.send: "required"` but message has no signature — likely spoofed. Policies are advisory. The receiver decides enforcement.

### Card Signature

The runtime signs the card whenever it builds one, using the same Ed25519 signing used for ALF messages. `signed_at` is an ISO timestamp of when the card was signed. Registries or other agents receiving a card verify the signature against the `public_key` in the card before trusting it.

**Signature scope.** The signature covers identity and policy fields only — specifically, the canonical JSON of all card fields **except**:

- `signature` itself (a signature can't cover itself)
- `endpoints` (`inbox`, `card`, `health`, `ws`)
- `resolution.endpoint` (the URL within the resolution block)

These excluded fields are reachability metadata that the directory endpoint rewrites per-requester: a LAN peer fetching `/mesh/directory` receives cards with LAN-reachable URLs, while a loopback caller receives 127.0.0.1 URLs — same card, different endpoints, same signature. The signature protects identity (did, public_key, handle, description, policies, resolution method, …) and the receiver treats endpoints as transport hints, not identity claims.

Verifiers must apply the same canonicalization on verify: strip `signature`, `endpoints`, and `resolution.endpoint` before hashing. The reference implementation exposes `canonicalizeCardForSignature(card)` for this.

### Resolution

The `resolution` block tells verifiers how to look up and confirm the current public key for this DID. For `"self"` resolution (the default), the card itself is authoritative. Other methods (`"chain"`, `"registry"`, `"dns"`) enable key rotation and resolvable DIDs.

### Card Overrides

Agents can override auto-derived card fields via config (`card.endpoints`, `card.resolution`). This enables agents behind public relays to advertise their relay URLs instead of local mesh addresses. Update via `sys_update_config`:

```
sys_update_config({ path: "card.endpoints", value: { "inbox": "https://relay.example.com/me/inbox" } })
```

---

## Alias Registration

On public networks, aliases should be cryptographically bound to identity.

```
alias = hash(public_key + relay_salt)
```

Relay publishes its salt. Anyone can verify the binding.

### Registration Handshake

Agent POSTs to relay's `/api/register`:

```jsonc
{
  "version": "1.0",
  "network": "mainnet",
  "id": "msg_reg_01HQa2bCdEfGhIjK",
  "timestamp": "2026-02-28T20:00:00Z",
  "from": "did:key:z6MkBob...",
  "to": "did:key:z6MkRelayUSEast...",
  "reply_to": "https://bob-server.com/bob/mesh/inbox",
  "meta": {},
  "payload": {
    "content": { "public_key": "ed25519:..." },
    "sent_at": "2026-02-28T20:00:00Z",
    "signature": "ed25519:bob_payload_sig..."
  },
  "signature": "ed25519:bob_message_sig...",
  "transit": {}
}
```

Relay responds to Bob's `/inbox`:

```jsonc
{
  "from": "did:key:z6MkRelayUSEast...",
  "to": "did:key:z6MkBob...",
  "payload": {
    "content": {
      "alias": "x7f9k2",
      "address": "https://relay-us-east.example.com/mesh/x7f9k2/inbox",
      "capabilities": ["trace"],
      "terms": { "cost_per_message": 0.001, "cost_unit": "usd", "free_tier": 1000 }
    },
    "sent_at": "2026-02-28T20:00:01Z"
  }
}
```

Alias lifetime (session, TTL, permanent) is relay policy.

---

## Relay Economics

Relays set their own terms. Payment requests are standard ALF messages:

```jsonc
{
  "payload": {
    "content": {
      "outstanding": 12.50,
      "currency": "usd",
      "held_messages": 47,
      "payment_address": "0x..."
    },
    "sent_at": "2026-02-28T20:00:00Z"
  }
}
```

The agent reasons about it. Payment mechanisms are middleware concerns. Costs compound through relay chains, creating natural pressure toward flatter topologies.

---

## What the Protocol Doesn't Cover

These are runtime, application, or agent-level concerns:

| Concern | Where it lives |
|---------|---------------|
| Endpoint definitions | Agent cards |
| Message categories | `payload.meta` or endpoint selection |
| Group chat mechanics | Group agent implementation |
| Message storage | Runtime (inbox/outbox schema) |
| Audit trails | Runtime (hash-chaining, attestation) |
| Contact management | Agent (peer tables) |
| Moderation | Custom middleware |
| Protocol bridging | Custom middleware |
| Cost tracking | Agent |
| Identity providers | Runtime (sovereign, platform-managed, custodial) |
| Key derivation | Runtime (SLIP-0010, private concern) |
| Bounce handling | Transport layer (return_path) |

---

## Group E2EE

Two approaches, both valid.

### Trusted Group Relay

The common case. The group relay is trusted to see plaintext. Alice signs her payload, encrypts the message to the group, sends it. The group decrypts, verifies Alice's payload signature, then re-encrypts and forwards to each member individually. Members verify Alice's payload signature to confirm authorship.

This is what the wrapper pattern already supports. The dual signature model exists precisely for this — the payload signature survives the group's decrypt-and-re-encrypt cycle.

### Symmetric Key (Untrusted Relay)

For groups where the relay shouldn't see content. Alice requests the member list from the group relay, then messages each member directly with a shared symmetric key. Group messages are encrypted with the symmetric key. The relay forwards encrypted blobs it can't read.

Key distribution is out-of-band from the relay's perspective — just normal ALF messages between Alice and each member. Key rotation is the group's responsibility.

Both approaches use the same ALF message format. The difference is whether the group relay decrypts or just forwards.

---

## Message Size

Protocol default: **25MB per message** including inline attachments.

This matches the email convention. The payload without attachments is typically a few KB. Inline attachments are where size matters — 25MB accommodates documents, images, code files, and medium datasets. Anything larger should use reference transfers.

Relays can advertise lower limits in their terms. Runtimes can enforce their own limits. 25MB is the baseline that conformant implementations should support.

---

## Non-Normative Conventions

### Stream Control Messages — `application/alf-stream-*+json`

Agents negotiating continuous byte streams (shell sessions, log tailing, CDC replication, TCP forwarding, WebRTC signaling, LLM token streaming) SHOULD use the `application/alf-stream-*+json` content_type family so tooling — UIs, audit systems, middleware — can recognize stream control messages without understanding every underlying stream protocol.

Canonical verbs:

| content_type | Purpose |
|---|---|
| `application/alf-stream-open+json` | Initiator requests a stream |
| `application/alf-stream-accept+json` | Responder accepts, provides endpoint |
| `application/alf-stream-reject+json` | Responder refuses, provides reason |
| `application/alf-stream-close+json` | Either side signals end of session |

Payload shapes are agent-defined by convention. These are ordinary ALF messages — existing middleware, signature verification, owner attestation, and trust gates apply unchanged.

This is a non-normative reservation. No changes to the message schema, no new fields, no new sections in the normative protocol. Adherence enables interop; ignorance does not break conformance.

---

## Future Work

| Item | Description |
|------|-------------|
| **ARC-style relay chain auth** | `auth_results` on `transit.route` entries — each relay records verification results (message_sig, payload_sig, owner_sig pass/fail). Enables end-to-end trust through relay chains. |
| **Resolvable DID method** | Stable DID decoupled from key material via blockchain/consensus. Enables key rotation and ownership transfer without attestation loss. |
| **Revocation standard** | Standard mechanism for invalidating attestations (short-lived credentials, broadcast, or registry). |
| **`References`-style threading** | Full message ID chain for resilient thread reconstruction across runtimes (RFC 5322 `References:` equivalent). |
| **Structured bounce messages** | Typed failure notifications to `return_path`. |
| **Per-message owner co-signing** | Higher security level where owner co-signs each message (requires owner key to be hot). |