# Channels — Agent Reference

The contract reference for sending and receiving over channel adapters
(telegram, slack, whatsapp, discord, email). Dense by design — this is the
doc `msg_send` links to. Human setup instructions (credentials, app
manifests, pairing) live in [messaging.md](messaging.md#channel-adapters).

## Addressing

First contact uses `{adapter}:{platform-id}` as `recipient` (no `address`):

| Adapter | Recipient format | Notes |
|---------|------------------|-------|
| telegram | `telegram:123456789` | User or chat id (groups are negative ids) |
| slack | `slack:C0123ABC` / `slack:U0123ABC` | Channel id, or user id (DM conversation opened automatically) |
| whatsapp | `whatsapp:15551234567` / `whatsapp:<id>@g.us` | Bare number (digits) or full JID; groups end `@g.us` |
| discord | `discord:<channel_id>` | Channel id for both DMs and guild channels |
| email | `email:person@example.com` | |

**Replies: prefer `parent_id`.** `msg_send(parent_id, content)` resolves the
adapter, chat, and platform threading (Telegram reply, Slack thread, WhatsApp
quote, email `Re:` + References) from the parent message — no recipient
needed, no threading knowledge required.

## Content modes

`content` + optional `content_type` on `msg_send`. Three modes:

| Mode | `content_type` | telegram | slack | whatsapp | discord | email | mesh (agent) |
|------|----------------|----------|-------|----------|---------|-------|--------------|
| Markdown (default) | *(omit)* | native (HTML) | native (mrkdwn) | native | native | text + HTML body | as-is |
| HTML | `text/html` | tag subset (sanitized) | → plain text | → plain text | → plain text | **full HTML body** | as-is |
| Form | `application/vnd.adf.form+json` | **native surfaces** (below) | → text questionnaire | → text questionnaire | → text questionnaire | → text questionnaire | as-is (parse `content`) |

Rules of thumb: markdown everywhere by default; `text/html` only toward
email (or telegram when the subset suffices); forms only toward telegram —
on other channels write a normal message and parse the reply yourself.

Contract violations (malformed form JSON, missing/ineligible `render`) FAIL
the send with the precise reason — nothing is silently degraded. `msg_send`
validates at send time, so you get the error before delivery.

## Forms (`application/vnd.adf.form+json`)

`content` is the form JSON:

```jsonc
{
  "id": "checkin1",                  // [a-z0-9_-], <=16 chars
  "title": "Sprint check-in",        // optional, <=200 chars
  "render": "compact",               // REQUIRED — you choose the surface (below)
  "questions": [                     // 1-10 questions; ids [a-z0-9_-] <=8 chars
    { "id": "q1", "text": "Status?", "type": "choice",
      "options": [ { "id": "ok", "label": "On track" }, { "id": "risk", "label": "At risk" } ] },
    { "id": "q2", "text": "Anything else?", "type": "text" }
  ],
  "fallback_text": "..."             // optional: overrides the auto text questionnaire on non-native adapters
}
```

Question types: `choice` (single select, 1-12 options), `multi` (multi
select + Done), `text` (free reply). Option labels ≤100 chars.

### `render` — the Telegram surface you choose

| `render` | Shape contract | You get |
|----------|----------------|---------|
| `poll` | Exactly 1 `choice`/`multi` question, 2–10 options, title+question ≤300 chars, labels ≤100 | A native Telegram poll (single block). Vote changes re-ingest — latest wins; retractions ignored. |
| `compact` | All questions `choice`/`multi` | ONE message, one combined keyboard (`1 ·`, `2 ·` row prefixes). Answered questions collapse to ✓; message finalizes into a summary when all are answered. |
| `per_question` | Any shape | One message per question; `text` questions prompt for a reply. |

A shape that doesn't satisfy your chosen `render` fails the send with the
reason (e.g. `render 'poll' rejected: has 3 questions (polls hold exactly
one)`). Non-telegram adapters render the text questionnaire regardless of
`render`. A `webapp` surface (true single-block form with text inputs) is
designed but not yet implemented — see `docs/design/telegram-webapp-forms.md`.

### Answers

Each answer arrives as a normal inbox message threaded to your form:

```jsonc
{
  "content": "On track",                        // human-readable answer
  "parent_id": "<your form's outbox id>",
  "source_context": {
    "form_id": "checkin1", "question_id": "q1",
    "answer_id": "ok",                          // or array for multi
    "answer_value": "On track",
    "chat_id": ..., "reply_to_message_id": ...
  }
}
```

Free-text answers ride the normal reply path (same `parent_id`, no
`form_id` keys — correlate by parent). Aggregation is YOUR job: collect
until every `question_id` you sent has an answer; on re-votes/duplicate
answers, latest wins.

## Inbound context

Channel messages carry:

- `source` — which adapter (`telegram`, `slack`, ...).
- `source_context` — reply-routing keys (echoed onto your `parent_id`
  replies). Per platform: telegram `{chat_id, message_id, chat_type,
  reply_to_message_id}`; slack `{chat_id, channel_type, team_id, message_id
  (ts), thread_ts, reply_to_message_id}`; whatsapp `{chat_id (JID),
  chat_type, message_id, sender_jid, reply_to_message_id}`; discord
  `{channel_id, guild_id, message_id, channel_type, reply_to_message_id}`;
  email `{message_id, to[], cc[], in_reply_to, references[]}`.
- `meta.group` — descriptive group context when in a group chat: `{platform,
  chat_id, chat_type, title, description, participants[] (≤20, {id, name?,
  role?}), participant_count, participants_truncated, participants_scope}`.
  `participants_scope` tells you what the list is: `all` (whatsapp, email),
  `admins` (telegram — Bot API can't list members), `mentions` (discord),
  `page` (slack, first 20).
- `original_message` — the raw platform payload; stripped from `msg_read`
  by default, request with `msg_read({ include_original: true })`.

## Live chat lookup — `adf.chat_info` (from sandbox code)

```javascript
const info = await adf.chat_info({ adapter: 'slack', chat_id: 'C0123ABC', limit: 50 })
// { platform, chat_id, chat_type, title, description, participant_count,
//   participants[], participants_truncated, participants_scope, fetched_at }
// or { supported: false, reason }
```

Read-only. Same platform limits as `meta.group` (telegram → admins only;
discord full roster needs a privileged intent and is not yet functional;
email unsupported — recipients are in `source_context.to`/`cc`).

## Delivery hints (`message_meta`) — email only

`message_meta` is for delivery routing, never content: `{ reply_all: true }`,
`{ cc: [...] }`, `{ bcc: [...] }` on email replies. Other adapters ignore it.

## Attachments

`attachments: ["path/in/my/files.pdf"]` on `msg_send` uploads from your file
store (per-platform size caps apply; WAV audio becomes a voice note on
telegram/whatsapp when ffmpeg is available). Inbound attachments land in
`imported/{adapter}/...` in your file store, listed on the inbox row.
