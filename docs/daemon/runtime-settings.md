# Daemon Runtime Settings

The ADF daemon does not require Studio to configure runtime settings. Studio is one convenient settings editor, but the daemon can run from a JSON file that you create and maintain directly.

The daemon settings file controls process-level runtime behavior: providers, tracked directories, review state, MCP registrations, adapter registrations, compute defaults, mesh settings, and shared prompt text. Agent-specific behavior still lives inside each `.adf` file.

## Configuration Paths

You can configure the daemon in three ways:

1. Write a JSON settings file and start the daemon with `ADF_DAEMON_SETTINGS=/path/to/settings.json`.
2. Start the daemon and update settings through the `/settings` HTTP endpoints.
3. Reuse the default Studio settings file when you want Studio and the daemon to share provider, MCP, adapter, compute, and tracked-directory settings.

The first option is the cleanest headless path.

```bash
ADF_DAEMON_SETTINGS=/path/to/adf-daemon/settings.json npm run daemon
```

When `ADF_DAEMON_SETTINGS` is not set, the daemon uses the platform default ADF user data directory. On macOS that is typically:

```text
~/Library/Application Support/adf-studio/adf-settings.json
```

## Minimal Settings File

This is enough to start the daemon with one provider and one tracked directory. Replace placeholder values with real local paths and credentials.

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
      "managed": false,
      "env": [
        { "key": "TELEGRAM_BOT_TOKEN", "value": "secret-value" }
      ],
      "credentialStorage": "app"
    }
  ],
  "compute": {
    "hostAccessEnabled": false,
    "hostApproved": [],
    "containerPackages": [
      "python3-full",
      "python3-pip",
      "git",
      "curl",
      "wget",
      "jq",
      "unzip",
      "ca-certificates",
      "openssh-client",
      "procps",
      "chromium",
      "chromium-driver",
      "fonts-liberation",
      "libnss3",
      "libatk-bridge2.0-0",
      "libdrm2",
      "libgbm1",
      "libasound2"
    ],
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
| `type` | Yes | `anthropic`, `openai`, `openai-compatible`, or `chatgpt-subscription` |
| `name` | Yes | Display name used in logs and usage tracking |
| `baseUrl` | Type-dependent | Required for `openai-compatible`; empty string for standard providers |
| `apiKey` | Type-dependent | API credential for API-key providers |
| `defaultModel` | No | Model used when an agent does not specify `model.model_id` |
| `params` | No | Extra provider parameters as string key/value pairs |
| `requestDelayMs` | No | Delay before each LLM request |
| `credentialStorage` | No | `app` for settings-file credentials or `agent` for per-ADF credentials |

For `chatgpt-subscription`, use the auth endpoints instead of an API key:

```bash
curl -X POST http://127.0.0.1:7385/auth/chatgpt/start
```

Then open the returned `authUrl` in a browser.

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
Built-in adapter registrations for `telegram` and `email` are always available even when they are omitted from settings; settings only need to carry app-level credentials or custom adapter registrations.

Common adapter registration fields:

| Field | Description |
|-------|-------------|
| `id` | Settings-level registration ID |
| `type` | Adapter type, such as `telegram` or `email` |
| `npmPackage` | External adapter package, if not built in |
| `managed` | Whether the package is managed by ADF |
| `env` | App-level credentials or environment values |
| `credentialStorage` | `app` or `agent` |

Built-in adapter types currently include `telegram` and `email`.

## Compute Settings

The daemon passes `compute` settings to `PodmanService`.

| Field | Description |
|-------|-------------|
| `hostAccessEnabled` | Whether host compute routing can be used |
| `hostApproved` | Approved host access entries |
| `containerPackages` | Packages installed in compute containers |
| `machineCpus` | CPU allocation for the Podman machine |
| `machineMemoryMb` | Memory allocation for the Podman machine |
| `containerImage` | Base container image |

Agents can request isolated compute from their own `.adf` config. The daemon settings define the shared environment defaults and host access policy.

## Mesh Settings

| Field | Description |
|-------|-------------|
| `meshEnabled` | Enables mesh behavior unless explicitly `false` |
| `meshLan` | Binds mesh to LAN when supported by the mesh server |
| `meshPort` | Mesh server port, default `7295` |

Environment variables can override mesh binding:

```bash
MESH_HOST=127.0.0.1 MESH_PORT=7296 npm run daemon
```

## Live Settings API

Read all settings:

```bash
curl http://127.0.0.1:7385/settings
```

Patch multiple settings:

```bash
curl -X PATCH http://127.0.0.1:7385/settings \
  -H 'Content-Type: application/json' \
  -d '{"trackedDirectories":["/path/to/agents"],"meshPort":7295}'
```

Read one setting:

```bash
curl http://127.0.0.1:7385/settings/trackedDirectories
```

Set one setting:

```bash
curl -X PUT http://127.0.0.1:7385/settings/trackedDirectories \
  -H 'Content-Type: application/json' \
  -d '{"value":["/path/to/agents"]}'
```

Settings updates are written back to the daemon settings JSON file. Some settings affect already-created runtime services only after a daemon restart; provider and tracked-directory changes are safest to apply before starting agents.

## Secret Handling

If you write the settings file manually, any `apiKey` or `env` values you put there are stored as plain JSON. Protect the file with normal filesystem permissions, or store credentials per agent when that is the intended deployment model.

For headless deployments, prefer a dedicated daemon settings file rather than sharing a personal Studio settings file.
