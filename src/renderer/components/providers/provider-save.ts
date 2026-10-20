import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { rebaseById, rebaseValue } from '../../utils/list-rebase'

/** The providers part of a settings save. */
export interface ProviderListSnapshot {
  providers: ProviderConfig[]
  defaultProviderId: string | undefined
}

/**
 * A refused save of the providers list: the reason on each row that differs
 * from what was last saved (`rows`, by provider id), or on the panel when no
 * shown row differs (a removal, a new default).
 */
export interface ProviderSaveFailure {
  rows: Record<string, string>
  panel: string | null
}

/** The daemon's (or main's) sentence, without Electron's "Error invoking remote method" wrapper. */
export function saveErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '') || 'The settings could not be saved.'
}

/** Where a refused save shows; null when the providers part did not change (the failure is about something else). */
export function providerSaveFailure(saved: ProviderListSnapshot, attempted: ProviderListSnapshot, error: string): ProviderSaveFailure | null {
  const before = new Map(saved.providers.map((p) => [p.id, JSON.stringify(p)]))
  const rows: Record<string, string> = {}
  for (const p of attempted.providers) if (before.get(p.id) !== JSON.stringify(p)) rows[p.id] = error
  const sameIds = saved.providers.length === attempted.providers.length && attempted.providers.every((p) => before.has(p.id))
  const otherChange = !sameIds || (saved.defaultProviderId ?? '') !== (attempted.defaultProviderId ?? '')
  if (Object.keys(rows).length > 0) return { rows, panel: null }
  return otherChange ? { rows, panel: error } : null
}

/**
 * Run a settings write that carries the providers list. Never rejects: a
 * refusal comes back as the failure to show (the form keeps the edits and
 * says they were not saved); null when it was saved, or when the refusal is
 * not about the providers.
 */
export async function saveProviderList(
  write: () => Promise<unknown> | undefined,
  saved: ProviderListSnapshot,
  attempted: ProviderListSnapshot,
): Promise<{ saved: boolean; failure: ProviderSaveFailure | null; error?: string }> {
  try {
    await write()
    return { saved: true, failure: null }
  } catch (err) {
    const message = saveErrorMessage(err)
    console.warn('[Providers] Settings save refused:', message)
    return { saved: false, failure: providerSaveFailure(saved, attempted, message), error: message }
  }
}

/**
 * This window's edit of the providers list, applied to the list stored now
 * (`latest`), so a save never drops what another window changed meanwhile
 * (agent windows, docs/design/agent-windows.md): providers this window
 * changed or added since `saved` take its version, ones it removed go, and
 * every other provider is the stored one. The default moves only when this
 * window moved it.
 */
export function rebaseProviderList(saved: ProviderListSnapshot, attempted: ProviderListSnapshot, latest: ProviderListSnapshot): ProviderListSnapshot {
  const providers = rebaseById(saved.providers, attempted.providers, latest.providers)
  let defaultProviderId = rebaseValue(saved.defaultProviderId ?? '', attempted.defaultProviderId ?? '', latest.defaultProviderId ?? '') || undefined
  if (defaultProviderId && !providers.some((p) => p.id === defaultProviderId)) defaultProviderId = providers[0]?.id
  return { providers, defaultProviderId }
}
