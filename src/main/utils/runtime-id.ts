import { nanoid } from 'nanoid'

export interface SettingsLike {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/**
 * Stable identifier for this ADF runtime, persisted across restarts via settings.
 *
 * Used in mDNS TXT records so peers can self-skip their own announcements and
 * distinguish overlapping hostnames. Opaque to users; never surfaced in UI or
 * card identity. The runtime *identity* (`runtimeDid`) is a separate, optional
 * concept handled by identity provisioning.
 */
export function getOrCreateRuntimeId(settings: SettingsLike): string {
  const existing = settings.get('runtimeId')
  if (typeof existing === 'string' && existing.length > 0) return existing
  const id = nanoid(21)
  settings.set('runtimeId', id)
  return id
}
