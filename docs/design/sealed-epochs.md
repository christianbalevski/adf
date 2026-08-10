# Sealed epochs — portable verifiable agent history

**Status: deferred. Not scheduled. This is a design proposal, not a description
of anything the runtime does today.**

An implementation of the first rung of this ladder (signed checkpoints over a
durable, rolling-hash-chained event log) exists and is preserved on the branch
`parked/umbilical-attestation`. It was removed from `main`'s line of development
because its substrate — a durable event table in the agent's own `local_*`
namespace — was the wrong place to put runtime bookkeeping, and because the only
live consumer of the replay window (dashboard reconnect via snapshot-then-tail)
re-snapshots on a gap and therefore never needed durability at all. The runtime
today keeps an in-memory, bounded [replay window](../guides/umbilical.md#replay-window)
and nothing else.

This document exists so the reasoning survives the deletion.

---

## Motivation

An `.adf` file is a portable agent. It can be handed to someone else: sold,
delegated, audited, inherited. The moment that happens, the receiving party has
a question the current format cannot answer:

> Is the state I am holding the endpoint of a signed, unbroken record of how it
> got here — and can I walk back every action that changed it?

Today the answer is no. An agent's history lives in whatever logs and tables
happen to be present, none of which are bound to the state they produced, none
of which are signed, and any of which can be edited by whoever holds the file.

Sealed epochs are the construction that would make the answer yes: on receipt of
an `.adf`, verify that the current state is the terminus of a signed chain, then
replay that chain backwards through every state-changing action.

## Key construction

### Logical state root

A Merkle root over **canonical serializations of the agent's logical state**,
domain by domain:

| Domain | Committed content |
|---|---|
| `config` | The agent config, canonically serialized (sorted keys at every depth) |
| `loop` | The conversation loop rows, in order, canonically serialized |
| `files` | Content hashes of the agent's embedded files, keyed by path |
| `tables` | Per-table row digests for the agent's data tables |
| `meta` | Identity, handle, ownership, and other metadata fields |

Each domain produces its own subtree; the state root is the Merkle root over the
domain roots.

**Not a file-byte hash.** Hashing the live SQLite file would be worthless: page
layout, vacuum state, free lists, and write ordering all change the bytes
without changing the agent, and two agents in identical logical states would
produce different hashes. The commitment has to be over meaning, not storage.

### Epoch seal

```jsonc
{
  "agent_id":          "…",
  "epoch_n":           17,
  "prev_epoch_hash":   "…",   // hash of epoch 16's seal — this is the chain
  "events_root":       "…",   // Merkle root over the epoch's event block
  "state_root_before": "…",   // logical state root when the epoch opened
  "state_root_after":  "…",   // logical state root when it sealed
  "timestamp":         1732041000123
}
```

Signed with the agent's Ed25519 identity key — the same key the mesh WebSocket
DID handshake uses. Epochs chain through `prev_epoch_hash`, so one verified
recent seal transitively covers everything before it.

**The analogy:** git commits, where the tree is the agent's logical state and
the commit message is a signed block of the events that produced it. `git log`
walks the chain; `git show` gives you the actions; the tree hash tells you the
state those actions landed on.

## Why state binding matters

An event chain alone proves **internal consistency**, not **completeness**. A
runtime that simply never emits an event has produced a log that verifies
perfectly and describes a history that did not happen.

Binding each seal to `state_root_before` and `state_root_after` closes that. If a
state-changing action is omitted from the event block, the state root at the
*next* seal will not be reachable from the events that were disclosed — the
connection breaks. Omission stops being invisible and becomes a specific,
locatable verification failure.

**Redaction remains possible, and stays honest.** Sensitive event content can be
committed as a Merkle leaf and disclosed only on demand: the verifier sees an
inclusion proof against `events_root` and knows an event exists at that position
without seeing its content. The property that holds is *committed-but-
undisclosed*, never *absent*. You may decline to show; you may not pretend there
was nothing to show.

## Claim ladder

Precision here matters more than ambition. Each rung adds exactly one property.

**L1 — signed checkpoints** *(implemented, parked on `parked/umbilical-attestation`)*
Periodic signatures over a rolling-hash chain of events.
Buys: **downstream tamper-evidence** (nobody between the runtime and the verifier
can alter the stream undetected) and **operator non-repudiation** (whoever held
the key stands behind what was emitted).

**L2 — sealed epochs** *(this document)*
Adds: **completeness of state-changing history** (omissions break the state-root
connection), **state↔history binding** (the state you hold is provably the
terminus of the history you were shown), and a **portable custody chain** that
survives transfer of the file between parties.

**L3 — external anchoring**
Publish epoch hashes to a witness or transparency log.
Adds: **the operator cannot rewrite history post-hoc.** At L2, an operator
holding the key can regenerate the entire chain from genesis and present a
different past; there is nothing to contradict it. Once epoch hashes are
witnessed at the time they were made, a rewritten chain is a *fork* — and forks
are detectable by comparing against the witness.

**L4 — attested execution (TEE)** *(named as the ceiling; out of scope)*
Hardware attestation that the runtime binary producing the events is the one it
claims to be, running unmodified.
Adds: **proof that events reflect real execution.**

> At **every level below L4**, a malicious runtime that holds the agent's key can
> fabricate a completely coherent history from genesis: consistent chain,
> consistent state roots, valid signatures, describing actions that never
> occurred. L1–L3 constrain *editing* and *hiding*; only L4 constrains *lying
> from the start*. Any claim made about sealed epochs that does not respect this
> boundary is a false claim.

## Storage

When this is built, the journal is **canonical and runtime-owned**:

- append-only, with full (untruncated) payloads;
- brotli-compressed per-epoch segments;
- archivable to external storage, keeping only epoch headers locally, so an
  agent with a long history does not carry all of it in the file;
- explicitly **not** in the agent's `local_*` namespace — that is agent space,
  writable by `db_execute`, and runtime bookkeeping does not belong there;
- explicitly **not** the in-memory replay ring, which exists to close reconnect
  windows for live observers and is lossy by design (bounded, truncated,
  exclusion-filtered).

Three different jobs, three different mechanisms. Conflating them is what got
the first attempt removed.

## Open decisions

- **Epoch cadence.** Every N events, on agent stop, on transfer (a "sealed
  handoff" — the epoch that closes when custody changes), or some combination.
  Cadence trades verification granularity against seal cost.
- **State-root domain set for v1.** Which of `config` / `loop` / `files` /
  `tables` / `meta` are in scope initially, and how per-table row digests are
  computed for tables the agent mutates at high frequency.
- **Chain-break behavior.** Recommendation: **the agent keeps running** and the
  runtime records a signed discontinuity event. Refusing to run on a broken
  chain turns any corruption — including a crash mid-seal — into a denial of
  service, and hands anyone who can touch the file a kill switch.
- **Key rotation.** How a rotated identity key is bound into the chain so
  pre-rotation epochs stay verifiable, and how revocation is expressed.
- **Witness selection** (L3). Which transparency log or witness set, how
  inclusion proofs travel with the `.adf`, and behavior when the witness is
  unreachable.

## Trigger to revive

Build this when either becomes true:

1. **Agent transfer between parties becomes a product surface** — selling,
   delegating, or handing off an `.adf` where the receiver's trust in the
   sender is not assumable; or
2. **A compliance or audit consumer appears** that needs to verify agent history
   rather than take it on faith.

Absent one of those, the in-memory replay window is the correct amount of
machinery, and this document is the design that was deliberately not built.
