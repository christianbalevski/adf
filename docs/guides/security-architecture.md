# Security Architecture

ADF Studio runs AI agents that execute code, send messages, and interact with external services. This page documents the security model — trust boundaries, defense layers, and hardening controls.

For identity and encryption specifics, see [Security and Identity](security-and-identity.md). For sandbox details, see [Code Execution Environment](code-execution.md).

## Trust Boundaries

ADF Studio has five trust boundaries. A vulnerability at any boundary can escalate privileges.

### 1. Renderer to Main Process

The Electron renderer is treated as untrusted. Even though it's our own React app, XSS from LLM output or inbound messages could inject code into the renderer context.

**Controls:**
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- Content Security Policy (CSP) set via `session.webRequest.onHeadersReceived`:
  - `script-src 'self'` — blocks inline scripts and `eval()`
  - `worker-src 'self' blob:` — allows sandbox workers
  - `connect-src` restricted to localhost — all AI provider calls go through main process IPC, so the renderer has no reason to connect externally
  - `frame-src 'none'`, `object-src 'none'` — blocks iframes and plugins
- DOMPurify sanitization on all markdown rendered from LLM output and tool results
- `will-navigate` handler blocks renderer navigation to external pages
- `shell.openExternal` validates URL protocol (`https:`, `http:`, `mailto:` only)

**What this means:** Even if an attacker gets HTML into the chat (via LLM output, inbound messages, or tool results), inline scripts are blocked by CSP, event handlers are stripped by DOMPurify, and the renderer cannot fetch external URLs.

### 2. Sandbox to Main Process

`sys_code` and `sys_lambda` execute in a Node.js Worker Thread with a V8 VM context. This is not a security sandbox in the browser sense — `vm` does not provide hard isolation. The defense is layered:

**Controls:**
- `codeGeneration: { strings: false }` — no `eval()` or `new Function()`
- All built-in prototypes frozen inside the VM context (Object, Array, Function, String, etc.)
- `fetch`, `Request`, `Response`, `Headers` deleted from worker scope — all network goes through `adf.sys_fetch()` which routes through security middleware
- Module allowlist: only `crypto`, `buffer`, `url`, `querystring`, `path`, `util`, `string_decoder`, `punycode`, `assert`, `events`, `stream`, `zlib`
- Execution timeout: default 10s, max 300s, enforced by worker termination
- RPC bridge (`adf` proxy) validates every tool call against the agent's config before execution

**What this means:** Code cannot access the filesystem, spawn processes, or make network requests except through the `adf` proxy, which enforces tool enablement, restriction checks, and middleware.

### 3. Network Boundary

The mesh server, WebSocket connections, and channel adapters accept input from the network.

**Controls:**
- Mesh server binds to `127.0.0.1` by default — LAN exposure requires explicit `meshLan` setting
- Ed25519 message signature verification (envelope and payload)
- Configurable `allow_unsigned` (default: true for local dev, should be false for internet-facing agents)
- Allow/block lists for message senders (by DID)
- Inbox middleware pipeline — user-defined lambdas can inspect and reject messages before storage

**What this means:** Network-sourced messages go through signature verification, allow/block filtering, and middleware before reaching the agent. With `allow_unsigned: false` and proper identity setup, only verified senders can deliver messages.

### 4. External Process Boundary

MCP servers and user-installed packages run external code with the user's OS privileges.

**Controls:**
- Blocked environment variables for MCP server processes: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH`
- MCP server health checks with auto-restart (60s interval, 10s timeout)
- Connection timeout: 120s (allows for initial npx/uvx downloads)
- Package installs: native addon detection and blocking (scans for `binding.gyp`, `node-gyp` postinstall scripts, `gypfile: true`); per-package limit 50 MB, total 200 MB

**What this means:** MCP servers are operator-configured and trusted by design. The controls prevent process-level injection attacks but don't sandbox the MCP server itself. When running in a container (shared or isolated), servers are further isolated from the host. See [Compute Environments](compute.md) for the full compute security model, including critical implications of host access.

### 5. Storage Boundary

`.adf` files are user-controlled SQLite databases. Opening an untrusted `.adf` file loads configuration, triggers, lambdas, and stored content.

**Controls:**
- Tools disabled by default — sensitive tools (`sys_fetch`, `shell`, `ws_*`) must be explicitly enabled
- `restricted` tools get automatic HIL when called from the LLM loop, and are blocked from unauthorized code
- Trigger lambdas only fire if the trigger type and scope are configured
- Identity secrets encrypted at rest with AES-256-GCM (PBKDF2 key derivation, 100k iterations, SHA-512)
- `code_access` flag gates per-key access from code execution
- File protection levels: `read_only` (immutable), `no_delete` (writable but not deletable)

**What this means:** An untrusted `.adf` file can contain malicious config, but sensitive capabilities require explicit enablement. The risk scales with what the user enables.

## Defense-in-Depth Layers

Security relies on multiple independent layers rather than any single control:

| Layer | Protects Against | Bypass Condition |
|-------|-----------------|------------------|
| DOMPurify | XSS from LLM/message HTML | DOMPurify mutation bypass (rare, patched quickly) |
| CSP `script-src 'self'` | Inline script injection | Not bypassable without `'unsafe-inline'` |
| CSP `connect-src` localhost | XSS data exfiltration | Not bypassable from renderer |
| `will-navigate` handler | Renderer hijacking to external pages | Not bypassable (Electron event) |
| Tool enablement | Unauthorized tool use from code | Config manipulation via `sys_update_config` (gated by lock fields). Agents cannot modify `restricted`/`restricted_methods` — owner only |
| `restricted` (HIL) | Autonomous execution of dangerous tools | Cannot be bypassed from unauthorized code — returns `REQUIRES_AUTHORIZED_CODE` |
| `require_middleware_authorization` | Untrusted middleware modifying messages | Unauthorized middleware silently skipped (default on) |
| Signature verification | Spoofed network messages | `allow_unsigned: true` disables this check |
| Fetch middleware | SSRF and unauthorized outbound requests | Only effective if configured |
| SQL sanitizer | Access to system tables from `db_query`/`db_execute` | Validated against allowlist after stripping comments/literals |

## Tool Access Control

Tool access is governed by three flags on each `ToolDeclaration`:

- **`enabled`** — whether the agent can use the tool in its LLM loop
- **`restricted`** — whether the tool requires authorization (optional, defaults to `false`)
- **`locked`** — whether the agent can modify this tool's config via `sys_update_config` (optional, defaults to `false`)

The access matrix:

| `enabled` | `restricted` | LLM loop | Authorized code | Unauthorized code |
|-----------|--------------|----------|-----------------|-------------------|
| `false`   | `false`      | Off      | Off             | Off               |
| `true`    | `false`      | Free     | Free            | Free              |
| `false`   | `true`       | Off      | Free            | Off               |
| `true`    | `true`       | HIL      | Free            | Off               |

When a tool is both `enabled` and `restricted`, LLM loop calls automatically get a human-in-the-loop approval prompt. Authorized code can call the tool directly without approval. Unauthorized code cannot call restricted tools at all — it receives a `REQUIRES_AUTHORIZED_CODE` error.

**`sys_lambda` authorization gate:** In addition to tool-level restriction, `sys_lambda` has argument-dependent HIL. When the LLM calls `sys_lambda` targeting an authorized file, the runtime triggers a HIL approval prompt regardless of whether `sys_lambda` itself is restricted. This ensures the user has visibility whenever the agent invokes code with elevated privileges from the conversation loop. See [Authorized Code Execution](authorized-code.md) for details.

**Self-modification protection:** Agents can toggle `enabled` on unlocked tools via `sys_update_config` (useful for token optimization), but **cannot modify `restricted`, `restricted_methods`, or `locked`** — these are owner-only security boundaries. Disabling a tool without locking it is a suggestion, not a boundary; to enforce a tool being off, lock it or disable `sys_update_config`.

Additionally, these tools are **excluded from code execution** entirely:
- `say` — prevents code from monopolizing chat output
- `ask` — prevents code from bypassing human-in-the-loop

The following methods are gated by `code_execution` config flags:
- `model_invoke` — direct LLM calls
- `sys_lambda` — execute lambda functions
- `task_resolve` — approve/deny intercepted tasks
- `loop_inject` — inject context into conversation loop
- `get_identity` / `set_identity` — read/write identity secrets

Code execution methods can also be individually restricted via `code_execution.restricted_methods`. Methods in this list can only be called from code that originates from an authorized file. This prevents agents from self-approving tasks, accessing credentials, or calling other sensitive methods from agent-written code.

See [Authorized Code Execution](authorized-code.md) for the full security model, authorization flow, governance patterns, and threat analysis.

## SQL Access Control

| Table Pattern | `db_query` | `db_execute` |
|--------------|-----------|-------------|
| `adf_loop`, `adf_inbox`, `adf_outbox`, `adf_files`, `adf_timers`, `adf_audit`, `adf_logs`, `adf_tasks` | Read-only | Blocked |
| `adf_meta`, `adf_config` | Blocked | Blocked |
| `adf_identity` | Blocked | Blocked |
| `local_*` | Read-only | Full access (INSERT, UPDATE, DELETE, CREATE, DROP) |
| PRAGMA table-valued functions | Blocked | Blocked |

SQL input is sanitized before validation: comments stripped, string literals replaced, multi-statement queries rejected.

## Shell Command Security

Shell commands go through a pre-flight AST analysis before execution:

1. The command is tokenized and parsed into an AST
2. Each resolved tool (including redirects like `>` mapping to `fs_write`) is checked against the agent's tool declarations
3. Disabled tools → rejection (exit 126)
4. Restricted tools → HIL task creation, human approval prompt (exit 130)

Commands are executed via `execFile` with array arguments (not shell strings), preventing shell injection.

## Identity and Cryptography

| Component | Algorithm | Parameters |
|-----------|-----------|------------|
| Encryption | AES-256-GCM | 12-byte IV, 16-byte auth tag |
| Key derivation | PBKDF2 | 100,000 iterations, SHA-512, 32-byte salt |
| Signing | Ed25519 | PKCS8/SPKI DER format |
| Agent identity | DID:key | `did:key:z{base58btc(0xed01 + pubkey)}` |

Identity secrets in `adf_identity` are encrypted with the derived key. The password is never stored — only the salt and KDF parameters. See [Security and Identity](security-and-identity.md) for the full identity lifecycle.

## Attacker-Controlled Inputs

These are the primary sources of untrusted data that flow through the system:

| Input | Entry Point | First Defense |
|-------|------------|---------------|
| LLM output | Agent loop | DOMPurify + CSP (renderer), tool validation (runtime) |
| Inbound ALF messages | Mesh server / adapters | Signature verification, allow/block lists, inbox middleware |
| `.adf` file contents | File open | Tool enablement defaults, restricted tools, lock fields |
| HTTP responses (`sys_fetch`) | Code execution | Fetch middleware pipeline |
| MCP server responses | MCP client | Tool result size limits (`max_tool_result_tokens`) |
| User-installed packages | `npm_install` | Native addon blocking, size limits |

## Default Security Posture

Out of the box, ADF Studio ships with a conservative default configuration:

- **Autonomous mode:** off — agent requires human input to act
- **Messaging receive:** off — no inbound messages accepted
- **Mesh server:** binds to `127.0.0.1` only
- **Sensitive tools** (`sys_fetch`, `shell`, `ws_*`): disabled by default
- **allow_unsigned:** true (appropriate for local development)
- **Identity encryption:** optional, activated by setting a password

## Operational Recommendations

### Local development
Leave defaults. No password needed. Unsigned messages are fine on localhost.

### Multi-agent local setup
Defaults still work. Consider marking powerful tools as `restricted` if agents interact with untrusted data.

### Internet-facing agents
1. Provision cryptographic identity (Ed25519 keypair)
2. Set `security.allow_unsigned: false`
3. Set a strong password to encrypt `adf_identity`
4. Configure allow/block lists for message senders
5. Enable `require_signature` and `require_payload_signature`
6. Configure fetch middleware to restrict outbound URLs
7. Review all enabled tools — disable anything not needed

### Sharing .adf files
An `.adf` file contains the full conversation history, documents, files, and configuration. Before sharing:
- Remove sensitive data from `adf_identity` or ensure password protection is set
- Review `adf_files` for sensitive content
- Consider cloning with selected tables to create a clean copy

### Reviewing untrusted .adf files
Before running an untrusted `.adf` file:
- Check enabled tools — disable `sys_fetch`, `shell`, and messaging tools
- Check triggers — system-scope lambdas can run without LLM intervention
- Check `code_execution` settings — disable `model_invoke` and `get_identity` if not needed
- Set `restricted: true` on any tools you want to monitor
