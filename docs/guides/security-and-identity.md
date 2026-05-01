# Security and Identity

ADF has a layered security model that starts simple (no keys, local only) and scales up to cryptographic identity for global mesh networking.

## Identity Model

ADF identity operates in two tiers:

### Local Identity (Default)

Every ADF is assigned a **12-character nanoid** at creation. This is the agent's `id` used for:

- Local message addressing
- Display in the UI
- Routing on the local mesh

No cryptographic keys are generated. Messages are unsigned. This is sufficient for local development and single-machine setups.

### Cryptographic Identity (Opt-In)

When an agent needs verified message signing or global mesh participation, a cryptographic identity is provisioned:

- **Keypair:** Ed25519 (fast, standard for modern P2P systems)
- **Agent ID:** Upgraded from nanoid to DID format (`did:adf:...`) derived from the public key
- **Signing:** Every outbound message is signed by the runtime using the private key
- **Verification:** Receiving runtimes verify signatures before accepting messages

### Provisioning Cryptographic Identity

You can provision identity through:

1. **ADF Studio** — Use the Identity panel in the Agent tab
2. **ADF CLI** — Run `adf identity init`
3. **Parent agent** — A parent can inject keys when creating a child agent via `sys_create_adf`
4. **Template** — When creating an agent from a template via `sys_create_adf`, fresh identity keys are generated automatically. Non-signing credentials (API keys, MCP credentials) from the template are preserved

Once provisioned, the agent's `id` in config is updated to the DID. This is permanent — you can't downgrade back to a nanoid.

## The Identity Store (adf_identity)

The `adf_identity` table is a general-purpose encrypted secret store. It's empty by default.

### Common Entries

| Purpose | Description |
|---------|-------------|
| `identity` | Ed25519 private key for message signing |
| `wallet_eth` | Secp256k1 key for Ethereum (optional) |
| `openai_key` | API key for LLM provider |
| `mcp:*` | API keys for MCP servers |
| Any custom key | Any other secrets the agent needs |

API keys and other non-cryptographic secrets can be stored here regardless of whether a cryptographic identity has been provisioned. The table serves as a general-purpose encrypted store.

### Managing Identity in the UI

The **Agent > Identity** tab lets you:

- View all identity entries (purpose and encryption status)
- Reveal secret values temporarily
- Delete individual entries
- Wipe all identity data
- Claim ownership (regenerate keys)

## Encryption at Rest

Private keys and secrets in `adf_identity` are encrypted using:

- **Cipher:** AES-256-GCM (12-byte IV, 16-byte auth tag)
- **Key Derivation:** PBKDF2 (100,000 iterations, SHA-512, 32-byte salt)
- **AEAD:** Authenticated encryption ensures tamper detection

### The "Safety Deposit Box" Model

Think of it like a house with a safe:

- The `.adf` file (the house) is generally readable — anyone can see the agent's name, description, and public files
- The `adf_identity` table (the safe) is encrypted — only the password holder can access secrets
- Public information is accessible; private keys are not

## Password Protection

When `adf_identity` contains encrypted entries, the ADF file can be password-protected.

### Setting a Password

In the **Agent > Identity** panel:

1. Click **Set Password**
2. Enter a password
3. All identity entries are encrypted with the derived key
4. The password is never stored — only the derived key (in memory) and encryption parameters (in the database)

### Changing or Removing a Password

You can change or remove the password from the Identity panel. Changing a password re-encrypts all entries with the new key.

## Locked vs. Unlocked State

When an ADF has encrypted identity entries, it operates in one of two states:

### Locked

| Capability | Available |
|-----------|-----------|
| Receive messages | Yes |
| Read files | Yes |
| Run document triggers | Yes |
| Serve public files | Yes |
| Send signed messages | **No** |
| Access secrets (API keys) | **No** |

A locked agent can still receive and store messages, but cannot think (no API key access) or send signed messages.

### Unlocked

All capabilities are available. The agent can sign messages, access API keys, and operate fully.

### Unlocking Flow

1. User opens the ADF file (or runs `adf start agent.adf`)
2. Runtime detects encrypted identity entries
3. Password dialog appears
4. Password is run through PBKDF2 to derive the encryption key
5. AEAD tag verification confirms the correct password
6. Private key is held in RAM — never written to disk unencrypted
7. Agent is fully operational

## Unsigned Messages

For local development and agents without cryptographic identity:

- `security.allow_unsigned: true` (the default) allows messages without signatures
- Messages with `signature = NULL` are accepted for local delivery
- The runtime warns when connecting to the internet mesh with unsigned messages enabled

### Internet Mesh Requirements

For internet mesh connections, you must:

1. Set `security.allow_unsigned: false`
2. Provision a cryptographic identity
3. All outbound messages will be signed
4. All inbound messages must have valid signatures

## Security Settings

### allow_unsigned

When `true` (default), accepts messages without cryptographic signatures. Set to `false` for internet-facing agents.

### allow_protected_writes

When `true`, the agent can overwrite files with `no_delete` protection (like `document.md` and `mind.md`). Default: `false`.

This is a safety measure — most agents should read their document and instructions but not be able to overwrite them. Enable this only for agents that need to manage their own document content.

Note: Files with `read_only` protection cannot be written to regardless of this setting. See [Documents and Files > File Protection Levels](documents-and-files.md#file-protection-levels) for the full three-level system.

## Custom Middleware

The security section also configures [custom middleware](middleware.md) for message and fetch pipelines:

- `security.middleware.inbox` — Lambda chain for inbound messages (after verification, before storage)
- `security.middleware.outbox` — Lambda chain for outbound messages (after envelope build, before signing)
- `security.fetch_middleware` — Lambda chain for `sys_fetch` requests (before HTTP call)

See the [Middleware Guide](middleware.md) for full details, configuration, and examples.

## Best Practices

1. **Local development:** Leave defaults (`allow_unsigned: true`, no password). Keep it simple.
2. **Multi-agent local setup:** Still fine with defaults. Unsigned messages work on LAN.
3. **Internet-facing agents:** Provision cryptographic identity, set `allow_unsigned: false`, use a strong password.
4. **API key management:** Store API keys in `adf_identity` rather than in plain config. They'll be encrypted with the agent's password.
5. **Agent spawning:** When a parent creates a child, inject only the API keys the child needs. Follow the principle of least privilege.
