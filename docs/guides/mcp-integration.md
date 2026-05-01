# MCP Integration

ADF supports the **Model Context Protocol (MCP)** for connecting external tool servers. This lets agents use tools provided by third-party services or local utilities without building them into the ADF runtime.

## What is MCP?

MCP is a standard protocol for connecting AI models to external tools and data sources. An MCP server exposes a set of tools that the model can call, just like built-in tools.

Common examples:

- Filesystem access (read/write files on the host machine)
- Web browsing and search
- Database connections
- API integrations (Slack, GitHub, etc.)

## MCP Server Manager

ADF Studio includes a built-in **MCP Server Manager** for installing, configuring, and monitoring MCP servers. Access it from **Settings > MCP Servers**.

### Quick-Add Registry

The Server Manager includes a curated registry of well-known MCP servers you can install with one click:

| Server | Category | Description |
|--------|----------|-------------|
| **Filesystem** | Tools | Read, write, and manage local files and directories |
| **GitHub** | Dev | Interact with GitHub repositories, issues, and PRs |
| **Memory** | Data | Persistent knowledge graph memory for agents |
| **Brave Search** | Tools | Search the web using Brave Search API |
| **Puppeteer** | Tools | Browser automation with Puppeteer |
| **Slack** | Communication | Interact with Slack workspaces |
| **Sequential Thinking** | Tools | Dynamic, reflective problem-solving through thought sequences |
| **Mail (IMAP/SMTP)** | Communication | Search, read, and send email |
| **Resend** | Communication | Send emails via the Resend platform |
| **Telegram** | Communication | Interact with Telegram via bot API |
| **Discord** | Communication | Discord bot integration |
| **Twilio SMS** | Communication | Send and receive SMS via Twilio |

### Installing a Server

1. Open **Settings > MCP Servers**
2. Browse the registry or click **Add Server**
3. Click **Install** on a registry server, or configure a custom server manually
4. The Server Manager runs `npm install` in `~/.adf-studio/mcp-servers/<package>/`
5. The server entry point is resolved automatically (no `npx` needed in production)

### Status Dashboard

The MCP Status Dashboard shows all registered servers with:

- **Connection status** — Connected, disconnected, or errored
- **Tool count** — Number of tools the server exposes
- **Health checks** — Periodic pings to verify the server is alive
- **Logs** — Expandable log viewer per server (including tool call logs)
- **Actions** — Test connection, restart, view logs, remove

Click any server to expand its configuration panel where you can edit args, environment variables, and timeout settings.

### Per-Server Arguments

Each server supports a list of command-line arguments (one per row in the UI). Arguments support `~` expansion for home directory paths. Empty arguments are automatically filtered out.

### Per-Server Timeout

Each server can have a custom **tool call timeout** (in seconds). This controls how long the runtime waits for a tool call response before timing out. The default is **60 seconds**. Configure this in the server's expanded settings panel.

## Credential Management

Many MCP servers require API keys or other secrets. ADF Studio provides two levels of credential storage:

### App-Wide Credentials

Credentials stored at the application level (in Settings) are available to any agent that uses the server. These are stored encrypted on disk.

### Per-Agent (ADF) Credentials

Credentials can also be stored in an individual agent's `adf_identity` table using the naming convention `mcp:<server>:<key>`. These are encrypted with the agent's password (if set) and travel with the `.adf` file.

### Credential Panel

The credential panel (accessible from the MCP Status Dashboard) lets you:

- Set app-wide credentials for each server's required environment variables
- Set per-agent credentials for specific ADF files
- See which servers have stored credentials (key icon indicator)
- See which servers need credentials ("Needs keys" badge)

When credentials are saved for an agent, the MCP server configuration is automatically attached to that agent. When credentials are removed, the server is detached.

### Credential Security

- Credentials are decrypted at runtime only when connecting the server process
- A defensive copy prevents decrypted values from being written back to persisted config
- Environment variables are passed to the server process, not to the agent

## Interactive Authentication (OAuth)

Some MCP servers require interactive authentication — typically an OAuth flow where the user authorizes access in a browser. ADF Studio handles this through an **auth preflight** step built into `mcp_install`.

### How It Works

When an agent installs an MCP server with `auth: true`, the runtime:

1. **Spawns the server as a normal process** (not as an MCP transport) with any specified `auth_args`
2. **Detects auth URLs** in the server's stdout/stderr and opens them in the default browser via Electron
3. **Shows a dialog**: "Complete authorization in your browser, then click Continue"
4. **Waits for the user** to finish the OAuth flow and click Continue
5. **Kills the preflight process** and connects via the normal MCP stdio transport

The server's OAuth flow saves credentials to disk (e.g., `~/.gmail-mcp/credentials.json`). Subsequent MCP connections use those saved credentials — no browser needed.

### Agent-Side Usage

The agent calls `mcp_install` with the `auth` and `auth_args` parameters:

```json
{
  "package": "@gongrzhe/server-gmail-autoauth-mcp",
  "type": "npm",
  "name": "gmail",
  "host": true,
  "auth": true,
  "auth_args": ["auth"]
}
```

| Parameter | Purpose |
|-----------|---------|
| `auth` | Enables the auth preflight — spawns the server once before connecting |
| `auth_args` | Extra arguments passed to the server during preflight (e.g., `["auth"]` for servers with a dedicated auth subcommand) |

### Prerequisites (Google OAuth Example)

Many MCP servers that use Google APIs (Gmail, Google Drive, Google Calendar) require a Google Cloud OAuth client credentials file. Here's the one-time setup:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**
2. If prompted, configure the **OAuth consent screen**:
   - User type: **External**
   - App name: anything (e.g., "ADF Studio")
   - Support email and developer contact: your email
   - Add your email as a **test user** under Audience → Test users (if app is in testing mode)
   - Or click **Publish App** to skip the test user requirement
3. Click **+ Create Credentials** → **OAuth client ID** → **Desktop app**
4. Download the JSON file
5. Rename it to `gcp-oauth.keys.json` and place it at `~/.gmail-mcp/gcp-oauth.keys.json`
6. Enable the **Gmail API** in APIs & Services → Library

After this setup, the agent's `mcp_install` with `auth: true` will open a Google consent screen in the browser.

### Example: Gmail MCP Server

Full install flow from the agent's perspective:

```
mcp_install({
  package: "@gongrzhe/server-gmail-autoauth-mcp",
  type: "npm",
  name: "gmail",
  host: true,
  auth: true,
  auth_args: ["auth"]
})
```

What happens:
1. Runtime runs `npx -y @gongrzhe/server-gmail-autoauth-mcp auth`
2. Server prints the Google OAuth URL → runtime opens it in the browser
3. User authorizes Gmail access in the browser
4. Server receives the OAuth callback on `localhost:3000` and saves tokens to `~/.gmail-mcp/credentials.json`
5. User clicks **Continue** in the ADF dialog
6. Runtime kills the preflight, connects via stdio, discovers ~19 Gmail tools

The agent can now use tools like `mcp_gmail_send_email`, `mcp_gmail_search_emails`, `mcp_gmail_list_email_labels`, etc.

### Common Auth Patterns Across MCP Servers

| Pattern | How it works | `auth_args` example |
|---------|-------------|-------------------|
| **Auth subcommand** | Server has a dedicated auth mode that opens browser and saves tokens | `["auth"]` |
| **Device code flow** | Server prints a code + URL; user enters code in browser | `["--auth=device-code"]` or `["init"]` |
| **Env var / API key** | No interactive auth — just pass the key via `env` parameter | Not needed (use `env` instead) |
| **Remote HTTP (OAuth 2.1)** | Auth handled by the MCP client/transport layer, not the server | Not needed |

Servers with an `auth` subcommand (Google Drive, Gmail, Spotify) are the most common case. Device code flows (Microsoft, Auth0) also work — the URL is detected and opened automatically.

### Interactive vs Headless

| Scenario | Auth approach |
|----------|--------------|
| **Interactive** (user at Studio) | `auth: true` on `mcp_install` → preflight → user confirms in dialog |
| **Headless** (autonomous agent) | Owner pre-authorizes externally, stores token in identity keystore via `env`, server reads from env |

OAuth is fundamentally interactive — it requires a human in a browser. For headless agents, the owner does the OAuth dance once on their own machine, extracts the token, and configures the agent with it via the `env` parameter on `mcp_install`.

## First-Open Modal

When you open an `.adf` file that references MCP servers not yet installed on your machine, a **Missing MCP Servers** dialog appears. This lets you install the required servers with a single click before the agent tries to use them.

## Per-Agent Server Attachment

After registering a server globally, you attach it to individual agents in their configuration panel:

- **Registered servers** show with their registry info (description, repo link, docs link)
- **Attach/Detach** buttons control whether the server is connected when the agent starts
- **Remove** button (for unregistered servers) includes a confirmation dialog warning about credential deletion
- Unregistered server blocks are collapsible (collapsed by default) with a count indicator

Only servers registered in Settings are connected during agent start. Servers referenced in an agent's config but not installed globally have their tool declarations disabled to prevent sending unavailable tools to the LLM.

## Using MCP Tools

MCP tools appear in the agent's tool list with the naming convention:

```
mcp:<server_name>:<tool_name>
```

For example, a filesystem server might expose:

- `mcp:filesystem:read_file`
- `mcp:filesystem:write_file`
- `mcp:filesystem:list_directory`

### Viewing MCP Tool Schemas

In the agent configuration panel, MCP tools are **clickable** — click any MCP tool name to open a modal showing its full JSON schema (parameters, types, descriptions). This helps you understand what each tool expects without needing to look up the server's documentation.

### Enabling/Disabling MCP Tools

Like built-in tools, each MCP tool can be individually enabled or disabled in the agent's tool configuration:

```json
{ "name": "mcp:filesystem:read_file", "enabled": true }
```

### Disabled Tool Guard

If an agent attempts to call a tool that is not in its enabled set (including disabled MCP tools), the runtime **rejects the call** and returns an error to the model. This prevents the agent from using tools it shouldn't have access to.

### Unavailable Servers

If an MCP server is unavailable (failed to start, crashed, not installed), its tools are **silently disabled**. The agent won't see them in its available tools and won't attempt to call them.

### Media and Resource Content

MCP tools can return multiple content block types beyond plain text. The runtime handles all of them — nothing is silently dropped. All media (images, audio, resources) returned by MCP tools is automatically saved to `adf_files` at `mcp/{server}/{tool}_{timestamp}_{index}.{ext}` and referenced by durable VFS path in the tool result text. The agent can revisit saved media later via `fs_read`.

#### Multimodal Support (Image, Audio, Video)

Media from MCP tools and `fs_read` can be sent as native content blocks to the LLM when the corresponding modality is enabled in `model.multimodal`:

- **Image** (`multimodal.image`): `image_url` content blocks, same as the legacy `model.vision` toggle. Supports PNG, JPEG, GIF, WEBP. Size limit: `limits.max_image_size_bytes` (default 5 MB).
- **Audio** (`multimodal.audio`): `input_audio` content blocks. Supports WAV, MP3, OGG, FLAC, AAC, AIFF, M4A, WebM. Size limit: `limits.max_audio_size_bytes` (default 10 MB). Note: the AI SDK only natively supports WAV and MP3; other formats are coerced to WAV for the SDK's validator but the actual codec negotiation happens provider-side.
- **Video** (`multimodal.video`): `video_url` content blocks. Supports MP4, MPEG, QuickTime, WebM. Size limit: `limits.max_video_size_bytes` (default 20 MB). Note: the AI SDK doesn't support video natively — the runtime bypasses the SDK's message validation and injects raw OpenAI-format `video_url` parts directly into the HTTP request body. This works for providers that support the OpenAI chat completions format (OpenRouter, Gemini, etc.).

When a modality is disabled, media is still saved to `adf_files` and the tool result text includes a path reference (e.g., `[image: mcp/puppeteer/screenshot_1710000000_1.png (image/png)]`), but no content block is created for the LLM.

**In code/shell execution:** The full structured JSON response is always returned with raw base64 data regardless of multimodal settings (see below).

#### Resources and Resource Links

- **Embedded resources** with text content are inlined directly into the text response.
- **Embedded resources** with binary (blob) data are preserved in the structured JSON for code/shell access (see below). In the LLM loop, they appear as text summaries: `[resource 1: application/octet-stream, file:///path] — call this tool in code to access the raw data`.
- **Resource links** appear as: `[Resource link: <name> (<uri>)]`

#### Unknown Content Types

Any content type not recognized by the runtime is included as `[Unsupported content type: <type>]` rather than being silently dropped.

#### Structured JSON Response (Code/Shell)

When an MCP tool returns media or binary content (images, audio, resource blobs), code/shell execution contexts receive the full structured JSON:

```json
{
  "text": "Optional text content",
  "images": [
    { "data": "<base64>", "mimeType": "image/png" }
  ],
  "audio": [
    { "data": "<base64>", "mimeType": "audio/mpeg" }
  ],
  "resources": [
    { "data": "<base64>", "mimeType": "application/octet-stream", "uri": "file:///path/to/file" }
  ]
}
```

This allows agents to parse, modify, save (via `fs_write`), or forward data programmatically. Text-only MCP responses remain plain strings (no JSON wrapping).

#### File I/O Between Host OS and ADF

Agents can use MCP servers (e.g., `@modelcontextprotocol/server-filesystem`) to read and write files on the host OS. This works best from code execution contexts where the agent has access to the full structured response:

**Reading a file from the host into ADF:**
```javascript
// Read binary file from host via MCP filesystem server
const result = await adf.mcp_filesystem_read_file({ path: '/home/user/photo.jpg' });
// Resource blob data is in result.resources[0].data (base64)
await adf.fs_write({ mode: 'write', path: 'photo.jpg', content: result.resources[0].data, encoding: 'base64' });
```

**Writing a file from ADF to the host:**
```javascript
// Read file from ADF VFS
const file = await adf.fs_read({ path: 'photo.jpg' });
// Write to host via MCP filesystem server
await adf.mcp_filesystem_write_file({ path: '/home/user/output.jpg', content: file.content });
```

Text files work the same way but without the `encoding: 'base64'` parameter.

## MCP Server Lifecycle

- Servers start when an agent that uses them becomes active
- Servers are stopped when no active agents need them
- The **Emergency Stop** button disconnects all MCP servers immediately
- Server processes are managed by the runtime, not the agent
- **Auto-restart:** if a server crashes, the supervisor attempts to reconnect with exponential backoff (2s, 4s, 8s, up to 3 retries). On successful reconnect, tools are automatically re-registered so the agent can use them again without a restart.
- Health checks use lightweight pings (not full tool listing) to minimize overhead
- If a tool is called while its server is disconnected, the agent receives an error with the server's status and reason (e.g., `"status: error: Connection lost"`) rather than a generic failure

### Per-Agent Scratch Directory

Each agent with MCP servers gets an isolated temporary directory at `{os-temp}/adf-scratch-{pid}/{agent-name}-{hash}/`. This directory is set as the working directory (`cwd`) for all MCP server processes spawned by that agent.

**Why this matters:** MCP servers that write files as side effects (screenshots, downloads, generated assets) would otherwise write to the app root. The scratch directory isolates these writes per agent.

- Created on agent start (both foreground and background)
- Transfers with the MCP manager on foreground ↔ background transitions
- Deleted on agent stop, after MCP servers are disconnected
- Scoped per process to support multi-instance Studio (`ADF_INSTANCE`)
- Stale directories from unclean shutdowns are cleaned up on app launch

The scratch directory is purely internal — it is not exposed to the agent or configurable. The agent interacts with MCP tools normally; the isolation is transparent.

### Background Agents

Background agents have full MCP support. When an agent with MCP servers configured is started from the sidebar, mesh, or directory start-all, its MCP servers are connected using the same logic as foreground agents. MCP managers and scratch directories transfer seamlessly between foreground and background when switching files, and disconnect cleanly on agent stop or shutdown.

## Security

### Environment Variable Blocklist

MCP server configurations cannot override security-sensitive environment variables. The following are blocked:

- `ELECTRON_RUN_AS_NODE`
- `NODE_OPTIONS`
- `LD_PRELOAD`
- Other security-sensitive process environment variables

If a server config includes blocked variables, a warning is logged identifying which variables were filtered. The server still starts with the remaining environment.

### Input Validation

All MCP IPC handlers have Zod validation on their inputs, covering: probe, install, uninstall, restart, logs, credential set/get/list, attach, and detach operations.

### Path Traversal Guards

- Entry point resolution validates that the resolved path stays within the server's install directory
- Uninstall validates that the install path is within the managed base directory before deletion

### Tool Call Timeout

All MCP tool calls have a default **60-second timeout** to prevent the agent loop from hanging on unresponsive servers. This can be overridden per-server via the `toolCallTimeout` setting.

## Portability Note

MCP server configurations travel with the `.adf` file. However, the servers themselves may not be available on other machines — the required npm packages need to be installed. The [First-Open Modal](#first-open-modal) helps detect and install missing servers when opening a file on a new machine.
