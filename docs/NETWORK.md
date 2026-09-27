# Network traffic

Every outbound connection ADF Studio and the daemon make, who starts it, and how
to turn it off. ADF ships **no analytics, telemetry, or crash-reporting SDK**;
nothing below carries agent content, owner identity, or usage data to the ADF
project.

Verify it yourself: run Studio behind a logging proxy (mitmproxy, Little Snitch,
Wireshark) with no agents running. After the two opt-outs below are off, an idle
Studio makes **no** outbound requests.

## 1. Traffic Studio starts on its own

These are the only requests the app makes without you or an agent asking. Both
have an off switch under **Settings → General → Privacy**.

| What | Endpoint | When | Carries | Off switch |
|---|---|---|---|---|
| Update check | `github.com/christianbalevski/adf/releases` (electron-updater `latest*.yml`) | Packaged builds only: 15 s after launch, then every 6 h. Nothing downloads until you click the update badge. | App version + platform in the request path/User-Agent | **Check for updates** (`updateChecksEnabled: false`) |
| MCP server registry | `raw.githubusercontent.com/christianbalevski/adf/main/mcp-registry.json` | First time you open the MCP registry browser, then every 24 h while the app runs. | Nothing (plain GET, `If-None-Match`) | **Live catalogs** (`remoteCatalogsEnabled: false`) — serves the bundled copy and the last fetched copy |
| Agent registry (template gallery) | `raw.githubusercontent.com/christianbalevski/adf/main/registry/…` | When you open the gallery, and when you pick a template not bundled with the build (downloaded file is SHA-256-checked against the index). | Nothing | **Live catalogs** — gallery shows bundled + cached entries; remote-only templates refuse to download |

Unpackaged (`npm run dev`) builds never run the update check. The headless
daemon runs none of the three.

## 2. Traffic you configure

Requests that exist only because you set something up. None happen by default.

| What | Endpoint | Configured in |
|---|---|---|
| Model providers | The provider's base URL (Anthropic, OpenAI, OpenRouter, any OpenAI-compatible URL, local models) | Settings → Providers, or per-agent provider config |
| Subscription sign-in | `auth.openai.com` / `chatgpt.com`, `auth.x.ai` / `api.x.ai` | Settings → Providers (ChatGPT / xAI subscription) |
| Skill catalogs | Each URL in the skill-catalog list (the first-party one is a default you can remove) | Settings → Skills |
| MCP servers | Whatever the server connects to; `npx`/`uvx` packages come from the npm / PyPI registries | Settings → MCP Servers, agent config |
| `uv` binary | `github.com/astral-sh/uv/releases` — downloaded once, only when a Python MCP server or package needs it and no `uv` is installed | Adding a Python MCP server |
| Sandbox packages | npm registry | Settings → Packages |
| Channel adapters | Telegram, Discord, Slack, email servers | Settings → Channels, agent config |
| Mesh | LAN peers (mDNS) when LAN access is on; Tailscale peers when tailnet discovery is on; manual peer hosts | Settings → Networking |
| Containers | Container image registry (default `docker.io`) on first use of isolated compute | Settings → Compute |

## 3. Traffic agents start

An agent reaches the network only through tools you enable: `sys_fetch`,
`msg_send`, WebSocket tools, MCP tools, served API routes, and code execution
with network access. The base prompt points a new agent at the ADF docs and
first-party skill catalog on `raw.githubusercontent.com` (public GETs; no agent
content is sent).

Owner controls, enforced by the runtime below the model:

- **Per-tool enable/disable and approval gates** — `restricted` tools wait for
  your approval ([tools](guides/tools.md)).
- **Outbound middleware** — runs before every outbound message and HTTP request
  and can rewrite or block by recipient or domain ([middleware](guides/middleware.md)).
- **Locked fields** — settings the agent cannot change about itself
  ([settings](guides/settings.md#security-guard--locked-fields)).

## Checking what a running agent is configured with

The config an agent runs with is the config stored in its `.adf` file
(`adf_config`) plus the app-level settings it inherits. See
[Effective runtime config](guides/security-and-identity.md#effective-runtime-config).
