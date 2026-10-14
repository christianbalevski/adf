import { IPC } from '../../../src/shared/constants/ipc-channels'
import { MOCK_PROVIDER_ID } from '../harness/fixtures'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * Settings and provider parity scenarios (tracker W3-B). Each is the
 * renderer's own call sequence (preload `window.adfApi` → channel):
 * Settings → Providers (useProviderManager, SettingsPage's debounced save)
 * and an agent's provider copies (AgentProviders, ProviderAgentOverrides).
 */

type Provider = Record<string, unknown> & { id: string; apiKey?: string }

async function appProviders(ctx: ScenarioContext): Promise<Provider[]> {
  const settings = await ctx.invoke<{ providers?: Provider[] }>(IPC.SETTINGS_GET)
  return settings.providers ?? []
}

const SECOND_ID = 'custom:w3b001'

/**
 * Settings → Providers: add a provider with a key, edit an existing one, and
 * save the whole list back as SettingsPage does: each existing entry with
 * the apiKey the read gave it (the real key in embedded mode, `__redacted__`
 * in daemon mode, §4.2). Then the model list and a client key. The state
 * shows the stored keys: unchanged for the edited provider, the new key for
 * the added one, never the placeholder.
 */
export const providerRoundTripScenario: ParityScenario = {
  name: 'provider-round-trip',
  description: 'Add a provider with a key, edit another, save the list back with the keys as read, list models, change the theme.',
  fixtures: [],
  quietMs: 500,
  async run(ctx) {
    const providers = await appProviders(ctx)
    const added: Provider = { id: SECOND_ID, type: 'openai-compatible', preset: 'custom', name: 'Second LLM', baseUrl: ctx.llm.baseUrl, apiKey: 'sk-second', defaultModel: '', params: [] }
    // pick(): persist the new entry right away.
    await ctx.invoke(IPC.SETTINGS_SET, { providers: [...providers, added], defaultProviderId: MOCK_PROVIDER_ID })
    // The form edits the parity provider's name; the debounced save writes the list as the renderer holds it.
    const read = await appProviders(ctx)
    const edited = read.map((p) => (p.id === MOCK_PROVIDER_ID ? { ...p, name: 'Parity LLM (edited)' } : p))
    await ctx.invoke(IPC.SETTINGS_SET, { providers: edited, defaultProviderId: MOCK_PROVIDER_ID })
    await ctx.invoke(IPC.MODELS_LIST, { provider: MOCK_PROVIDER_ID })
    await ctx.invoke(IPC.MODELS_LIST, { provider: 'no-such-provider' })
    await ctx.invoke(IPC.SETTINGS_SET, { theme: 'dark' })
    await ctx.invoke(IPC.SETTINGS_GET)
  },
}

/**
 * An agent's own provider copy, on a file that is not open (Settings →
 * Providers → agent overrides, and the agent's Providers list): attach,
 * set its key, replace it, "Copy app key" (the renderer sends the app key as
 * it read it: `__redacted__` in daemon mode), read it back for the form,
 * the key-source badge, then detach.
 */
export const agentProviderKeyScenario: ParityScenario = {
  name: 'agent-provider-key',
  description: 'On agent-1 (not open): attach a provider copy, set and replace its key, copy the app key, read it back, detach it.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 500,
  async run(ctx) {
    const filePath = ctx.agent('agent-1').filePath
    const app = (await appProviders(ctx)).find((p) => p.id === MOCK_PROVIDER_ID)!
    const copy = { id: MOCK_PROVIDER_ID, type: 'openai-compatible', name: 'Parity LLM', baseUrl: ctx.llm.baseUrl, defaultModel: 'parity-model' }
    const entries = [{ id: MOCK_PROVIDER_ID, type: 'openai-compatible', baseUrl: ctx.llm.baseUrl }]
    await ctx.invoke(IPC.PROVIDER_ATTACH, { filePath, provider: copy })
    await ctx.invoke(IPC.PROVIDER_AGENT_KEY_SOURCES, { filePath, providers: entries })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath, providerId: MOCK_PROVIDER_ID, value: 'sk-agent-1' })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath, providerId: MOCK_PROVIDER_ID })
    // Replace key.
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath, providerId: MOCK_PROVIDER_ID, value: 'sk-agent-2' })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath, providerId: MOCK_PROVIDER_ID })
    await ctx.invoke(IPC.PROVIDER_AGENT_KEY_SOURCES, { filePath, providers: entries })
    // Copy app key: the key exactly as the settings read gave it.
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath, providerId: MOCK_PROVIDER_ID, value: app.apiKey })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath, providerId: MOCK_PROVIDER_ID })
    await ctx.invoke(IPC.MODELS_LIST, { provider: MOCK_PROVIDER_ID, filePath })
    await ctx.invoke(IPC.PROVIDER_ATTACH, { filePath, provider: { ...copy, defaultModel: 'parity-model-2' } })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_LIST_FILES, { providerId: MOCK_PROVIDER_ID })
    await ctx.invoke(IPC.PROVIDER_DETACH, { filePath, providerId: MOCK_PROVIDER_ID })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath, providerId: MOCK_PROVIDER_ID })
  },
}

/** Sign-in state with no session anywhere: status and sign-out of ChatGPT and Grok. */
export const subscriptionStatusScenario: ParityScenario = {
  name: 'subscription-status',
  description: 'ChatGPT and Grok sign-in status with no session, sign out, status again.',
  fixtures: [],
  quietMs: 500,
  async run(ctx) {
    await ctx.invoke(IPC.CHATGPT_AUTH_STATUS)
    await ctx.invoke(IPC.GROK_AUTH_STATUS)
    await ctx.invoke(IPC.CHATGPT_AUTH_LOGOUT)
    await ctx.invoke(IPC.GROK_AUTH_LOGOUT)
    await ctx.invoke(IPC.CHATGPT_AUTH_STATUS)
    await ctx.invoke(IPC.GROK_AUTH_STATUS)
  },
}

/**
 * An agent whose credentials are locked on this machine (sealed to another
 * owner, openable with a share password), not open: the agent overrides
 * form saves its provider key over the sealed one, then a key for a
 * provider it has no key for yet. Both modes ask Replace / Cancel
 * (services/locked-credential-dialog.ts); every dialog is answered Replace.
 */
export const lockedCredentialsScenario: ParityScenario = {
  name: 'locked-credentials',
  description: 'agent-1 with credentials sealed to another owner (not open): replace the sealed provider key, add a key for another provider.',
  fixtures: [{ name: 'agent-1', lockedCredentials: { sharePassword: 'share-pw-1' } }],
  quietMs: 500,
  async run(ctx) {
    const filePath = ctx.agent('agent-1').filePath
    ctx.setDialogs({ showMessageBox: () => ({ response: 0 }) })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath, providerId: MOCK_PROVIDER_ID, value: 'sk-new' })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_SET, { filePath, providerId: 'other-llm', value: 'sk-other' })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath, providerId: MOCK_PROVIDER_ID })
    await ctx.invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath, providerId: 'other-llm' })
  },
}

export const SETTINGS_SCENARIOS: readonly ParityScenario[] = [providerRoundTripScenario, agentProviderKeyScenario, subscriptionStatusScenario, lockedCredentialsScenario]
/** Run against embedded Studio only, each with the reason (above). */
export const SETTINGS_EMBEDDED_ONLY: readonly ParityScenario[] = []
