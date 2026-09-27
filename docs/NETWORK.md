# Network traffic

Every outbound connection ADF Studio and the daemon make, who starts it, and how
to turn it off. ADF ships **no analytics or telemetry SDK**. Electron's crash
reporter writes minidumps to `userData/crashes` locally; uploading is disabled.
Nothing below carries agent content or usage data to the ADF project.

Verify it yourself: run Studio behind a logging proxy (mitmproxy, Little Snitch,
Wireshark) with no agents running. With the three **Privacy** switches below
off and the default skill catalog removed, an idle Studio makes no outbound
requests.

## 1. Traffic Studio starts on its own

Requests the app makes without you or an agent asking. The switches are under
**Settings → General → Privacy**.

| What | Endpoint | When | Carries | Off switch |
|---|---|---|---|---|
| Update check | `github.com/christianbalevski/adf/releases` (`releases.atom`, `releases/latest`, then `latest*.yml`); the yml download redirects to GitHub's release-asset CDN (`*.githubusercontent.com`) | Packaged builds only: 15 s after launch, then every hour. Nothing downloads until you click the update badge. | Platform (from the `latest*.yml` file name). The `x-user-staging-id` header carries the same fixed value from every install — not a per-install ID. User-Agent `electron-builder`. No app version, account, or usage data. | **Check for updates** (`updateChecksEnabled: false`) |
| Provider connection checks | Each configured provider's API (`GET <base URL>/models` with that provider's key) | Once per session when Home loads, when the provider list first shows a provider, and when an agent review opens | The provider's own key, to the provider you configured | **Check provider connections** (`providerChecksEnabled: false`). The **Test** button in Settings → Providers always probes. |
| MCP server registry | `raw.githubusercontent.com/christianbalevski/adf/main/mcp-registry.json` | First time you open **Settings → MCP servers**, then every 24 h while the app runs | Nothing (plain GET, `If-None-Match`) | **Live catalogs** (`remoteCatalogsEnabled: false`) — serves the bundled copy and the last fetched copy |
| Agent registry index | `raw.githubusercontent.com/christianbalevski/adf/main/registry/…` | Not reachable from the current UI (the service and IPC remain for templates) | Nothing | **Live catalogs** — bundled + cached entries only; remote-only entries refuse to download |
| First-party skill catalog | `raw.githubusercontent.com/christianbalevski/adf/main/skills/registry.json` | When you open the skill browser. It is the default entry in the skill-catalog list. | Nothing | Remove it from **Settings → Skills** (not covered by Live catalogs) |
| Spell-check dictionaries (Linux only) | Google's dictionary CDN (`redirector.gvt1.com`), via Electron's built-in spell checker | Only after you click **Download** under **Spell-check dictionaries**; then also when you add a spell-check language that is not installed | The dictionary language | Off until you click it (`spellcheckDownloadsEnabled`). Until then the downloader points at loopback and nothing leaves the machine. Windows and macOS use the OS spell checker and download nothing. |

Unpackaged (`npm run dev`) builds never run the update check. The headless
daemon runs none of these.

The shared compute container is pre-started at launch **only if it already
exists** (starting it is local). First-time provisioning — which can download a
Podman machine image, a base container image, and apt packages — happens on
first use of compute (see section 2).

## 2. Traffic you configure

Requests that exist only because you set something up.

| What | Endpoint | Configured in |
|---|---|---|
| Model providers | The provider's base URL (Anthropic, OpenAI, OpenRouter, any OpenAI-compatible URL, local models) | Settings → Providers, or per-agent provider config |
| Subscription sign-in | `auth.openai.com` / `chatgpt.com`, `auth.x.ai` / `api.x.ai` | Settings → Providers (ChatGPT / xAI subscription) |
| Skill catalogs | Each URL you add to the skill-catalog list | Settings → Skills |
| MCP servers | Whatever the server connects to; `npx`/`uvx` packages come from the npm / PyPI registries | Settings → MCP servers, agent config |
| `uv` binary | `github.com/astral-sh/uv/releases` — downloaded once, only when a Python MCP server or package needs it and no `uv` is installed | Adding a Python MCP server |
| Sandbox and adapter packages | npm registry | Settings → Packages, Settings → Channels |
| Channel adapters | Telegram, Discord, Slack, WhatsApp, email servers | Settings → Channels, agent config |
| Mesh | LAN peers (mDNS) when LAN access is on. Tailscale peers: once LAN access is on, tailnet discovery is on by default and sends `GET /ping` to each tailnet peer every 45 s (`tailnetDiscovery: false` disables). Manual peer hosts. | Settings → Networking |
| Containers | Podman machine image, container image registry (default `docker.io`), Debian apt mirrors — on first use of compute | Settings → Compute |

## 3. Traffic agents start

An agent reaches the network through its enabled tools: `sys_fetch`,
`msg_send`, WebSocket tools, MCP tools, served API routes, and code execution
with network access. `sys_fetch`, `msg_send` and code execution are **on by
default** and can be disabled per agent. The base prompt points a new agent at
the ADF docs and first-party skill catalog on `raw.githubusercontent.com`
(public GETs; no agent content is sent).

Owner controls, enforced by the runtime below the model:

- **Per-tool enable/disable and approval gates** — `restricted` tools wait for
  your approval ([tools](guides/tools.md)).
- **Outbound middleware** — runs before every `msg_send` message and every
  `sys_fetch` request, and can rewrite or block by recipient or domain
  ([middleware](guides/middleware.md)). MCP servers' own traffic, WebSocket
  connections, channel adapters and container code are not routed through it.
- **Locked fields** — settings the agent cannot change about itself
  ([settings](guides/settings.md#security-guard--locked-fields)).

## Checking what a running agent is configured with

The config an agent runs with is the config stored in its `.adf` file
(`adf_config`) plus the app-level settings it inherits. See
[Effective runtime config](guides/security-and-identity.md#effective-runtime-config).
