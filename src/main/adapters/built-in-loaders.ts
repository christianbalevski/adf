import type { CreateAdapterFn } from '../../shared/types/channel-adapter.types'

/**
 * Dynamic-import loaders for every built-in channel adapter.
 *
 * The imports are deliberately lazy — keeps each adapter's heavy npm
 * dependencies (grammy, imapflow, discord.js, …) out of the cold-start
 * path until at least one agent opts into the adapter at runtime.
 *
 * Adding a new built-in adapter takes two edits:
 *   1. Append an entry to ADAPTER_REGISTRY in
 *      src/shared/constants/adapter-registry.ts.
 *   2. Append an entry here mapping the type key to its lazy import.
 * If the adapter reads AdapterInstanceConfig.config keys, make sure the
 * adapters schema in src/main/adf/adf-schema.ts still models `config` —
 * zod strips unknown keys, so a missing field silently drops them.
 */
export const BUILT_IN_ADAPTER_LOADERS: Record<string, () => Promise<CreateAdapterFn>> = {
  telegram: async () => (await import('./telegram/index')).createAdapter,
  email: async () => (await import('./email/index')).createAdapter,
  discord: async () => (await import('./discord/index')).createAdapter,
  slack: async () => (await import('./slack/index')).createAdapter,
  whatsapp: async () => (await import('./whatsapp/index')).createAdapter
}

/**
 * Resolve a built-in adapter's `createAdapter()` factory, or null when the
 * type is not built in (callers fall back to npm-package resolution).
 */
export async function loadBuiltInAdapter(adapterType: string): Promise<CreateAdapterFn | null> {
  const loader = BUILT_IN_ADAPTER_LOADERS[adapterType]
  if (!loader) return null
  return loader()
}
