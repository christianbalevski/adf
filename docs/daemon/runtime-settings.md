# Daemon Runtime Settings

The ADF daemon does not require Studio to configure runtime settings. Studio is one convenient settings editor, but the daemon can run from a JSON file that you create and maintain directly.

The daemon settings file controls process-level runtime behavior: providers, tracked directories, review state, MCP registrations, adapter registrations, compute defaults, mesh settings, and shared prompt text. Agent-specific behavior still lives inside each `.adf` file.

## Configuration Paths

You can configure the daemon in four ways:

1. The terminal app (`adf`): `/provider add`, `/login`, `/track`, `/channels`, `/mcp`, and its settings views.
2. The HTTP API: dedicated routes (`/runtime/providers`, `/tracked-dirs`, …) and the generic `/settings` endpoints.
3. Write a JSON settings file and start the daemon with `ADF_DAEMON_SETTINGS=/path/to/settings.json` (or `adf daemon --settings <file>`).
4. Reuse the default Studio settings file, so Studio and the daemon share providers, MCP, adapter, compute and tracked-folder settings.

A dedicated file is the cleanest path for a server:

```bash
ADF_DAEMON_SETTINGS=/srv/adf/settings.json adf daemon
```

When `ADF_DAEMON_SETTINGS` is not set, the file is `adf-settings.json` in the
user data directory (`ADF_USER_DATA_DIR`, else `ADF Studio` when it holds
Studio's settings, otherwise `adf-studio`, under `~/Library/Application
Support` on macOS, `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` on
Linux). For example, on macOS:

```text
~/Library/Application Support/ADF Studio/adf-settings.json
```

The same directory holds the daemon's access token (`daemon-token`), envelope
key and logs; see [Operations](operations.md#data-directory).

## Minimal Settings File

This is enough to start the daemon with one provider and one tracked directory. Replace placeholder values with real local paths and credentials. A key written into the file like this is stored as plain JSON; adding the provider through the daemon instead (`adf` › `/provider add`, or `POST /runtime/providers`) keeps the key in the daemon's secret store.

```json
{
  "providers": [
    {
      "id": "openai",
      "type": "openai",
      "name": "OpenAI",
      "baseUrl": "",
      "apiKey": "provider-api-key",
      "defaultModel": "model-id",
      "requestDelayMs": 0,
      "credentialStorage": "app"
    }
  ],
  "trackedDirectories": ["/path/to/agents"],
  "maxDirectoryScanDepth": 5,
  "reviewedAgents": [],
  "meshEnabled": true,
  "meshLan": false,
  "meshPort": 7295
}
```

The daemon reads this file at startup. The settings HTTP API can update it while the daemon is running.

## Example Runtime Settings Shape

This example shows the broader shape the daemon understands. It is intentionally generic; omit sections you do not use.

```json
{
  "providers": [
    {
      "id": "provider-id",
      "type": "anthropic",
      "name": "Provider Display Name",
      "baseUrl": "",
      "apiKey": "provider-api-key",
      "defaultModel": "model-id",
      "params": [
        { "key": "provider_option", "value": "value" }
      ],
      "requestDelayMs": 0,
      "credentialStorage": "app"
    }
  ],
  "trackedDirectories": ["/path/to/agents"],
  "maxDirectoryScanDepth": 5,
  "reviewedAgents": ["agent-id"],
  "meshEnabled": true,
  "meshLan": false,
  "meshPort": 7295,
  "globalSystemPrompt": "",
  "toolPrompts": {},
  "compactionPrompt": "",
  "mcpServers": [
    {
      "id": "mcp-server-id",
      "name": "server-name",
      "type": "npm",
      "npmPackage": "mcp-server-package",
      "command": "node",
      "args": ["server.js"],
      "env": [
        { "key": "API_KEY", "value": "secret-value" }
      ],
      "managed": false,
      "credentialStorage": "app",
      "toolCallTimeout": 60
    }
  ],
  "adapters": [
    {
      "id": "adapter-id",
      "type": "telegram",
      "npmPackage": "",
      "managed": false
    }
  ],
  "compute": {
    "hostAccessEnabled": false,
    "hostApproved": [],
    "machineCpus": 2,
    "machineMemoryMb": 2048,
    "containerImage": "docker.io/library/node:20-slim"
  }
}
```

## Provider Settings

Each provider entry has this shape:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Provider ID referenced by agent config, such as `openai` or `custom:local` |
| `type` | Yes | `anthropic`, `openai`, `openrouter`, `openai-compatible`, `chatgpt-subscription`, or `grok-subscription` |
| `name` | Yes | Display name used in logs and usage tracking |
| `baseUrl` | Type-dependent | Required for `openai-compatible`; empty string for standard providers |
| `apiKey` | Type-dependent | API credential for API-key providers |
| `defaultModel` | No | Model used when an agent does not specify `model.model_id` |
| `params` | No | Extra provider parameters as string key/value pairs |
| `requestDelayMs` | No | Delay before each LLM request |
| `credentialStorage` | No | `app` for settings-file credentials or `agent` for per-ADF credentials |
| `apiKeyStorage` | No | `secret-store`: the key lives in the daemon's secret store (OS keychain or the owner's passphrase file), not in this file; `apiKey` stays empty. Set by `POST /runtime/providers` (the terminal app's `/provider add`) |

`defaultProviderId` names the provider new agents use by default.

Subscription providers (`chatgpt-subscription`, `grok-subscription`) sign in
instead of taking an API key: `adf auth login chatgpt|grok`, `/login` in the
terminal app, or the `/auth/chatgpt/*` and `/auth/grok/*` endpoints (see
[subscription sign-in](api-guide.md#channels-mcp-servers-and-providers)). The
daemon keeps its own session, separate from Studio's.

## MCP Settings

The daemon reads global MCP server registrations from `mcpServers`. Agents still opt into MCP servers from their own `.adf` config under `config.mcp.servers`.

Common MCP registration fields:

| Field | Description |
|-------|-------------|
| `id` | Settings-level registration ID |
| `name` | Server name used by agent MCP declarations |
| `type` | `npm`, `uvx`, `pip`, or `custom` |
| `npmPackage` | npm package for npm-managed servers |
| `pypiPackage` | Python package for `uvx` or `pip` servers |
| `command` | Command for custom servers |
| `args` | Command arguments |
| `env` | App-level environment variables |
| `managed` | Whether the package is managed by ADF |
| `credentialStorage` | `app` or `agent` |
| `toolCallTimeout` | Per-server timeout in seconds |

If an agent declares a server that is not registered and has no source metadata, the daemon skips that server and continues loading the agent.

## Adapter Settings

The daemon reads global channel adapter registrations from `adapters`. Agents still enable adapters from their own `.adf` config under `config.adapters`.
Built-in adapter registrations for `telegram` and `email` are always available even when they are omitted from settings; settings only need to carry custom adapter registrations.

Adapter credentials are **not** settings. Every credential lives in the agent's own `adf_identity` table under the purpose `adapter:{type}:{KEY}` (for example `adapter:telegram:TELEGRAM_BOT_TOKEN`), written by the agent via `set_identity`, by Studio's **Settings > Channels** page, by `/channels` in the terminal app, or by `PUT /agents/:id/adapters/credentials`. There is no app-wide credential store and no fallback: an adapter whose identity row is missing fails plainly and stays stopped.

Common adapter registration fields:

| Field | Description |
|-------|-------------|
| `id` | Settings-level registration ID |
| `type` | Adapter type, such as `telegram` or `email` |
| `npmPackage` | External adapter package, if not built in |
| `managed` | Whether the package is managed by ADF |
| `env` | **Deprecated** — kept in the type for old settings files, ignored at runtime |
| `credentialStorage` | **Deprecated** — kept in the type for old settings files, ignored at runtime |

An adapter token left over in `env` from an older settings file is not migrated and not read. Reconnect the agent from **Settings > Channels** so the credential is stored in its `adf_identity`.

Built-in adapter types currently include `telegram` and `email`.

## Compute Settings

The daemon passes `compute` settings to `PodmanService`.

| Field | Description |
|-------|-------------|
| `hostAccessEnabled` | Whether host compute routing can be used |
| `hostApproved` | Approved host access entries |
| `containerPackages` | Packages installed in compute containers. Omit it to get the defaults (`src/shared/constants/compute-defaults.ts`: Python, Git, Chromium, the desktop/VNC stack, …); a list replaces them entirely |
| `machineCpus` | CPU allocation for the Podman machine |
| `machineMemoryMb` | Memory allocation for the Podman machine |
| `containerImage` | Base container image |

Agents can request isolated compute from their own `.adf` config. The daemon settings define the shared environment defaults and host access policy.

## Mesh Settings

| Field | Description |
|-------|-------------|
| `meshEnabled` | Mesh registration (agents discoverable and messageable); on unless explicitly `false`. `adf network mesh enable\|disable` sets it |
| `meshServerEnabled` | The mesh HTTP server (agent websites, mesh delivery); on unless explicitly `false`. `adf network server start\|stop` sets it |
| `meshLan` | Bind the mesh server to all interfaces (it also does so when a `lan` or `public` agent loads) |
| `meshPort` | Mesh server port, default `7295` |

Environment variables override mesh binding:

```bash
MESH_HOST=127.0.0.1 MESH_PORT=7296 adf daemon
```

## Other Settings

| Field | Description |
|-------|-------------|
| `agentsFolder` | Default folder for new agents (`POST /agents/create` without `directory`); else `~/Documents/adf-agents` |
| `defaultTemplateId` | Template new agents start from (`POST /templates/:id/default`) |
| `sandboxMaxWorkers` | Ceiling on concurrent code sandbox workers across all agents |
| `skillCatalogSources` | Skill catalog URLs the terminal app's `/skills add` browses |

## Live Settings API

With `ADF` and `H` set as in the [API guide](api-guide.md#quick-start)
(every request needs the access token):

```bash
curl -s -H "$H" $ADF/settings                                  # all settings (secrets removed)
curl -s -H "$H" $ADF/settings/meshPort                         # one setting
curl -s -H "$H" -X PUT $ADF/settings/meshPort \
  -H 'Content-Type: application/json' -d '{"value":7296}'      # set one
curl -s -H "$H" -X PATCH $ADF/settings \
  -H 'Content-Type: application/json' -d '{"meshLan":false,"maxDirectoryScanDepth":4}'   # set several
```

Updates are written back to the settings file. Each named key's value is
replaced (a partial `compute` object merges). Provider keys read back as
`"__redacted__"`; writing that placeholder back keeps the stored key. Identity
and key material (`ownerDid`, `runtimeDid`, `trustedDaemonEncKeys`, and the
like) cannot be written over HTTP (`403`). Prefer the dedicated routes where
one exists: `/tracked-dirs` for tracked folders (it also updates the running
mesh and loads the folder's agents), `/runtime/providers` for API-key
providers. Some settings affect already-created runtime services only after a
daemon restart.

## Secret Handling

Providers added through the daemon (`POST /runtime/providers`, `/provider add` in the terminal app) keep their key in the daemon's secret store (the OS keychain, or the owner's passphrase file), never in this file. If you write the settings file manually, any `apiKey` or `env` values you put there are stored as plain JSON. Protect the file with normal filesystem permissions, or store credentials per agent (sealed in the agent's file) when that is the intended deployment model.

For headless deployments, prefer a dedicated daemon settings file rather than sharing a personal Studio settings file.
