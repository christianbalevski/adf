import type { ProviderConfig, ProviderCredentialFileInfo } from '../../../shared/types/ipc.types'

/**
 * What an agent's copy of a provider changes versus the app values.
 *
 * Studio puts an unchanged, key-less copy of the default provider into every
 * agent it creates. At runtime that copy borrows the app key and carries the
 * same fields, so it is not an override in any sense the user cares about.
 * An override is a copy with its own key, or with a model, params, or delay
 * that differ from the app values.
 */
export interface OverrideSummary {
  /** True when the copy changes anything a user would call an override. */
  isOverride: boolean
  /** Short badges naming what differs, e.g. ["Own key", "Model: llama3"]. */
  badges: string[]
}

const norm = (s?: string): string => (s ?? '').trim()

/**
 * What the override form takes from PROVIDER_CREDENTIAL_GET: the key field's
 * value, the copy's fields, and the reason the stored key could not be read
 * (a remote daemon never sends stored values; a failed read), which the form
 * shows under the key field instead of an empty field without a word.
 */
export function credentialFormLoad(result: { credentials?: Record<string, string>; providerConfig?: { defaultModel?: string; params?: { key: string; value: string }[]; requestDelayMs?: number }; error?: string } | null | undefined): {
  apiKey: string | null
  providerConfig: { defaultModel?: string; params?: { key: string; value: string }[]; requestDelayMs?: number } | null
  error: string | null
} {
  return {
    apiKey: result?.credentials ? result.credentials.apiKey ?? '' : null,
    providerConfig: result?.providerConfig ?? null,
    error: result?.error ? result.error : null,
  }
}

function paramsEqual(a?: { key: string; value: string }[], b?: { key: string; value: string }[]): boolean {
  const clean = (p?: { key: string; value: string }[]) => (p ?? []).filter((x) => x.key.trim())
  const ca = clean(a)
  const cb = clean(b)
  if (ca.length !== cb.length) return false
  return ca.every((x, i) => x.key === cb[i].key && x.value === cb[i].value)
}

export function summarizeOverride(file: ProviderCredentialFileInfo, app: ProviderConfig): OverrideSummary {
  const badges: string[] = []
  const copy = file.providerConfig
  if (file.hasCredentials) badges.push('Own key')
  if (copy) {
    const model = norm(copy.defaultModel)
    if (model && model !== norm(app.defaultModel)) badges.push(`Model: ${model}`)
    if (!paramsEqual(copy.params, app.params)) badges.push('Own params')
    const delay = copy.requestDelayMs ?? 0
    if (delay !== (app.requestDelayMs ?? 0)) badges.push(`Delay: ${delay} ms`)
  }
  return { isOverride: badges.length > 0, badges }
}

export function countOverrides(files: ProviderCredentialFileInfo[], app: ProviderConfig): number {
  return files.filter((f) => summarizeOverride(f, app).isOverride).length
}
