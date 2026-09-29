# Channels

Channels bring outside messages into an agent and let it answer there:
**Telegram, Discord, Slack, email and WhatsApp** ("channel adapters" in the
daemon API). As in ADF Studio (Settings → Channels), the channel types are
built in and everything else is per agent: the credentials live in that
agent's identity store, sealed under your owner identity, and switching a
channel on writes the agent's config.

## Add a channel

Select the agent, then:

```text
/channels add telegram      # or discord, slack, email, whatsapp
```

(`/channels add` alone lets you pick; the palette has "Add Telegram
channel" and the like.)

1. The dialog shows where the credentials come from (Telegram: create a bot
   with @BotFather and paste its token).
2. Paste each credential. It shows as dots with its length, never as text.
   Obvious mistakes (a token of the wrong shape, a Slack token in the wrong
   field) are caught before anything is sent.
3. `Enter` seals the credentials into the agent and switches the channel on.
   The dialog then follows it coming up: `connecting` → `connected`, or the
   channel's error.

Without a ready owner identity the identity dialog opens first; the channel
setup continues once it is ready. A stopped agent connects the channel when
it starts (`/start <agent>`).

**WhatsApp** needs no credentials: `Enter` switches it on and the phone pairs
by QR code. The terminal app cannot draw the QR: open
`imported/whatsapp/pairing-qr.png` from the agent's files (Files view), or
use ADF Studio, and scan it in WhatsApp → Linked Devices.

## Manage channels

`/channels` lists the selected agent's channels with their live state
(`● connected`, `○ connecting`, `✗ error`, `off`):

| Key | Action |
|---|---|
| `Enter` | Open one: state, error, `e` new credentials, `d` remove, `i` Inspect › Channels |
| `a` | Add |
| `d` | Remove (asks; its stored credentials are deleted) |

`/channels remove <channel>` removes one from the prompt. Editing never shows
stored values: each field says `set • (hidden)`, `set • locked` or
`not set`; an empty field keeps what is stored. When the agent's saved
credentials are locked, saving offers Unlock / Replace / Cancel: see
[Locked credentials](identity-and-security.md#locked-credentials).

Inspect › Channels shows the configured and live state too; Runtime ›
Channels lists the channel types available to agents.

One-shot: `adf adapters <agent>` (the agent's channels and their state),
`adf adapters` (registered on the daemon).
