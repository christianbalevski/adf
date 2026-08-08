# Design: Telegram Mini App form rendering (`render: 'webapp'`)

Status: **design** — not yet implemented. The `poll` / `compact` / `per_question`
renderers ship today; this documents the fourth strategy and, mainly, how the
public-URL requirement is configured and how an agent learns about it.

## Goal

A true single-block form on Telegram: text inputs, selects, checkboxes, and one
submit button — beyond what inline keyboards can express. Telegram's mechanism
for this is the **Mini App** (Web App): a bot button that opens an HTTPS page
inside the Telegram client.

## The two Telegram web-app flavors (this constrains the design)

| Launch surface | Data return path | Works in |
|---|---|---|
| **Reply-keyboard button** (`KeyboardButton.web_app`) | `Telegram.WebApp.sendData(json)` → arrives at the bot as a `message.web_app_data` update over the existing long-poll — **no extra endpoint needed** | Private chats only |
| Inline-keyboard button (`InlineKeyboardButton.web_app`) | `sendData` is NOT available — the page must POST to your own backend | Anywhere |

**Decision: use the reply-keyboard flavor.** Owner questionnaires are DM
conversations, the data path rides the connection we already hold, and no
submission endpoint has to be exposed. Group-chat webapp forms are out of scope
(they'd require a public POST endpoint on top of the public page — double the
infrastructure for a niche case; `compact` covers groups well).

## Rendering flow

1. Agent sends `content_type: application/vnd.adf.form+json` with
   `render: 'webapp'` in the form JSON.
2. The adapter renders the canonical form into a self-contained HTML page
   (shared template — no external assets; the same `FormHintSchema` drives
   `<select>`/checkbox/`<textarea>` inputs) and writes it into the agent's
   file store under `public/forms/{form_id}.html`, which the mesh server
   already serves at `/agents/{handle}/forms/{form_id}.html`.
3. The adapter sends one message with a reply-keyboard web-app button:
   `{ text: '📝 Fill out: <title>', web_app: { url: `${webapp_base_url}/agents/{handle}/forms/{form_id}.html` } }`.
4. The user taps, fills the form in the Telegram sheet, hits submit; the page
   calls `Telegram.WebApp.sendData(JSON.stringify(answers))`.
5. The bot receives `message.web_app_data`; the adapter parses it and ingests
   **one** inbound message carrying all answers
   (`source_context: { form_id, answers: [{question_id, answer_id|value}] }`),
   threaded to the form's outbox row like every other renderer.

## The public-URL problem — and how the agent specifies it

Telegram's client loads the page from the **user's phone**, so the URL must be
**public HTTPS**. Localhost/LAN mesh serving does not qualify. Two supported
shapes:

### A. Tunnel/relay in front of the mesh server (preferred — dynamic forms work)

The agent (or its owner) puts a public HTTPS hostname in front of the runtime's
mesh server — Cloudflare tunnel, a VPS reverse proxy, or an ADF relay. Then:

```jsonc
"adapters": {
  "telegram": {
    "config": { "webapp_base_url": "https://my-agent.example.com" }
  }
}
```

`webapp_base_url` is the public root that fronts the agent's serving routes —
i.e. `GET {webapp_base_url}/agents/{handle}/...` must reach this runtime. This
is the same reachability story as ADF public serving and `card.endpoints`
overrides, so an agent already served publicly needs zero extra setup.

### B. Static hosting (Vercel etc.) — fallback shape

An agent can deploy the generated form page to any static host. But
`sendData` still works (it's client-side), so static hosting is viable for the
DM flavor: the page needs no backend. The agent sets `webapp_base_url` to the
static host root and is responsible for uploading `forms/{form_id}.html`
there (e.g. via its own tooling). The adapter can't automate arbitrary hosts,
so shape A is the paved road; B is documented for agents that already ship a
site.

### How the agent *knows* — the self-teaching contract

Three layers, so no out-of-band knowledge is required:

1. **msg_send tool description** mentions that `render: 'webapp'` exists and
   requires `adapters.telegram.config.webapp_base_url`.
2. **The failure is the documentation**: when an agent requests
   `render: 'webapp'` without the config, the delivery FAILS (no silent
   fallback — same strict-contract rule as every other explicit render) with:
   `"render 'webapp' rejected: adapters.telegram.config.webapp_base_url is not
   configured — it must be a public HTTPS URL fronting this agent's serving
   routes (tunnel/relay/VPS; see docs/design/telegram-webapp-forms.md).
   Configure it with sys_update_config, or use render 'poll'/'compact'/
   'per_question'."`
   The agent reads that in the tool result and knows exactly what to do.
3. **Messaging guide** documents both shapes above.

## Security / correctness notes

- Validate `web_app_data` against the pending form (form_id must match a live
  outbox form; unknown ids are dropped) — `sendData` payloads are
  user-controlled.
- The generated page must be self-contained (inline CSS/JS) — Telegram's
  webview + third-party static hosts both argue against external assets.
- Form pages are public URLs; don't embed anything sensitive in the page
  (question text is visible to anyone with the URL). Use an unguessable path
  segment (`forms/{form_id}-{nonce}.html`) and delete the file when the form
  completes or expires.
- `web_app_data` arrives without Telegram's `WebAppInitData` hash when sent via
  `sendData` from a keyboard button — sender identity comes from the enclosing
  message update, which is authenticated by the Bot API itself. The DM policy
  check applies as with every other form interaction.

## Implementation checklist (when picked up)

- [ ] `render` enum: add `'webapp'` to `FormHintSchema` (kept out until implemented so agents can't select a dead mode)
- [ ] Shared HTML form template renderer (`form-webapp.ts`) driven by `FormHintSchema`
- [ ] Telegram adapter: eligibility check (private chat + `webapp_base_url` set), page write to `public/forms/`, reply-keyboard send, `message:web_app_data` handler, cleanup on completion
- [ ] Self-teaching fallback string (above) in the send path
- [ ] Tests: eligibility/fallback, page generation, web_app_data parse + policy + threading
- [ ] messaging.md section replacing the pointer to this doc
