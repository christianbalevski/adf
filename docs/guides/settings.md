# Settings

ADF Studio settings are accessed via the gear icon in the sidebar or `Cmd/Ctrl + ,`. Settings are global and apply across all agents.

## Providers

Providers are the LLM services that power your agents. You need at least one configured provider before agents can think.

### Adding a Provider

1. Go to **Settings > Providers**
2. Click **Add Provider**
3. Configure:

| Field | Description |
|-------|-------------|
| **Name** | Display name for this provider configuration |
| **Type** | `anthropic`, `openai`, `openai-compatible`, or `chatgpt-subscription` |
| **API Key** | Your API key for the service (not applicable for chatgpt-subscription) |
| **Base URL** | API endpoint (auto-filled for standard providers, required for openai-compatible) |
| **Default Model** | The model to use when an agent doesn't specify one |
| **Request Delay** | Milliseconds between API calls (for rate limiting) |

### Provider Types

**Anthropic** — Claude models. Uses the Anthropic API format.

**OpenAI** — GPT models. Uses the OpenAI API format.

**OpenAI-compatible** — Any service that implements the OpenAI API format. This includes:
- Local model servers (Ollama, LM Studio, etc.)
- Third-party providers (Together, Groq, etc.)
- Custom deployments

For openai-compatible providers, you'll need to set the base URL to your server's endpoint.

**ChatGPT Subscription** — Use your existing ChatGPT Plus or Pro subscription to power agents at a flat monthly rate instead of per-token billing. This provider authenticates via OAuth (no API key needed) and uses the ChatGPT Responses API backend.

Setup:
1. Add a new provider and select **ChatGPT Subscription** as the type
2. Click **Sign In with ChatGPT** — this opens your browser for OAuth authentication
3. After signing in, the provider shows your email and authentication status
4. Select a model from the dropdown (e.g., `gpt-5.4`, `gpt-5.4-mini`)

Notes:
- Authentication is app-wide — all agents using this provider share the same session
- Tokens are encrypted at rest via the system keychain (macOS Keychain, Windows DPAPI, etc.)
- Token refresh is automatic; if your session expires, click **Sign In** again
- The API key and Base URL fields are not used — authentication is handled entirely via OAuth
- These models are reasoning models — temperature and topP settings are not supported and are automatically omitted

Available models: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.3-chat-latest`, `gpt-5.3-instant`

#### Rate Limits and Provider Status

ChatGPT subscriptions have usage limits tracked across two rolling windows: a **primary (5-hour)** window and a **secondary (7-day)** window. Usage is measured as a percentage — the exact formula is determined server-side by OpenAI.

Agents can monitor their rate limit status by calling `sys_get_config({ section: "provider_status" })`, which returns metadata captured from the last API response:

| Field | Description |
|-------|-------------|
| `planType` | Subscription tier (`plus`, `pro`, etc.) |
| `primaryUsedPercent` | Percentage of primary (5-hour) window consumed |
| `primaryResetAfterSeconds` | Seconds until the primary window resets |
| `primaryResetAt` | Unix timestamp when the primary window resets |
| `primaryWindowMinutes` | Duration of the primary window (typically 300) |
| `secondaryUsedPercent` | Percentage of secondary (7-day) window consumed |
| `secondaryResetAfterSeconds` | Seconds until the secondary window resets |
| `secondaryResetAt` | Unix timestamp when the secondary window resets |
| `secondaryWindowMinutes` | Duration of the secondary window (typically 10080) |
| `creditsBalance` | Remaining purchased credits |
| `creditsHasCredits` | Whether the account has purchased credits |
| `activeLimit` | Which limit is currently active (e.g. `codex`) |

This enables self-managing agents — for example, a lambda can check `primaryUsedPercent` before expensive operations and defer work until the window resets. When the usage limit is reached, the error surfaces immediately (no retries) with the reset time in the error message

### Custom Parameters

For openai-compatible providers, you can add custom key-value parameters that are passed directly to the API. Useful for provider-specific features.

For chatgpt-subscription providers, you can use **Provider Parameters** (in the agent's model config) to pass provider-specific options like `reasoning.effort`. These are forwarded as `providerOptions.openai` to the AI SDK.

### Per-ADF Provider Configurations

Each ADF file can store its own provider configuration independently of the app-wide settings. This allows agents to ship with embedded API keys, custom models, and provider-specific parameters.

Per-ADF provider configs are managed from:

- **Settings > Providers** — Expand a provider and use the **ADF Files** section to assign credentials to specific ADF files. Each ADF can override the API key, default model, request delay, and custom parameters.
- **Agent > Config** — The agent's configuration panel shows which provider is being used and whether it has per-ADF overrides.

Credentials are stored in the ADF's `adf_identity` table (encrypted at rest), mirroring the pattern used for MCP server and channel adapter credentials. ADF files with stored provider configurations will continue to work independently, even if the provider is not listed in the app-wide settings.

## MCP Servers

MCP servers are managed through the **MCP Status Dashboard** in Settings. See [MCP Integration](mcp-integration.md) for full details.

### Status Dashboard

From **Settings > MCP Servers**:

- **Quick-add** — Browse a curated registry of well-known MCP servers and install with one click
- **Install/Uninstall** — Managed npm installs in `~/.adf-studio/mcp-servers/`
- **Configure** — Expand any server to edit args, environment variables, and timeout
- **Test** — Verify the server starts and exposes tools
- **Restart** — Reconnect a server
- **Logs** — View per-server logs including tool call history
- **Remove** — Delete the server and its installation
- **Credentials** — Manage API keys and secrets per server (app-wide or per-agent)

### Server Configuration

| Field | Description |
|-------|-------------|
| **Name** | Server display name |
| **Transport** | Connection type (`stdio`) |
| **Command** | Command to start the server |
| **Args** | Command arguments (one per row, supports `~` expansion) |
| **Environment Variables** | Variables passed to the server process |
| **Tool Call Timeout** | Per-server timeout in seconds (default: 60) |

## Channel Adapters

Channel adapters connect external messaging platforms to ADF agents. Manage adapters from **Settings > Channel Adapters**.
Telegram and email are built in and always registered by the runtime; configure credentials and enable them per agent as needed.

### Adapter Status Dashboard

- **Connection status** — See which adapters are connected, connecting, or errored
- **Logs** — View per-adapter logs (up to 500 entries)
- **Start/Stop/Restart** — Control adapter lifecycle
- **Credentials** — Store platform tokens (app-wide or per-agent in `adf_identity`)

### Available Adapters

| Adapter | Built-in | Required Credentials | Notes |
|---------|----------|---------------------|-------|
| **Telegram** | Yes | `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| **Email** | Yes | `EMAIL_USERNAME`, `EMAIL_PASSWORD` | IMAP/SMTP; use app-specific password |

Per-agent adapter configuration is set in the agent's config panel under `adapters`. See [Messaging > Channel Adapters](messaging.md#channel-adapters) for full details.

## Web (Mesh Server)

The **Web** tab shows the status of the mesh HTTP server and all agents currently serving content.

### Server Status

- **Running indicator** — Green dot when the server is listening, red when stopped
- **Host and port** — Shows the current bind address (e.g., `127.0.0.1:7295`)
- **Server URL** — Clickable link to the server root

### Mesh Toggle

Enable or disable the mesh network. When enabled, agents with configured serving or messaging can register on the mesh.

### LAN Access

Toggle **Allow LAN access** to bind the server to `0.0.0.0` instead of `127.0.0.1`. This allows other devices on your local network to access served agents at `http://{your-ip}:{port}/{handle}/`.

A server restart is required after changing this setting. The `MESH_HOST` environment variable overrides this setting.

### Agent Endpoints

A table listing all agents currently registered on the mesh:

| Column | Description |
|--------|-------------|
| **Handle** | The agent's identity — URL-safe slug derived from filename or manually configured |
| **URL** | Clickable link to the agent's mesh root |
| **Public** | Badge shown if public folder serving is enabled |
| **API** | Route count badge (e.g., "3 routes") |
| **Shared** | Pattern count badge (e.g., "2 patterns") |

Empty state: "No agents serving" when mesh is disabled or no agents are registered.

See [HTTP Serving](serving.md) for the full guide on configuring what agents serve.

## System Prompt

The system prompt is assembled dynamically from two parts: a **base prompt** and **conditional tool instruction sections**. Both are editable in **Settings > General**.

### Base Prompt (Global System Prompt)

The base prompt applies to all agents by default, prepended before each agent's individual instructions. It explains the ADF paradigm — the document workspace, mind.md, how triggers work, tone and style directives — without referencing any specific tools. Individual agents can opt out via the **Include application base system prompt** checkbox in their Instructions section (`include_base_prompt: false` in the config). Use the base prompt for:

- Explaining the ADF paradigm to models that may not be familiar with it
- Setting global behavioral rules
- Providing context that all agents should have

Edit the prompt text directly — changes are auto-saved with a short debounce delay. There's a **Reset to Default** button to restore the standard base prompt.

### Tool Instructions

Below the base prompt, the **Tool Instructions** section lists conditional prompt blocks that are injected based on the agent's enabled tools and features. Each section has an expandable textarea and a per-section **Reset to Default** button. A "modified" badge appears when the user has customized a section.

| Section | Injected When |
|---------|---------------|
| **Tool Best Practices** | Shell is **not** enabled — provides cross-tool workflow guidance (read before edit, fs_write modes, verify results) |
| **Code Execution & Lambdas** | `sys_code` or `sys_lambda` is enabled — explains the `adf` proxy object, single-argument rule, async/await requirements |
| **ADF Shell** | `adf_shell` tool is enabled — replaces Tool Best Practices with comprehensive shell syntax, command reference, tips, and environment variables |
| **Multi-Agent Collaboration** | `messaging.receive` is enabled — behavioral rules for responding to messages, using exact names, managing inbox |
| **HTTP Serving** | Any serving feature is configured (`serving.public`, `serving.shared`, or `serving.api`) — explains public folders, shared files, API route definitions, and lambda handlers |

When the adf_shell tool is enabled, the **Tool Best Practices** section is replaced by the **ADF Shell** section — they are mutually exclusive. All other sections are additive. Sections are joined with `---` separators.

Most individual tools (fs_read, fs_list, db_query, etc.) are self-explanatory from their schema descriptions and do not need additional system prompt guidance. The tool instruction sections focus on cross-cutting concerns that cannot be conveyed through tool schemas alone.

## Auto-Save

All settings changes are automatically saved with a debounced delay. There is no manual Save/Cancel workflow — changes take effect shortly after you stop editing. A close button dismisses the settings panel.

## Theme

Toggle between **light** and **dark** mode.

## Token Usage

ADF Studio tracks token usage across all agents. View usage in **Settings > Token Usage**.

### Usage Breakdown

- Per-date statistics
- Per-provider breakdown
- Per-model breakdown
- Input and output token counts
- Total statistics

### Managing Usage Data

- **Clear All** — Delete all tracked usage data
- Data is stored locally and not sent anywhere

## Tracked Directories

ADF Studio monitors directories for `.adf` files. When a new file appears in a tracked directory, it shows up in the sidebar.

### Managing Directories

- Directories are auto-tracked when you create or open a file
- You can manually add or remove tracked directories
- The sidebar shows a hierarchical tree of tracked directories and their files

### Directory Actions

- **Start all** — Start all agents in a directory
- **Stop all** — Stop all agents in a directory

## Application Settings

### File Associations

ADF Studio registers itself as the handler for `.adf` files. Double-clicking an `.adf` file opens it in the app.

### Multiple Instances

For development, you can run multiple ADF Studio instances with `--instance=N`. Each instance gets a separate user data directory and independent settings.

## Bottom Panel (Logs & Tasks)

ADF Studio includes a VS Code-style **Bottom Panel** at the bottom of the main view, toggled from the **Logs** or **Tasks** buttons in the status bar. The panel has two tabs: **Logs** and **Tasks**, with a shared drag-to-resize handle.

### Logs Tab

Displays structured log entries from `adf_logs` — including lambda trigger executions, sys_lambda results, API serving requests/responses, and runtime events.

- **Level filtering** — Filter by `debug`, `info`, `warn`, or `error`
- **Origin filtering** — Filter by origin (e.g., `timer`, `lambda`, `serving`, `adf_shell`). The dropdown is populated dynamically from the origins present in the current log entries.
- **Structured columns** — Each log entry shows timestamp, level, origin, event type, target, and message
- **Expandable data** — Click a row to expand and view the full JSON data payload
- **Auto-refresh** — Toggle auto-refresh to poll for new log entries
- **Per-ADF** — Logs reload automatically when navigating between ADF files

#### Log Entry Fields

| Field | Description |
|-------|-------------|
| `level` | Log level: `debug`, `info`, `warn`, `error` |
| `origin` | Where the log came from (e.g., `timer`, `lambda`, `serving`, `sys_lambda`, `adf_shell`) |
| `event` | The event type (e.g., `on_timer`, `api_request`, `api_response`, `execute`, `result`) |
| `target` | The specific target (e.g., `system:lib/router.ts:onMessage`, `lib/api.ts:handler`) |
| `message` | Human-readable log message |
| `data` | Optional JSON data payload |

See [Logging](logging.md) for details on log filtering configuration (`default_level`, per-origin `rules`, `max_rows`).

### Tasks Tab

Displays async tasks from `adf_tasks` — tool calls that require human approval or long-running operations.

- **Status filtering** — Filter by `pending`, `pending_approval`, `running`, `completed`, `failed`, `denied`, or `cancelled`
- **Expandable rows** — Click a task to view its full arguments, result, or error details
- **Auto-refresh** — Toggle auto-refresh to poll for task status changes
- **Per-ADF** — Tasks reload automatically when navigating between ADF files

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + ,` | Open Settings |
| `Cmd/Ctrl + S` | Save current editor tab |
| `Cmd/Ctrl + W` | Close active editor tab |
