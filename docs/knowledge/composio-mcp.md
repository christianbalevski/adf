---
type: reference
description: Connect Composio's hosted MCP server over HTTP OAuth, what its tools expose to ADF's per-tool permissions, and the Gmail connection failure diagnosed so far
see_also:
  - ../guides/mcp-integration.md — HTTP MCP servers, OAuth sign-in, credentials, and tool controls
  - gmail-setup.md — a direct Gmail MCP connection with per-action tools
---

# Composio MCP

Tested on 2026-10-29 in the local Studio development build. No ADF schema,
agent data-model, or tool-definition changes were needed.

## Live observations

- Added a custom HTTP registration named `composio-test` for
  `https://connect.composio.dev/mcp`, with OAuth enabled and **Available to
  agents** off. It is saved in local runtime settings, not attached to an agent.
- The custom HTTP form lacked a way to enable the existing `oauth` field.
  Added a browser sign-in checkbox; the existing registration test and OAuth
  services handle the rest.
- Connect opened Composio sign-in, followed by Google basic-profile sign-in,
  then Composio's **ADF Studio would like access to your account** consent.
  The owner approved that last step. The callback returned to Studio's local
  loopback listener and tool discovery succeeded.
- Composio reported server version `0.1.0` and **11 tools**. A second Connect
  succeeded without another browser consent prompt. This verifies stored-token
  reuse; it does not prove a real token-expiry refresh or daemon handoff.
- A separate Gmail **Connect account** attempt in Composio's Apps UI returned
  **That request couldn't be completed** before reaching Google mailbox consent.
  Gmail access and mail operations were not verified. No mail was read, sent,
  changed, or deleted in this trial.

Discovered tools:

```text
COMPOSIO_GET_TOOL_SCHEMAS
COMPOSIO_MANAGE_CONNECTIONS
COMPOSIO_MULTI_EXECUTE_TOOL
COMPOSIO_REMOTE_BASH_TOOL
COMPOSIO_REMOTE_WORKBENCH
COMPOSIO_SEARCH_TOOLS
COMPOSIO_SUBMIT_FEEDBACK
COMPOSIO_WAIT_FOR_CONNECTIONS
COMPOSIO_MANAGE_SKILL
COMPOSIO_SEARCH_SKILLS
COMPOSIO_USE_SKILL
```

## Permission behavior

Code inspection and the existing tool-sync tests establish that newly discovered
MCP tools receive ordinary ADF tool declarations: enabled and visible, with human
approval required by default (`mcp.new_tools_restricted` defaults to true).
Unchanged reconnects retain user choices; changed tool schemas are disabled and
restricted for review. These gates were tested with fixtures, not by attaching
the live Composio connection to a running agent.

For this shared endpoint, the declaration is for a Composio tool such as
`COMPOSIO_MULTI_EXECUTE_TOOL`, not each nested Gmail action. Approving that tool
permanently would cover its other actions too. ADF cannot independently allow
email reads and require approval for sends through that same declaration.
Remote Bash and Python execution are additional tool surfaces, not required
merely to search mail. A conservative agent trial would disable those tools and
keep the generic executor and connection-management tools restricted.

Composio also documents a **direct-tools session preset** that exposes selected
Gmail actions as separate MCP tools. That is the better candidate for granular
ADF permissions. It needs developer-side session provisioning and credentials;
it is not a parameter on the shared Connect URL. ADF's existing HTTP URL and
environment-backed header configuration can represent the resulting connection.
Compatibility and lifecycle behavior still need a live trial.

## Validation and next step

The MCP settings, HTTP OAuth, registration-test, and tool-sync suites passed:
134 tests. Targeted ESLint and `git diff --check` passed. Tests ran under the
repository's Electron runtime because the shell's Node 22.18.0 is rejected by
ADF's existing runtime security check.

### Gmail failure diagnosed

The owner supplied the response from `consumer.initiateConnection`. Although
the batch transport returns HTTP 200, the operation returns JSON-RPC error
`-32600`, `BAD_REQUEST`, logical HTTP 400, and this field validation error:

```text
callbackUrl: callbackUrl must use the dashboard origin
isUpstreamServerError: false
```

This is Composio's connection-initiation callback validation, before Google's
mailbox OAuth flow. It is not the ADF-to-Composio loopback callback, which already
succeeded. The failing page was on `connect.composio.dev`. A mismatch between
that host's generated callback and the server's configured dashboard origin is
a plausible cause; the exact callback value and server configuration have not
been inspected. Do not describe the problem as a Google scope rejection.

The next diagnostic is the same **For You** connection flow on
`dashboard.composio.dev`, keeping the same workspace and consumer context.
This host serves the application (an unauthenticated request redirects to
`/login`), but the authenticated workaround has not been verified. Do not create
a separate Platform connection: consumer and developer connections are isolated.
Alternatively, Connect's `COMPOSIO_MANAGE_CONNECTIONS` can initiate the supported
in-client authorization path; it has not yet been tried for this account.

### User-owned accounts and individual tools

The product decision is to use each user's own Composio account for now.
Composio documents sessions in an organization's **consumer project**, where
the existing For You connections live. A user API key and explicit organization
and project scope can create a session there; ADF need not own a shared Composio
account or Google OAuth app.

Combining that consumer-scoped session with the direct-tools preset and an
explicit Gmail tool allowlist should expose separate tools over MCP. The SDK
exports the session URL and headers. ADF already represents them using `url`,
`header_env`, the credential store, `available_tools`, and ordinary per-tool
declarations. No schema migration or Gmail-specific agent fields are necessary.

This is documented compatibility, not an authenticated direct-tools result.
The existing Connect browser OAuth grant is not documented as a session-creation
credential. A Composio **user API key** is a different credential from both the
Connect consumer key and a Platform project key. Its potentially broad scope
must not be hidden behind a claim that the Gmail tool allowlist narrows the key.
For a user-key session the exported MCP headers carry that key and scope, so
ADF must use its existing encrypted credential path, never literal secret
headers in the agent config.

The simple shared Connect endpoint remains the least setup, but does not expose
separate Gmail declarations. A UI-only list of Gmail permissions over its broad
executor would not enforce them. An alternative would require an actual MCP
adapter that exposes fixed Gmail schemas, dispatches only the corresponding
allowed action, and excludes generic execution, Bash, and workbench paths.
That adapter is not implemented by this trial.

Connecting mailbox tools remains separate from enabling the IMAP/SMTP incoming
email channel. No live Gmail connection or mail action is yet verified.

Sources:

- [Composio Connect](https://docs.composio.dev/docs/composio-connect)
- [Sessions via MCP, including direct tools](https://docs.composio.dev/docs/sessions-via-mcp)
- [Consumer project sessions](https://docs.composio.dev/docs/consumer-agents)
- [Consumer and developer project boundaries](https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection)
- [Direct-tools preset](https://docs.composio.dev/docs/configuring-sessions)

The public Connect guide listed seven meta-tools at the time of this trial;
the live server returned the eleven names above.
