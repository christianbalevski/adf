---
type: reference
description: Connect Gmail through MCP, understand Google OAuth prerequisites, choose mailbox permissions, and troubleshoot authorization
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

Without MCP, the [gmail skill](../../skills/gmail/SKILL.md) is a direct REST
alternative: an agent lambda calls the Gmail API with your own OAuth client and
credentials kept in the agent's identity store. It uses the broader
`gmail.modify` grant; its no-send rule is an instruction, not enforcement.

An **email channel** is a separate choice: it delivers incoming email to the
agent as messages. Connecting a mailbox through MCP does not enable a channel,
start a polling loop, or authorize automatic replies.

## Direct Gmail setup

This path has no Composio dependency. It still requires your own Google Cloud
OAuth client; instructions make setup easier but do not remove Google's setup
requirements. The current catalog uses the community package
[`@gongrzhe/server-gmail-autoauth-mcp`](https://github.com/GongRzhe/Gmail-MCP-Server).
Its upstream repository was archived on March 3, 2026; ADF's catalog marks it
unverified. This article describes the existing integration, not a newly maintained
ADF Gmail server.

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
   Keep its prefilled auth command and credential paths. The catalog selects
   **Host** for this Settings flow: the server runs with your host user's access.
   If host access is blocked, resolve that deliberately in Compute settings;
   switching this form to a container is not an equivalent file-upload flow.
5. Use **Choose file…** next to `~/.gmail-mcp/gcp-oauth.keys.json` to select the
   downloaded JSON. Its original download filename is fine. Leave the optional
   `~/.gmail-mcp/credentials.json` slot empty for the server to create tokens.
   Do not paste either file into chat. Existing host files are preserved; a newly
   selected file does not overwrite an existing account's credentials.
6. Click **Connect**, complete Google sign-in yourself, check the account and
   requested permissions, and confirm completion in ADF's authorization dialog.
   Wait for successful connection and tool discovery, then save. **Save** alone
   does not store a selected credential file.
7. Enable **Available to agents** for this registration when you want it attachable
   (host registrations default to unavailable). Attach it in the agent's MCP
   configuration, or let an agent with `mcp_install` attach by the saved name:

   ```js
   mcp_install({ name: "gmail" })
   ```

Studio's host setup writes the credential files under the host home. Attaching
captures declared credentials into the agent's existing encrypted identity store;
the local server still needs materialized files while it runs. These files are
sensitive even though a portable copy is encrypted. Do not put them in ordinary
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

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Missing client JSON | Select the Desktop OAuth client file in the Gmail form and Connect. Check the runtime location rather than copying files into a different home. |
| Wrong account or old client still used | Settings preserves existing host files. Check the account and existing credential files locally; deliberately back up/replace them only if changing the connection is intended. |
| Google access denied | Check the signed-in account, test-user list, consent configuration, and Workspace policy. Repeating sign-in will not fix a missing test user or administrator restriction. |
| Gmail API disabled | Enable it in the same project that issued the OAuth client JSON. |
| Redirect mismatch or callback timeout | Check that the JSON is a Desktop client and the documented local callback is reachable on the server's runtime host. Do not substitute a third-party callback URL. Remote/headless runtimes need reachable authorization callbacks too. |
| Connection expires after a week | External apps in Testing receive refresh tokens that expire after seven days for Gmail scopes. Reauthorize, or review Google's production requirements for ongoing use; publishing is not a blanket verification exemption. |
| Saved server, no tools | Read the connection error, fix the prerequisite, then reconnect. From the agent use `mcp_restart({ name: "gmail" })`; renewed consent uses `mcp_install({ name: "gmail", auth: true })`. Avoid uninstalling as the first recovery step. |
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
