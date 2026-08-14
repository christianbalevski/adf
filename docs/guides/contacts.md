---
type: guide
description: Agent-level contact management patterns — what to remember, whom to trust, how to route; runtime primitives vs agent policy
see_also:
  - messaging.md — the DID+address delivery model contacts resolve to
  - lan-discovery.md — saving discovered LAN peers for persistent addressing
---

# Contacts

Contact management is an agent-level concern in ADF, not a runtime primitive. The runtime provides mechanism; agents compose the policy. This keeps the schema minimal and lets each agent decide what it remembers, how it trusts, and how it routes.

## The primitives

Three things the runtime provides:

1. **DIDs and addresses.** `msg_send` accepts them directly. If you have them, you can send.
2. **Agent cards.** The portable identity object — signed, self-describing, fetchable over HTTP at `GET /agents/{handle}/card`, and included in the return of `agent_discover`. Cards travel in message payloads when agents introduce themselves or introduce others.
3. **Middleware hooks.** [Middleware](middleware.md) lambdas configured at `security.middleware.inbox` and `security.middleware.outbox` let you rewrite messages before they land or depart — the right place to resolve a handle into a DID+address, or to auto-save a sender. These are guard paths: owner-installed only, never agent-writable, and by default (`security.require_middleware_authorization: true`) the lambda file must be [authorized](middleware.md#middleware-authorization) or the middleware is skipped.

## When you can skip contacts entirely

If the agent always replies via `parent_id`, no contacts book is needed. The runtime resolves `recipient` and `address` from the referenced inbox row — specifically, `from` and `reply_to`. Respond-only agents can run their entire lifetime this way.

## Pattern A: a plain file

Store a JSON or Markdown file in the agent's workspace. Let the LLM read it on turn and pass the DID+address straight to `msg_send`.

```json
// contacts.json
[
  { "handle": "monitor", "did": "did:key:z6Mk...", "address": "http://127.0.0.1:7295/agents/monitor/inbox" }
]
```

Works well for small, stable contact lists. No lambdas, no tables.

## Pattern B: local table + outbox middleware lambda

For larger or dynamic contact sets, store them in a `local_contacts` table you own, and use an outbox middleware lambda to rewrite bare-handle recipients into DID+address before the message leaves. Patterns B and C both depend on that middleware — the owner must install it first.

```typescript
// outbox middleware — handle → DID+address resolution
async function onSend(ctx, next) {
  const msg = ctx.message
  if (msg.recipient && !msg.recipient.startsWith('did:') && !msg.recipient.includes(':')) {
    const rows = await adf.db_query(
      `SELECT did, address FROM local_contacts WHERE handle = ? LIMIT 1`,
      [msg.recipient]
    )
    if (rows[0]) {
      msg.recipient = rows[0].did
      ctx.transport.address = ctx.transport.address || rows[0].address
    } else {
      throw new Error(`Unknown contact: ${msg.recipient}`)
    }
  }
  return next(ctx)
}
```

You manage the table yourself — create it with `db_execute`, insert with your own schema (`handle`, `did`, `address`, `trust`, whatever fields you need).

## Pattern C: auto-save on receive + periodic card refresh

Use an `on_inbox` lambda to extract the sender's DID and `reply_to` from every incoming message and upsert into your contacts table. A timer-driven lambda re-fetches each contact's card from `endpoints.card` to refresh capabilities, public keys, or routing policies.

```typescript
// on_inbox middleware — auto-save new senders
async function onInbox(msg, next) {
  if (msg.from && msg.reply_to) {
    await adf.db_execute(
      `INSERT OR IGNORE INTO local_contacts (did, address, first_seen_at)
       VALUES (?, ?, ?)`,
      [msg.from, msg.reply_to, Date.now()]
    )
  }
  return next(msg)
}
```

Combine with a timer that walks `local_contacts`, calls `sys_fetch` on each `endpoints.card` URL, and updates the stored fields.

## Which to pick

Start with Pattern A. Move to Pattern B when you outgrow a file — typically when resolution needs to happen inside a lambda rather than in chat. Reach for Pattern C only if you need trust tracking, capability discovery, or reachability state across many contacts.

The runtime will never save a contact for you. That is deliberate: every entry in your contacts store reflects a decision you made, not a side effect of someone sending you a message.
