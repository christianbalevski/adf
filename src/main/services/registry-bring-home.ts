/**
 * "Bring home": copy a registry agent into the user's agents folder.
 * Shared by Studio's AGENT_REGISTRY_BRING_HOME handler and the daemon's
 * POST /registry/agents/:id/bring-home.
 *
 * The copy gets a fresh config.id (the review allowlist is keyed on it, so
 * two copies of the same registry agent each get reviewed) and the app's
 * default provider when its model names none. Identity is stripped: a
 * registry file ships without one, so the review flow classifies it
 * 'unclaimed' and claiming mints the DID under this owner. Built on a
 * .partial and moved into place at the end; a failure leaves nothing behind.
 * The caller opens the returned path through its ordinary open flow.
 */

import { copyFileSync, existsSync, renameSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { nanoid } from 'nanoid'
import { AdfDatabase } from '../adf/adf-database'
import { AdfWorkspace } from '../adf/adf-workspace'
import { applyDefaultProviderToOptions, resolveDefaultProvider } from '../adf/apply-default-provider'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { ProviderConfig } from '../../shared/types/ipc.types'

/** First free "name.adf" / "name (2).adf" / … path in dir. */
export function availableAdfPath(dir: string, baseName: string): string {
  let candidate = join(dir, `${baseName}.adf`)
  for (let n = 2; existsSync(candidate); n++) {
    candidate = join(dir, `${baseName} (${n}).adf`)
  }
  return candidate
}

export interface BringHomeOptions {
  /** The agents folder, created if missing. Called after the registry file resolved. */
  agentsFolder: () => string
  /** settings.providers and settings.defaultProviderId. */
  providers: ProviderConfig[]
  defaultProviderId?: string
}

export async function bringRegistryAgentHome(
  resolveFile: () => Promise<{ path: string; entry: { file: string } }>,
  opts: BringHomeOptions,
): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
  let partial: string | null = null
  try {
    const { path: src, entry } = await resolveFile()
    const dest = availableAdfPath(opts.agentsFolder(), basename(entry.file, '.adf'))
    partial = `${dest}.partial`
    copyFileSync(src, partial)
    // Defence in depth: a registry entry is fetched from a remote index, so
    // it may carry whatever its author's install put in it. Strip identity
    // (signing keys, identity envelope, attestations, DID meta) exactly as
    // an outgoing copy does, BEFORE anything reads the file — the review
    // dialog must classify it 'unclaimed' on the merits, not on trust.
    AdfDatabase.stripIdentity(partial)
    const ws = AdfWorkspace.open(partial)
    try {
      const config = ws.getAgentConfig()
      config.id = nanoid(12)
      config.name = basename(dest, '.adf')
      const defaultProvider = resolveDefaultProvider(opts.providers, opts.defaultProviderId)
      const patched = applyDefaultProviderToOptions(
        { name: config.name, model: config.model, providers: config.providers },
        defaultProvider
      )
      const incomingModelId = config.model.model_id
      config.model = { ...config.model, ...(patched.model as AgentConfig['model']) }
      // The default provider fills in its own default model. The author's
      // model_id only means something on the provider the author had, so
      // it is kept only when the provider we just applied has no default
      // model of its own to offer (the claim step lets the user change it).
      if (incomingModelId && !config.model.model_id) config.model.model_id = incomingModelId
      if (patched.providers) config.providers = patched.providers
      ws.setAgentConfig(config)
    } finally {
      ws.close()
    }
    for (const side of ['-wal', '-shm']) {
      try { unlinkSync(`${partial}${side}`) } catch { /* none */ }
    }
    renameSync(partial, dest)
    partial = null
    return { success: true, filePath: dest }
  } catch (error) {
    if (partial) {
      // AdfDatabase.open()'s repair path can leave .bak/.corrupt/.repaired
      // beside the partial — a failed bring-home must leave nothing behind.
      for (const suffix of ['', '-wal', '-shm', '.bak', '.corrupt', '.repaired']) {
        try { unlinkSync(`${partial}${suffix}`) } catch { /* none */ }
      }
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
