/**
 * Curated registry of well-known MCP servers.
 * Used by the status dashboard for quick install and by the first-open modal.
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
    npmPackage: '@brave/brave-search-mcp-server',
    description: 'Search the web using Brave Search API',
    category: 'tools',
    requiredEnvKeys: ['BRAVE_API_KEY'],
    repo: 'https://github.com/brave/brave-search-mcp-server',
    verified: true
  },
  {
    name: 'puppeteer',
    displayName: 'Puppeteer',
    npmPackage: '@modelcontextprotocol/server-puppeteer',
    description: 'Browser automation with Puppeteer',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer',
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
    npmPackage: 'mcp-discord',
    description: 'Discord bot integration for messages, channels, forums, and webhooks',
    category: 'communication',
    requiredEnvKeys: ['DISCORD_TOKEN'],
    repo: 'https://github.com/barryyip0625/mcp-discord',
    verified: false
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
