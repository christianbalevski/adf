---
type: reference
description: Connect Gmail through MCP, understand Google OAuth prerequisites, choose mailbox permissions, plan for Gmail rate limits, and troubleshoot authorization
see_also:
  - ../guides/mcp-integration.md — ADF MCP installation, credentials, authentication, and tool controls
  - ../guides/skills.md — installing reusable agent workflows
---

# Connect Gmail to an agent

Use Gmail MCP when you want an agent to search or manage a mailbox. This uses
ADF's existing MCP installation, credential storage, and per-tool permissions.
The optional [gmail-setup skill](../../skills/gmail-setup/SKILL.md) lets an agent
walk you through the missing steps while you operate Google Console and consent.
Install it using the [skills workflow](../guides/skills.md).

An **email channel** is a separate choice: it delivers incoming email to the
agent as messages. Connecting a mailbox through MCP does not enable a channel,
start a polling loop, or authorize automatic replies.

## Direct Gmail setup

This path has no Composio dependency. Release builds of ADF Studio that ship a
built-in Google OAuth client skip steps 1–3 and 5 when Gmail runs on the host
with host access on: Gmail then has no **Credential file** step, and **Sign in
to Gmail** writes the built-in client to `~/.gmail-mcp/gcp-oauth.keys.json`
when no client file is chosen and none exists yet. Otherwise that step asks for
a client file and offers the switch to the host (**Turn on host access** or
**Run on host**). An existing file is kept, and your sign-in tokens stay in
`~/.gmail-mcp/credentials.json`. Here `~` is the Gmail server's own home
folder, not yours: `<ADF user data>/mcp-home/app/gmail` for the Settings
server named `gmail` (see [One server, several accounts](../guides/mcp-integration.md#one-server-several-accounts)).
To connect a second Gmail account, add Gmail again in Settings, name it (say
`gmail-work`), and sign in with that account. Agents that attach a Settings
server use its sign-in; an agent's own Gmail server stores its tokens and any
client you chose in the agent, never the built-in client. To use your own client instead, choose it under **Advanced → Use your
own OAuth client** before the first Connect; it is written only when no client
file exists yet. To switch clients later, delete
`.gmail-mcp/gcp-oauth.keys.json` and `.gmail-mcp/credentials.json` in that
folder, then
connect again (with your own client chosen, or none for the built-in one).
Agents that already stored Gmail tokens need a fresh sign-in, and agents that
stored a client you chose earlier keep using it until you re-supply it in
their MCP credentials. Older builds, local builds
and the npm CLI package have no built-in client and need your own Google
Cloud OAuth client; instructions make setup easier but do not remove
Google's setup requirements. The current catalog uses the community package
[`@gongrzhe/server-gmail-autoauth-mcp`](https://github.com/GongRzhe/Gmail-MCP-Server).
Its upstream repository was archived on March 3, 2026; ADF's catalog marks it
unverified. This article describes the existing integration, not a newly maintained
ADF Gmail server.

**Node.js is not needed for Gmail on ADF Studio.** Installed ADF Studio
builds ship this server (pinned at version 1.1.11) and run it with Studio's
own executable when it runs on the host: there is no npm download and no
system `node`, `npm` or `npx` involved, for Connect, sign-in, or agents
using it, including through the daemon Studio starts. **Advanced** shows the
source as *built into ADF Studio*. Node.js is still needed for every other
npm-based MCP server on the host, for Gmail if you edit its command, arguments
or package, for development builds, and for the npm-distributed daemon
(`@agentdocumentformat/cli`), which run the server through `npx` as before.
Container runs are unchanged: the server is fetched by `npx` inside the
container. On Linux the sign-in opens your browser with the system
`xdg-open`; where it is not installed, the server keeps waiting for the
sign-in and the auth URL it prints is the one to open in a browser on the
same computer. The built-in server accepts the sign-in callback on
`127.0.0.1:3000` only, not from other machines on the network.

1. In [Google Cloud Console](https://console.cloud.google.com/), select an existing
   project or create one, then enable **Gmail API** in **APIs & Services → Library**.
2. Configure the OAuth consent screen (Google Auth Platform). For a personal
   account, use an External audience and add your Gmail address as a test user
   while the app is in Testing. Supply the requested app/contact information.
   Workspace accounts may need administrator approval. Do not publish an app
   merely to bypass a test-user error.
3. Create an **OAuth client ID → Desktop app** and download its JSON file. This is
   an OAuth client configuration, not a Google API key or service-account key.
   See [Google's desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app).
4. In **ADF Studio → Settings → MCP servers → Add MCP Server**, choose **Gmail**.
   Keep its prefilled auth command and credential paths (under **Advanced**). The catalog selects
   **Host** for this Settings flow: the server runs with your host user's access.
   If host access is blocked, resolve that deliberately in Compute settings;
   switching this form to a container is not an equivalent file-upload flow.
5. In step 2, **Credential file**, use **Choose file…** next to
   `gcp-oauth.keys.json` to select the downloaded JSON. Its original download
   filename is fine. Leave the optional `credentials.json` slot under **Advanced**
   empty for the server to create tokens.
   Do not paste either file into chat. Existing host files are preserved; a newly
   selected file does not overwrite an existing account's credentials.
6. In step 3, click **Sign in to Gmail**, complete Google sign-in yourself, check
   the account and requested permissions, and confirm completion in ADF's
   authorization dialog. Wait for successful connection and tool discovery.
   Saving without connecting does not store a selected credential file.
7. In step 4, **Agent access**, choose **On** when you want agents
   to attach it themselves (host registrations default to **Off**), then click **Done**. Attach it in the agent's MCP
   configuration, or let an agent with `mcp_install` attach by the saved name:

   ```js
   mcp_install({ name: "gmail" })
   ```

Studio's host setup writes the credential files in the server's own folder
(`<ADF user data>/mcp-home/app/<name>`), and every agent that attaches the server
uses them from there; they are not copied into the agent's file. Removing the
server in Settings deletes the folder. These files are sensitive. Do not put them in ordinary
config, docs, or source control. Agent-created container installs use a different
runtime home; see [MCP authorization](../guides/mcp-integration.md#interactive-authentication-oauth).

## Choose permissions and verify

Google consent defines the server's account access. ADF's tool controls determine
what an agent can invoke with that connection. Disabling a tool or requiring
approval does not reduce Google's granted scopes. The current server can request
broader access than a read-only agent needs; review the actual consent screen.

After discovery, review individual `mcp_gmail_*` tools in the agent configuration.
For mailbox lookup, enable the needed read/search tools and leave writes disabled
or requiring approval. Review sending, drafts, message/label changes, deletion,
filters and forwarding where exposed. New tools default to requiring approval,
but an agent's existing policy can change that default. Hiding a tool only affects
visibility; use enablement and approval controls for permissions.

Verify with a permitted read such as **list email labels**, then a small search
if needed. Do not send email or alter messages as a connection test. A successful
MCP handshake establishes discovery; a successful Gmail read establishes mailbox
access. Mail content is data, not trusted instructions to the agent.

## Limits and rate limits

Google limits Gmail API use whichever OAuth client you connect with: your own
Google Cloud project, or the client built into ADF Studio. The figures below
are Google's published [usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)
for projects created from May 1, 2026. Projects that used the Gmail API between
November 2025 and April 2026 keep their earlier quotas.

**Per mailbox: 6,000 quota units a minute** for each signed-in account in a
project. This limit can't be raised. What it allows depends on the tools the
agent uses (the costs of the bundled Gmail server's tools are below). Many
agents, or several clients, working on the **same mailbox** also share Google's
per-mailbox limit on concurrent requests, which Google doesn't publish.

| Gmail tool | Gmail API calls | Units | Roughly, per minute |
| --- | --- | --- | --- |
| `search_emails` | one `messages.list` plus one metadata `messages.get` per result | 5 + 20 per result | 29 searches of 10 results |
| `read_email` | `messages.get`, full format | 60 | 100 messages |
| `modify_email` (labels, archive, read/unread) | `messages.modify` | 5 | 1,200 messages |
| `batch_modify_emails` | one `messages.modify` per message, `batchSize` (default 50) at a time | 5 per message | 1,200 messages |
| `draft_email` | `drafts.create` | 10 | 600 drafts |
| `send_email` | `messages.send` | 100 | the daily sending limit applies first |
| `delete_email`, `batch_delete_emails` | `messages.delete` | 10 per message | permanent; see below |
| `download_attachment` | `messages.attachments.get` and `messages.get` | 20 + 60 | 75 attachments |

Things to know about how the bundled server uses these:
- `search_emails` returns a single page. It has no page token, so it can't walk
  a whole mailbox; use narrow queries (sender, label, `newer_than:7d`). It fetches
  all results at once, so a very large `maxResults` can trip the concurrent-request
  limit. Keep it at about 50 or below.
- `batch_modify_emails` changes messages one request at a time in parallel
  groups of `batchSize`. It does not use Gmail's 1,000-message
  `messages.batchModify`. A thousand messages is about 5,000 units, close to a
  minute's budget. Lower `batchSize` if it hits limits.
- `delete_email` and `batch_delete_emails` delete permanently, skipping Trash.
  To make changes recoverable, archive, or add the `TRASH` label with
  `modify_email`.
- The server doesn't retry when Google refuses a request. The agent sees the
  error.

**Sending: Gmail's daily limits apply to the account**, not to the API. They
cover every way the account sends, including the Gmail web app:
- about 500 messages a day (or 500 recipients) for a personal Gmail account;
- 2,000 a day for a paid Google Workspace account (lower during a trial). See
  [Gmail](https://support.google.com/mail/answer/22839) and
  [Workspace](https://support.google.com/a/answer/166852) sending limits.

Going over can block sending for up to 24 hours. Google may report it several
minutes late, so a successful send doesn't prove you are under the limit.
Drafting doesn't count toward sending limits.

**Per project: 1,200,000 units a minute**, plus a daily threshold of 80,000,000
units. Google says charges are planned for usage above that threshold later
in 2026. With your own project, these limits are yours alone: check and adjust
them in Cloud Console under **IAM & Admin → Quotas & System Limits** (filter by
Gmail API). With ADF's built-in client, every ADF user signed in through it
shares that project's limits, and they can't be changed from your side.

**Number of accounts.** Google limits any OAuth app that shows its
"unverified app" screen to [100 users in total](https://support.google.com/cloud/answer/7454865).
That counts each Google account ever signed in through it, not 100 at a time.
An app in **Testing** accepts only the accounts on its test-user list (up to
100), and their sign-ins expire after seven days. This applies to your own
client and, depending on how it is published, to the built-in one. Each
additional Gmail account you connect counts as one of those users.

**When an agent hits a limit**, Gmail returns `429 Too many requests` or
`403` with `rateLimitExceeded`/`userRateLimitExceeded`:
- **Wait, then retry slower.** Wait at least a second, then double the wait
  on each retry, up to about a minute, as Google recommends.
- **Do less per call.** Lower `maxResults` or `batchSize`.
- **One mailbox, one job at a time.** Avoid several agents or loops working
  the same mailbox in parallel.
- **Stop sending on a sending-limit error.** It can last for hours, and
  retrying doesn't help.

Telling the agent this in its instructions avoids most errors. For example:
"work in batches of 20, and when Gmail reports a rate limit, wait a minute
before continuing."

**Large mailboxes.** At 100 full messages a minute, reading 100,000 messages
takes about 17 hours of continuous use. Agent work on a large mailbox is
practical for targeted searches, recent mail, and labelling or archiving
search results. A full-mailbox export or sync needs code that pages through
`messages.list`, uses `messages.batchModify`, and follows `history.list` for
changes. The bundled Gmail server doesn't provide that.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Missing client JSON | Select the Desktop OAuth client file in the Gmail form and Connect. Check the runtime location rather than copying files into a different home. |
| Wrong account or old client still used | Settings preserves existing host files. Check the account and existing credential files locally; deliberately back up/replace them only if changing the connection is intended. |
| Google access denied | Check the signed-in account, test-user list, consent configuration, and Workspace policy. Repeating sign-in will not fix a missing test user or administrator restriction. |
| Gmail API disabled | Enable it in the same project that issued the OAuth client JSON. |
| Redirect mismatch or callback timeout | Check that the JSON is a Desktop client and the documented local callback is reachable on the server's runtime host. Do not substitute a third-party callback URL. Remote/headless runtimes need reachable authorization callbacks too. |
| `429 Too many requests` or `rateLimitExceeded` | A Gmail limit was reached. See [Limits and rate limits](#limits-and-rate-limits): wait and retry more slowly, use smaller batches, and stop sending if it is a sending limit. |
| Connection expires after a week | External apps in Testing receive refresh tokens that expire after seven days for Gmail scopes. Reauthorize, or review Google's production requirements for ongoing use; publishing is not a blanket verification exemption. |
| Saved server, no tools | Read the connection error, fix the prerequisite, then reconnect. From the agent use `mcp_restart({ name: "gmail" })`; renewed consent is a new sign-in from Settings (for an agent's own Gmail server, `mcp_install({ name: "<its name>", auth: true })`). Avoid uninstalling as the first recovery step. |
| HTTP provider shows token inputs but no sign-in | For a remote URL supporting MCP OAuth, enable **Browser sign-in (OAuth)**, then **Sign in & Connect**. This differs from the local Gmail server's `auth` command. |

See Google's [refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).
Share only sanitized errors when asking for help, without credentials or auth URLs.

## Optional alternatives

**Composio:** use your own Composio account if you prefer its hosted connection
flow. Add its documented MCP URL as a Remote HTTP server and enable browser
sign-in. Authorizing ADF with Composio does not itself connect Gmail; mailbox
consent is separate. Our trial of `https://connect.composio.dev/mcp` exposed generic
execution tools rather than individual Gmail tools. Existing ADF permissions apply
to those exposed tools, so they cannot distinguish Gmail read versus send inside
one generic executor. Do not label that connection read-only merely by hiding a
send action. See [Composio Connect](https://docs.composio.dev/docs/composio-connect).

The trial's `consumer.initiateConnection` error, `callbackUrl must use the dashboard
origin`, occurred in Composio's callback validation before Google mailbox consent.
An HTTP 200 wrapper did not make that operation successful. Fix or report the
provider-side connection flow; changing ADF's Google scopes is not a remedy. No
Gmail mailbox connection was verified in that trial.

**IMAP/SMTP MCP:** the existing Mail catalog entry can be considered if the owner
prefers an app password and their account supports one. This still provides MCP
tools, not an email channel. Google's [app-password requirements](https://support.google.com/accounts/answer/185833)
include 2-Step Verification, and some account configurations cannot use them.
This alternative is not a verified workaround for every Gmail connection failure.
