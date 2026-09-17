/**
 * Provider catalog — every service a user can connect from Settings → Providers.
 *
 * The catalog is a presentation layer over the small set of runtime provider
 * *types* (`PROVIDER_TYPES`): most entries are OpenAI-compatible endpoints that
 * differ only in base URL and branding. A user picks "Groq", not "OpenAI
 * compatible, then paste https://api.groq.com/openai/v1". The entry's `key` is
 * remembered on the saved `ProviderConfig.preset` so the row keeps its logo and
 * label; the runtime only ever sees `type` + `baseUrl`.
 *
 * Base URLs are the providers' documented OpenAI-compatible roots. A wrong URL
 * fails plainly on Test / Fetch models and is editable in the form.
 */

import type { ProviderType } from './adf-defaults'

export type ProviderCatalogGroup = 'subscription' | 'api' | 'local' | 'other'

export interface ProviderCatalogEntry {
  /** Stable key stored on ProviderConfig.preset */
  key: string
  /** Display name and default provider name ("Groq", "Groq 2", ...) */
  label: string
  /** Runtime provider type (which AI SDK factory runs it) */
  type: ProviderType
  group: ProviderCatalogGroup
  /** Prefilled base URL (openai-compatible entries) */
  baseUrl?: string
  /** One line under the tile */
  description: string
  /** Placeholder for the API key field */
  keyPlaceholder?: string
  /** Placeholder / example for the default model field */
  modelPlaceholder?: string
  /** Simple Icons key handled by ProviderBrandIcon; absent = monogram tile */
  iconKey?: string
  /** Local servers need no key */
  keyOptional?: boolean
  /** Where the user gets a key */
  keysUrl?: string
}

export const PROVIDER_CATALOG_GROUPS: { id: ProviderCatalogGroup; label: string; hint: string }[] = [
  { id: 'subscription', label: 'Subscriptions', hint: 'Sign in with an existing consumer plan. No API key.' },
  { id: 'api', label: 'APIs', hint: 'Pay-as-you-go endpoints. Paste an API key.' },
  { id: 'local', label: 'Local', hint: 'Servers running on this machine. Usually no key.' },
  { id: 'other', label: 'Other', hint: 'Anything that speaks the OpenAI API.' },
]

const oc = (
  key: string,
  label: string,
  baseUrl: string,
  description: string,
  extra: Partial<ProviderCatalogEntry> = {},
): ProviderCatalogEntry => ({
  key,
  label,
  type: 'openai-compatible',
  group: 'api',
  baseUrl,
  description,
  keyPlaceholder: 'API key',
  modelPlaceholder: 'model id',
  ...extra,
})

const local = (
  key: string,
  label: string,
  baseUrl: string,
  description: string,
  extra: Partial<ProviderCatalogEntry> = {},
): ProviderCatalogEntry => ({
  key,
  label,
  type: 'openai-compatible',
  group: 'local',
  baseUrl,
  description,
  keyPlaceholder: 'Usually not needed',
  modelPlaceholder: 'loaded model id',
  keyOptional: true,
  ...extra,
})

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // ---- Subscriptions --------------------------------------------------------
  {
    key: 'chatgpt-subscription',
    label: 'ChatGPT',
    type: 'chatgpt-subscription',
    group: 'subscription',
    description: 'Use your ChatGPT Plus / Pro plan. Sign in with your OpenAI account.',
    modelPlaceholder: 'e.g. gpt-5.6-sol',
    iconKey: 'openai',
  },
  {
    key: 'grok-subscription',
    label: 'Grok',
    type: 'grok-subscription',
    group: 'subscription',
    description: 'Use your SuperGrok or X Premium plan. Sign in with xAI.',
    modelPlaceholder: 'e.g. grok-4.5',
    iconKey: 'x',
  },

  // ---- First-party APIs -----------------------------------------------------
  {
    key: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    group: 'api',
    description: 'Claude models via the Anthropic API.',
    keyPlaceholder: 'sk-ant-...',
    modelPlaceholder: 'e.g. claude-sonnet-4-5',
    iconKey: 'anthropic',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    type: 'openai',
    group: 'api',
    description: 'GPT and o-series models via the OpenAI API.',
    keyPlaceholder: 'sk-...',
    modelPlaceholder: 'e.g. gpt-4o, o3-mini',
    iconKey: 'openai',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    type: 'openrouter',
    group: 'api',
    description: 'One key for hundreds of models across providers.',
    keyPlaceholder: 'sk-or-...',
    modelPlaceholder: 'e.g. anthropic/claude-sonnet-4',
    iconKey: 'openrouter',
    keysUrl: 'https://openrouter.ai/keys',
  },

  // ---- OpenAI-compatible hosted APIs ---------------------------------------
  oc('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'Gemini models through the OpenAI-compatible endpoint.', { iconKey: 'gemini', keysUrl: 'https://aistudio.google.com/apikey', modelPlaceholder: 'e.g. gemini-2.5-pro' }),
  oc('xai', 'xAI', 'https://api.x.ai/v1', 'Grok models via the xAI API.', { iconKey: 'x', keysUrl: 'https://console.x.ai', modelPlaceholder: 'e.g. grok-4' }),
  oc('mistral', 'Mistral', 'https://api.mistral.ai/v1', 'Mistral and Codestral models.', { iconKey: 'mistral', keysUrl: 'https://console.mistral.ai/api-keys', modelPlaceholder: 'e.g. mistral-large-latest' }),
  oc('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'DeepSeek chat and reasoner models.', { iconKey: 'deepseek', keysUrl: 'https://platform.deepseek.com/api_keys', modelPlaceholder: 'e.g. deepseek-chat' }),
  oc('groq', 'Groq', 'https://api.groq.com/openai/v1', 'Fast inference for open models on LPUs.', { keysUrl: 'https://console.groq.com/keys', modelPlaceholder: 'e.g. llama-3.3-70b-versatile' }),
  oc('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', 'Very fast inference for open models.', { keysUrl: 'https://cloud.cerebras.ai', modelPlaceholder: 'e.g. llama-3.3-70b' }),
  oc('together', 'Together AI', 'https://api.together.xyz/v1', 'Open models, fine-tunes, and dedicated endpoints.', { keysUrl: 'https://api.together.ai/settings/api-keys', modelPlaceholder: 'e.g. meta-llama/Llama-3.3-70B-Instruct-Turbo' }),
  oc('fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1', 'Fast serverless inference for open models.', { keysUrl: 'https://fireworks.ai/account/api-keys', modelPlaceholder: 'e.g. accounts/fireworks/models/llama-v3p3-70b-instruct' }),
  oc('perplexity', 'Perplexity', 'https://api.perplexity.ai', 'Sonar models with built-in web search.', { iconKey: 'perplexity', keysUrl: 'https://www.perplexity.ai/settings/api', modelPlaceholder: 'e.g. sonar-pro' }),
  oc('cohere', 'Cohere', 'https://api.cohere.ai/compatibility/v1', 'Command models through the compatibility API.', { keysUrl: 'https://dashboard.cohere.com/api-keys', modelPlaceholder: 'e.g. command-a-03-2025' }),
  oc('huggingface', 'Hugging Face', 'https://router.huggingface.co/v1', 'Inference Providers router. Uses your HF token.', { iconKey: 'huggingface', keysUrl: 'https://huggingface.co/settings/tokens', keyPlaceholder: 'hf_...', modelPlaceholder: 'e.g. meta-llama/Llama-3.3-70B-Instruct' }),
  oc('nvidia', 'NVIDIA NIM', 'https://integrate.api.nvidia.com/v1', 'Hosted NIM endpoints on build.nvidia.com.', { iconKey: 'nvidia', keysUrl: 'https://build.nvidia.com', keyPlaceholder: 'nvapi-...', modelPlaceholder: 'e.g. meta/llama-3.3-70b-instruct' }),
  oc('vercel-ai-gateway', 'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'Route to many providers through one Vercel key.', { iconKey: 'vercel', keysUrl: 'https://vercel.com/dashboard/ai-gateway', modelPlaceholder: 'e.g. anthropic/claude-sonnet-4' }),
  oc('cloudflare', 'Cloudflare Workers AI', 'https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1', 'Open models at the edge. Replace YOUR_ACCOUNT_ID in the base URL.', { iconKey: 'cloudflare', keysUrl: 'https://dash.cloudflare.com/profile/api-tokens', modelPlaceholder: 'e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
  oc('azure-openai', 'Azure OpenAI', 'https://YOUR_RESOURCE.openai.azure.com/openai/v1', 'Azure-hosted OpenAI models. Replace YOUR_RESOURCE in the base URL.', { keysUrl: 'https://portal.azure.com', modelPlaceholder: 'your deployment name' }),
  oc('deepinfra', 'DeepInfra', 'https://api.deepinfra.com/v1/openai', 'Low-cost hosting for open models.', { keysUrl: 'https://deepinfra.com/dash/api_keys', modelPlaceholder: 'e.g. meta-llama/Llama-3.3-70B-Instruct' }),
  oc('sambanova', 'SambaNova', 'https://api.sambanova.ai/v1', 'Fast inference on SambaNova RDUs.', { keysUrl: 'https://cloud.sambanova.ai/apis', modelPlaceholder: 'e.g. Meta-Llama-3.3-70B-Instruct' }),
  oc('nebius', 'Nebius', 'https://api.studio.nebius.com/v1', 'Nebius AI Studio open-model endpoints.', { keysUrl: 'https://studio.nebius.com/settings/api-keys', modelPlaceholder: 'e.g. meta-llama/Llama-3.3-70B-Instruct' }),
  oc('hyperbolic', 'Hyperbolic', 'https://api.hyperbolic.xyz/v1', 'Open models on decentralized GPU capacity.', { keysUrl: 'https://app.hyperbolic.xyz/settings', modelPlaceholder: 'e.g. meta-llama/Llama-3.3-70B-Instruct' }),
  oc('novita', 'Novita AI', 'https://api.novita.ai/v3/openai', 'Serverless open-model inference.', { keysUrl: 'https://novita.ai/settings/key-management', modelPlaceholder: 'e.g. meta-llama/llama-3.3-70b-instruct' }),
  oc('baseten', 'Baseten', 'https://inference.baseten.co/v1', 'Model APIs and dedicated deployments.', { keysUrl: 'https://app.baseten.co/settings/api_keys', modelPlaceholder: 'e.g. deepseek-ai/DeepSeek-V3-0324' }),
  oc('scaleway', 'Scaleway', 'https://api.scaleway.ai/v1', 'EU-hosted generative APIs.', { iconKey: 'scaleway', keysUrl: 'https://console.scaleway.com/iam/api-keys', modelPlaceholder: 'e.g. llama-3.3-70b-instruct' }),
  oc('venice', 'Venice', 'https://api.venice.ai/api/v1', 'Private, uncensored open-model inference.', { keysUrl: 'https://venice.ai/settings/api', modelPlaceholder: 'e.g. llama-3.3-70b' }),
  oc('kluster', 'kluster.ai', 'https://api.kluster.ai/v1', 'Open-model inference with batch pricing.', { keysUrl: 'https://platform.kluster.ai/apikeys', modelPlaceholder: 'e.g. deepseek-ai/DeepSeek-V3-0324' }),
  oc('moonshot', 'Moonshot (Kimi)', 'https://api.moonshot.ai/v1', 'Kimi models from Moonshot AI.', { iconKey: 'kimi', keysUrl: 'https://platform.moonshot.ai/console/api-keys', modelPlaceholder: 'e.g. kimi-k2-0711-preview' }),
  oc('zai', 'Z.ai (GLM)', 'https://api.z.ai/api/paas/v4', 'GLM models from Zhipu / Z.ai.', { keysUrl: 'https://z.ai/manage-apikey/apikey-list', modelPlaceholder: 'e.g. glm-4.5' }),
  oc('qwen', 'Qwen (Alibaba)', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'Qwen models via Model Studio (international).', { iconKey: 'qwen', keysUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key', modelPlaceholder: 'e.g. qwen-plus' }),
  oc('minimax', 'MiniMax', 'https://api.minimax.io/v1', 'MiniMax text models.', { iconKey: 'minimax', keysUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', modelPlaceholder: 'e.g. MiniMax-M1' }),
  oc('inception', 'Inception', 'https://api.inceptionlabs.ai/v1', 'Mercury diffusion language models.', { keysUrl: 'https://platform.inceptionlabs.ai', modelPlaceholder: 'e.g. mercury-coder' }),

  // ---- Local servers ---------------------------------------------------------
  local('lmstudio', 'LM Studio', 'http://localhost:1234/v1', 'Local server from the LM Studio app.', { iconKey: 'lmstudio' }),
  local('ollama', 'Ollama', 'http://localhost:11434/v1', 'Local models served by Ollama.', { iconKey: 'ollama', modelPlaceholder: 'e.g. llama3.3' }),
  local('vllm', 'vLLM', 'http://localhost:8000/v1', 'vLLM OpenAI-compatible server.', { iconKey: 'vllm' }),
  local('llamacpp', 'llama.cpp', 'http://localhost:8080/v1', 'llama-server from llama.cpp.'),
  local('litellm', 'LiteLLM', 'http://localhost:4000/v1', 'LiteLLM proxy in front of any provider.', { keyOptional: false, keyPlaceholder: 'Proxy key, if set' }),
  local('jan', 'Jan', 'http://localhost:1337/v1', 'Local server from the Jan app.'),
  local('localai', 'LocalAI', 'http://localhost:8080/v1', 'LocalAI drop-in OpenAI server.'),
  local('tgwui', 'text-generation-webui', 'http://localhost:5000/v1', 'oobabooga OpenAI extension.'),

  // ---- Other -----------------------------------------------------------------
  {
    key: 'openai-compatible',
    label: 'OpenAI-compatible',
    type: 'openai-compatible',
    group: 'other',
    description: 'Any endpoint that speaks the OpenAI chat API. Enter the base URL.',
    keyPlaceholder: 'Optional',
    modelPlaceholder: 'model id',
  },
]

const BY_KEY = new Map(PROVIDER_CATALOG.map((e) => [e.key, e]))

export function findCatalogEntry(key: string | undefined): ProviderCatalogEntry | undefined {
  return key ? BY_KEY.get(key) : undefined
}

/**
 * Resolve the catalog entry for a saved provider: the remembered preset first,
 * else the entry whose key equals the runtime type (anthropic, openai, ...),
 * which also covers providers saved before presets existed.
 */
export function catalogEntryForProvider(p: { type: string; preset?: string }): ProviderCatalogEntry | undefined {
  return findCatalogEntry(p.preset) ?? findCatalogEntry(p.type)
}

/** "Groq" → "Groq", then "Groq 2", "Groq 3" … against the names already in use. */
export function nextProviderName(label: string, existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((p) => p.name.trim().toLowerCase()))
  if (!taken.has(label.toLowerCase())) return label
  for (let n = 2; n < 1000; n++) {
    const candidate = `${label} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${label} ${Date.now()}`
}

/** Runtime label shown as a small hint under the form ("OpenAI-compatible API"). */
export function providerTypeHint(type: ProviderType): string {
  switch (type) {
    case 'anthropic': return 'Anthropic API'
    case 'openai': return 'OpenAI API'
    case 'openrouter': return 'OpenRouter API'
    case 'openai-compatible': return 'OpenAI-compatible API'
    case 'chatgpt-subscription': return 'ChatGPT subscription (OAuth)'
    case 'grok-subscription': return 'Grok subscription (OAuth)'
  }
}

export function isSubscriptionType(type: ProviderType): boolean {
  return type === 'chatgpt-subscription' || type === 'grok-subscription'
}
