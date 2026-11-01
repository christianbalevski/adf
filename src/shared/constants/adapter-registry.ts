/**
 * Curated registry of well-known channel adapters.
 * Used by the adapter dashboard for quick install and by the first-open modal.
 */

import type { AdapterRegistration, AdaptersConfig, AdapterInstanceConfig } from '../types/channel-adapter.types'

export interface AdapterRegistryEntry {
  /** Short identifier used as adapter type key */
  type: string
  /** Human-readable display name */
  displayName: string
  /** npm package name (not needed for built-in adapters) */
  npmPackage?: string
  /** Whether this adapter is built into the app (no npm install needed) */
  builtIn?: boolean
  /** Description of what the adapter provides */
  description: string
  /** Required credential keys (stored in adf_identity) */
  requiredEnvKeys: string[]
  /** Optional credential keys */
  optionalEnvKeys?: string[]
  /** Repository/docs URL */
  repo?: string
  /** Setup guide URL (adapter section of the online docs) */
  docsUrl?: string
  /** Whether this is a verified/recommended adapter */
  verified: boolean
  /** Brand mark key for the Settings tiles (see adapters/ChannelBrandIcon) */
  iconKey?: string
  /** One-line pitch shown on the Settings tile */
  tagline?: string
  /** Human labels + hints for each credential key, in display order */
  credentials?: AdapterCredentialField[]
  /** Short, numbered setup steps shown next to the form */
  setupSteps?: AdapterSetupStep[]
  /** Connects by scanning a code instead of pasting a token: the setup dialog shows the live QR */
  pairing?: 'qr'
}

export interface AdapterCredentialField {
  /** Identity purpose suffix: `adapter:<type>:<key>` */
  key: string
  label: string
  required: boolean
  placeholder?: string
  hint?: string
}

export interface AdapterSetupStep {
  text: string
  /** Optional link the step points at (opens in the browser) */
  url?: string
}

const MESSAGING_GUIDE_URL = 'https://github.com/christianbalevski/adf/blob/main/docs/guides/messaging.md'

export const ADAPTER_REGISTRY: AdapterRegistryEntry[] = [
  {
    type: 'telegram',
    displayName: 'Telegram',
    builtIn: true,
    description: 'Receive and send Telegram messages via a bot token',
    tagline: 'A bot in your DMs and groups. One token from BotFather.',
    iconKey: 'telegram',
    requiredEnvKeys: ['TELEGRAM_BOT_TOKEN'],
    credentials: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot token', required: true, placeholder: '123456789:AA…', hint: 'From @BotFather after /newbot.' },
    ],
    setupSteps: [
      { text: 'Open @BotFather in Telegram and send /newbot. Pick a name and a username ending in "bot".', url: 'https://t.me/BotFather' },
      { text: 'Copy the token BotFather replies with and paste it below.' },
      { text: 'Message your bot once so it can see you. For groups, add the bot and mention it.' },
    ],
    docsUrl: `${MESSAGING_GUIDE_URL}#telegram-adapter`,
    verified: true
  },
  {
    type: 'email',
    displayName: 'Email',
    builtIn: true,
    description: 'Send and receive email via IMAP/SMTP',
    tagline: 'Any mailbox with IMAP and SMTP. Gmail, iCloud, Outlook, Fastmail, self-hosted.',
    iconKey: 'email',
    requiredEnvKeys: ['EMAIL_USERNAME', 'EMAIL_PASSWORD'],
    credentials: [
      { key: 'EMAIL_USERNAME', label: 'Email address', required: true, placeholder: 'agent@example.com', hint: 'Servers are detected from the domain. Custom hosts go in the agent config.' },
      { key: 'EMAIL_PASSWORD', label: 'App password', required: true, placeholder: '••••••••', hint: 'An app-specific password, not the account password.' },
    ],
    setupSteps: [
      { text: 'Turn on two-factor authentication for the mailbox. Most providers require it for app passwords.' },
      { text: 'Create an app-specific password in the provider\'s security settings (Gmail: myaccount.google.com/apppasswords).', url: 'https://myaccount.google.com/apppasswords' },
      { text: 'Enter the full address and that app password below. IMAP and SMTP hosts are detected from the domain.' },
    ],
    docsUrl: `${MESSAGING_GUIDE_URL}#email-adapter`,
    verified: true
  },
  {
    type: 'discord',
    displayName: 'Discord',
    builtIn: true,
    description: 'Receive and send Discord messages via a bot token (DMs, guilds, /<botname> slash command)',
    tagline: 'A bot in servers and DMs, with an optional slash command.',
    iconKey: 'discord',
    requiredEnvKeys: ['DISCORD_BOT_TOKEN'],
    optionalEnvKeys: ['DISCORD_APPLICATION_ID'],
    credentials: [
      { key: 'DISCORD_BOT_TOKEN', label: 'Bot token', required: true, placeholder: 'MTA…', hint: 'Bot page → Reset Token. Discord shows it once.' },
      { key: 'DISCORD_APPLICATION_ID', label: 'Application ID', required: false, placeholder: '1234567890', hint: 'Optional. Registers a /<botname> slash command.' },
    ],
    setupSteps: [
      { text: 'Create an application in the Discord Developer Portal.', url: 'https://discord.com/developers/applications' },
      { text: 'On the Bot page click Reset Token and copy it. Under Privileged Gateway Intents turn on Message Content Intent and save.' },
      { text: 'Invite the bot with the "bot" and "applications.commands" scopes and permission to view channels, read history, send messages, and attach files.' },
    ],
    docsUrl: `${MESSAGING_GUIDE_URL}#discord-adapter`,
    verified: true
  },
  {
    type: 'slack',
    displayName: 'Slack',
    builtIn: true,
    description: 'Receive and send Slack messages via Socket Mode (app token + bot token, no public endpoint)',
    tagline: 'Socket Mode: no public URL. Two tokens from api.slack.com.',
    iconKey: 'slack',
    requiredEnvKeys: ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'],
    credentials: [
      { key: 'SLACK_APP_TOKEN', label: 'App-level token', required: true, placeholder: 'xapp-…', hint: 'Socket Mode page. Needs the connections:write scope.' },
      { key: 'SLACK_BOT_TOKEN', label: 'Bot user OAuth token', required: true, placeholder: 'xoxb-…', hint: 'Install App page, after installing to the workspace.' },
    ],
    setupSteps: [
      { text: 'Create a Slack app from scratch and pick the workspace.', url: 'https://api.slack.com/apps' },
      { text: 'Socket Mode page: enable it and copy the xapp- token.' },
      { text: 'Event Subscriptions: enable events and subscribe the bot to message.channels, message.groups, message.im, message.mpim. Without these the socket connects but stays silent.' },
      { text: 'OAuth & Permissions: add chat:write, im:write, users:read, channels:read, groups:read, im:read, mpim:read, files:read, files:write. App Home: enable the Messages tab.' },
      { text: 'Install (or reinstall) the app and copy the xoxb- bot token. Invite the bot to each channel it should read.' },
    ],
    docsUrl: `${MESSAGING_GUIDE_URL}#slack-adapter`,
    verified: true
  },
  {
    type: 'whatsapp',
    displayName: 'WhatsApp · Linked number',
    builtIn: true,
    description: 'Give the agent its own WhatsApp number by linking it as a device (QR code, like WhatsApp Web). Anyone can message that number, including in groups. Unofficial protocol — WhatsApp may ban the number, so use a spare one.',
    tagline: 'The agent gets its own number that anyone can message. Scan a QR; use a spare number.',
    iconKey: 'whatsapp',
    requiredEnvKeys: [],
    credentials: [],
    pairing: 'qr',
    setupSteps: [
      { text: 'Get a spare WhatsApp number for the agent. It becomes the agent: people message that number to reach it. Unofficial client, so the number can be banned — never use your main one.' },
      { text: 'Pick the agent and click Connect. Start the agent if it is not running.' },
      { text: 'A QR code appears here. On the agent\'s phone open WhatsApp → Settings → Linked Devices → Link a device and scan it. It refreshes every minute until scanned.' },
      { text: 'Message the agent\'s number from a different WhatsApp account. Messages the linked number sends itself, including "Message yourself", are ignored.' },
    ],
    docsUrl: `${MESSAGING_GUIDE_URL}#whatsapp-linked-number-adapter`,
    verified: true
  },
  {
    type: 'whatsapp_agent',
    displayName: 'WhatsApp · Official agent',
    builtIn: true,
    description: 'Chat with the agent from your own WhatsApp through WhatsApp\'s official Agents feature (Settings → Agents). Only you can message it, 1:1 only. Not end-to-end encrypted. The Agents feature is still rolling out.',
    tagline: 'Chat with your agent from your own WhatsApp. Official, private 1:1. Paste the agent\'s API key.',
    iconKey: 'whatsapp',
    requiredEnvKeys: ['WHATSAPP_AGENT_API_KEY'],
    credentials: [
      { key: 'WHATSAPP_AGENT_API_KEY', label: 'Agent API key', required: true, placeholder: 'Paste the key from WhatsApp', hint: 'Agent\'s chat → Chat info → API key. Re-creating the agent issues a new key.' },
    ],
    setupSteps: [
      { text: 'In WhatsApp open Settings → Agents → Create an agent and give it a name. No Agents entry yet? The feature is still rolling out to accounts.' },
      { text: 'Open the new agent\'s chat → Chat info → API key, and copy it.' },
      { text: 'Pick the ADF agent here, paste the key, and click Connect.' },
      { text: 'Message the agent from that chat. Only you can reach it, and messages pass through Meta unencrypted.' },
    ],
    docsUrl: `${MESSAGING_GUIDE_URL}#whatsapp-official-agent-adapter`,
    verified: true
  }
]

const BUILT_IN_ADAPTER_REGISTRATIONS: AdapterRegistration[] = ADAPTER_REGISTRY
  .filter((entry) => entry.builtIn)
  .map((entry) => ({
    id: entry.type,
    type: entry.type,
    managed: false
  }))

/**
 * Return app/runtime adapter registrations with built-in adapters always present.
 *
 * User-provided registrations for the same type win, so package metadata is
 * preserved. (Credentials never live on a registration; they are per agent.)
 */
export function withBuiltInAdapterRegistrations(
  registrations?: AdapterRegistration[] | null,
): AdapterRegistration[] {
  const builtInsByType = new Map(BUILT_IN_ADAPTER_REGISTRATIONS.map((entry) => [entry.type, entry]))
  const seenTypes = new Set<string>()
  const merged: AdapterRegistration[] = []

  for (const registration of registrations ?? []) {
    const builtIn = builtInsByType.get(registration.type)
    merged.push(builtIn ? { ...builtIn, ...registration } : { ...registration })
    seenTypes.add(registration.type)
  }

  for (const builtIn of BUILT_IN_ADAPTER_REGISTRATIONS) {
    if (!seenTypes.has(builtIn.type)) {
      merged.push({ ...builtIn })
    }
  }

  return merged
}

/**
 * The registrations an agent's runtime must try to start: every known one,
 * plus a bare registration for each channel the agent enables that this
 * runtime does not know (it then fails to start with a reason instead of
 * being skipped silently).
 */
export function withAgentEnabledAdapterRegistrations(
  registrations: AdapterRegistration[],
  adapters: AdaptersConfig | undefined,
): AdapterRegistration[] {
  const known = new Set(registrations.map((r) => r.type))
  const extra = Object.keys(adapters ?? {})
    .filter((type) => !known.has(type) && getEnabledAgentAdapterConfig(adapters, type))
    .map((type): AdapterRegistration => ({ id: type, type, managed: false }))
  return extra.length ? [...registrations, ...extra] : registrations
}

/**
 * Look up a registry entry by adapter type.
 */
export function findAdapterRegistryEntry(type: string): AdapterRegistryEntry | undefined {
  return ADAPTER_REGISTRY.find((e) => e.type === type)
}

/**
 * Look up a registry entry by npm package name.
 */
export function findAdapterRegistryEntryByPackage(npmPackage: string): AdapterRegistryEntry | undefined {
  return ADAPTER_REGISTRY.find((e) => e.npmPackage === npmPackage)
}

/**
 * Return the per-agent adapter config only when the agent explicitly enables it.
 *
 * Runtime registrations make adapters available globally, but they must not
 * auto-start for every agent just because the adapter exists in app settings.
 */
export function getEnabledAgentAdapterConfig(
  adapters: AdaptersConfig | undefined,
  type: string,
): AdapterInstanceConfig | null {
  const config = adapters?.[type]
  return config?.enabled === true ? config : null
}
