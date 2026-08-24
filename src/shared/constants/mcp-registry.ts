/**
 * Curated registry of well-known MCP servers.
 * Used by the "Add MCP Server" modal's Quick-add cards (McpAddServerModal),
 * which prefill the configuration form from an entry.
 */

export interface McpRegistryEntry {
  /** Short identifier used for tool prefixing */
  name: string
  /** Human-readable display name */
  displayName: string
  /** npm package name (for Node servers) */
  npmPackage?: string
  /** PyPI package name (for Python servers) */
  pypiPackage?: string
  /** Runtime — default 'node' for backward compat */
  runtime?: 'node' | 'python'
  /** Description of what the server provides */
  description: string
  /** Category for grouping */
  category: 'tools' | 'data' | 'dev' | 'communication' | 'web'
  /** Required environment variable keys */
  requiredEnvKeys: string[]
  /** Optional environment variable keys */
  optionalEnvKeys?: string[]
  /** Repository/docs URL */
  repo?: string
  /** Whether this is a verified/recommended server */
  verified: boolean
  /**
   * Brand-logo key for the quick-add card (see BrandIcon). Maps to a Simple
   * Icons mark rendered in the brand's official color. Omit for servers with
   * no brand mark — they fall back to a monochrome category glyph.
   */
  iconKey?: string
  /** Interactive auth preflight (OAuth etc.) this server needs before first use. */
  auth?: boolean
  /** Args passed to the server during the auth preflight (e.g. ["auth"]). */
  authArgs?: string[]
  /** File-shaped credentials the server reads/writes (declarations only). */
  credentialFiles?: { path: string; required?: boolean; writeBack?: boolean }[]
  /**
   * What the user must obtain/enable in their own account before this server
   * can work — rendered as a callout on the quick-add card and next to the
   * matching credential-file drop input.
   */
  prerequisite?: string
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
  {
    name: 'filesystem',
    displayName: 'Filesystem',
    npmPackage: '@modelcontextprotocol/server-filesystem',
    description: 'Read, write, and manage local files and directories',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem',
    verified: true
  },
  {
    name: 'github',
    displayName: 'GitHub',
    iconKey: 'github',
    npmPackage: '@modelcontextprotocol/server-github',
    description: 'Interact with GitHub repositories, issues, and pull requests',
    category: 'dev',
    requiredEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    repo: 'https://github.com/modelcontextprotocol/servers',
    verified: true
  },
  {
    name: 'memory',
    displayName: 'Memory',
    npmPackage: '@modelcontextprotocol/server-memory',
    description: 'Persistent knowledge graph memory for agents',
    category: 'data',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/blob/main/src/memory',
    verified: true
  },
  {
    name: 'brave-search',
    displayName: 'Brave Search',
    iconKey: 'brave',
    npmPackage: '@brave/brave-search-mcp-server',
    description: 'Search the web using Brave Search API',
    category: 'tools',
    requiredEnvKeys: ['BRAVE_API_KEY'],
    repo: 'https://github.com/brave/brave-search-mcp-server',
    verified: true
  },
  {
    name: 'playwright',
    displayName: 'Playwright Browser',
    npmPackage: '@playwright/mcp',
    description: 'Maintained browser automation that attaches to the agent\'s persistent visible Chromium session',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/microsoft/playwright-mcp',
    verified: true
  },
  {
    name: 'slack',
    displayName: 'Slack',
    npmPackage: '@modelcontextprotocol/server-slack',
    description: 'Interact with Slack workspaces',
    category: 'communication',
    requiredEnvKeys: ['SLACK_BOT_TOKEN'],
    optionalEnvKeys: ['SLACK_TEAM_ID'],
    repo: 'https://github.com/modelcontextprotocol/servers',
    verified: true
  },
  {
    name: 'sequential-thinking',
    displayName: 'Sequential Thinking',
    npmPackage: '@modelcontextprotocol/server-sequential-thinking',
    description: 'Dynamic, reflective problem-solving through thought sequences',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    verified: true
  },
  {
    name: 'mail',
    displayName: 'Mail (IMAP/SMTP)',
    npmPackage: 'mcp-mail-server',
    description: 'Search, read, and send email via IMAP and SMTP',
    category: 'communication',
    requiredEnvKeys: ['IMAP_HOST', 'IMAP_PORT', 'IMAP_SECURE', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'EMAIL_USER', 'EMAIL_PASS'],
    repo: 'https://github.com/yunfeizhu/mcp-mail-server',
    verified: false
  },
  {
    name: 'resend',
    displayName: 'Resend',
    npmPackage: 'resend-mcp',
    description: 'Send emails, manage contacts, and broadcasts via the Resend platform',
    category: 'communication',
    requiredEnvKeys: ['RESEND_API_KEY'],
    optionalEnvKeys: ['SENDER_EMAIL_ADDRESS', 'REPLY_TO_EMAIL_ADDRESSES'],
    repo: 'https://github.com/resend/resend-mcp',
    verified: true
  },
  {
    name: 'telegram',
    displayName: 'Telegram',
    iconKey: 'telegram',
    npmPackage: '@iqai/mcp-telegram',
    description: 'Interact with Telegram via bot API for messaging and channel management',
    category: 'communication',
    requiredEnvKeys: ['TELEGRAM_BOT_TOKEN'],
    repo: 'https://github.com/IQAIcom/mcp-telegram',
    verified: false
  },
  {
    name: 'discord',
    displayName: 'Discord',
    iconKey: 'discord',
    npmPackage: 'mcp-discord',
    description: 'Discord bot integration for messages, channels, forums, and webhooks',
    category: 'communication',
    requiredEnvKeys: ['DISCORD_TOKEN'],
    repo: 'https://github.com/barryyip0625/mcp-discord',
    verified: false
  },
  {
    name: 'google-drive',
    displayName: 'Google Drive',
    iconKey: 'google-drive',
    npmPackage: '@piotr-agier/google-drive-mcp',
    description: 'Read, search, and manage Google Drive, Docs, Sheets, and Slides',
    category: 'data',
    requiredEnvKeys: [],
    repo: 'https://github.com/piotr-agier/google-drive-mcp',
    verified: false,
    auth: true,
    authArgs: ['auth'],
    credentialFiles: [
      { path: '~/.config/google-drive-mcp/gcp-oauth.keys.json', required: true },
      { path: '~/.config/google-drive-mcp/tokens.json' },
    ],
    prerequisite: 'Needs a Google OAuth client JSON (Desktop app) from console.cloud.google.com with the Drive, Docs, Sheets, and Slides APIs enabled.'
  },
  {
    name: 'gmail',
    displayName: 'Gmail',
    iconKey: 'gmail',
    npmPackage: '@gongrzhe/server-gmail-autoauth-mcp',
    description: 'Search, read, label, and send Gmail',
    category: 'communication',
    requiredEnvKeys: [],
    repo: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    verified: false,
    auth: true,
    authArgs: ['auth'],
    credentialFiles: [
      { path: '~/.gmail-mcp/gcp-oauth.keys.json', required: true },
      { path: '~/.gmail-mcp/credentials.json' },
    ],
    prerequisite: 'Needs a Google OAuth client JSON (Desktop app) from console.cloud.google.com with the Gmail API enabled.'
  },
  {
    name: 'twilio',
    displayName: 'Twilio SMS',
    npmPackage: '@deshartman/twilio-messaging-mcp-server',
    description: 'Send and receive SMS messages via the Twilio Messaging API',
    category: 'communication',
    requiredEnvKeys: ['NGROK_AUTH_TOKEN', 'ACCOUNT_SID', 'API_KEY', 'API_SECRET', 'TWILIO_NUMBER'],
    optionalEnvKeys: ['NGROK_CUSTOM_DOMAIN'],
    repo: 'https://github.com/deshartman/twilio-messaging-mcp-server',
    verified: false
  }
]

/**
 * Build a Settings registration draft from a curated entry. User-initiated
 * Settings installs default to host (the explicit choice is the trust
 * decision; no Podman required) — shared by the Add-server modal and tests.
 */
export function registrationFromRegistryEntry(entry: McpRegistryEntry, id: string): import('../types/ipc.types').McpServerRegistration {
  const isPython = entry.runtime === 'python'
  return {
    id,
    name: entry.name,
    type: isPython ? 'uvx' : 'npm',
    npmPackage: isPython ? undefined : entry.npmPackage,
    pypiPackage: isPython ? entry.pypiPackage : undefined,
    description: entry.description,
    managed: true,
    env: [...entry.requiredEnvKeys, ...(entry.optionalEnvKeys ?? [])].map((k) => ({ key: k, value: '' })),
    repo: entry.repo,
    runLocation: 'host',
    ...(entry.auth ? { auth: true } : {}),
    ...(entry.authArgs ? { authArgs: entry.authArgs } : {}),
    ...(entry.credentialFiles ? { credentialFiles: entry.credentialFiles.map((f) => ({ ...f })) } : {}),
  }
}

/**
 * Look up a registry entry by npm package name.
 */
export function findRegistryEntry(npmPackage: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.npmPackage === npmPackage)
}

/**
 * Look up a registry entry by PyPI package name.
 */
export function findRegistryEntryByPypiPackage(pypiPackage: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.pypiPackage === pypiPackage)
}

/**
 * Look up a registry entry by short name.
 */
export function findRegistryEntryByName(name: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.name === name)
}
