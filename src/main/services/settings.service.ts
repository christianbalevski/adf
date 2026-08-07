import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULT_TOOL_PROMPTS, MIND_PROMPT_SECTION, SOUL_PROMPT_SECTION } from '../../shared/constants/adf-defaults'
import { withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { DEFAULT_COMPUTE_SETTINGS } from '../../shared/constants/compute-defaults'
import { createSettingsDefaults } from '../../shared/constants/settings-defaults'
import { writeJsonAtomic, readJsonOrQuarantine } from '../utils/atomic-json'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import { OwnerIdentityService } from './owner-identity.service'

/** Prefix used to mark values encrypted via safeStorage in the JSON file */
const SAFE_STORAGE_PREFIX = 'safe:'

export interface SettingsQuarantineInfo {
  originalPath: string
  quarantinedTo: string
  at: number
}

let lastQuarantine: SettingsQuarantineInfo | null = null

/** Last settings-file corruption event (file was moved aside, not deleted). */
export function getSettingsQuarantine(): SettingsQuarantineInfo | null {
  return lastQuarantine
}

function recordQuarantine(originalPath: string, quarantinedTo: string): void {
  lastQuarantine = { originalPath, quarantinedTo, at: Date.now() }
  console.error(
    `[Settings] CORRUPT SETTINGS FILE: ${originalPath} could not be parsed. ` +
    `It was quarantined to ${quarantinedTo} (NOT deleted) and defaults were loaded. ` +
    'Providers, API keys, tracked directories and the owner mnemonic can be recovered from the quarantined file.'
  )
}

function getSettingsPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'adf-settings.json')
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function loadStore(): { data: Record<string, unknown>; mtimeMs: number } {
  const path = getSettingsPath()
  const { data, quarantinedTo } = readJsonOrQuarantine<Record<string, unknown>>(path)
  if (quarantinedTo) recordQuarantine(path, quarantinedTo)
  return {
    data: { ...createSettingsDefaults(), ...(data ?? {}) },
    mtimeMs: fileMtimeMs(path),
  }
}

/** Required container packages that must always be present. */
const REQUIRED_CONTAINER_PACKAGES = DEFAULT_COMPUTE_SETTINGS.containerPackages

export class SettingsService {
  private data: Record<string, unknown>
  private lastSyncedMtime: number
  /** Keys mutated in memory but not yet flushed to disk. */
  private readonly dirtyKeys = new Set<string>()
  private flushScheduled = false

  constructor() {
    const { data, mtimeMs } = loadStore()
    this.data = data
    this.lastSyncedMtime = mtimeMs
    this.migrateBuiltInAdapters()
    this.migrateComputeDefaults()
    this.migrateToolPrompts()
    this.migrateGlobalSystemPromptSoul()
    this.migrateGlobalSystemPromptMind()
    // Best-effort safety net; explicit flush() on shutdown is still preferred.
    process.once('exit', () => this.flush())
  }

  /**
   * Mark keys dirty and coalesce disk writes: bursts of set()/setSecret()
   * calls (migrations, identity bootstrap) produce a single write on the
   * next microtask. get() reads the in-memory store, so set() stays
   * synchronous in observable behavior.
   */
  private scheduleSave(...keys: string[]): void {
    for (const key of keys) this.dirtyKeys.add(key)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flush())
  }

  /**
   * Write pending changes to disk now. Safe to call any time (no-op when
   * clean). Call on shutdown to guarantee persistence.
   *
   * Before writing, if another writer (e.g. the daemon) touched the file
   * since our last read/write, re-read it and merge: our dirty keys win,
   * every other key comes from disk — so two writers no longer clobber
   * each other with stale snapshots.
   */
  flush(): void {
    this.flushScheduled = false
    if (this.dirtyKeys.size === 0) return
    const path = getSettingsPath()
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const diskMtime = fileMtimeMs(path)
    if (diskMtime !== 0 && diskMtime !== this.lastSyncedMtime) {
      const { data: disk, quarantinedTo } = readJsonOrQuarantine<Record<string, unknown>>(path)
      if (quarantinedTo) recordQuarantine(path, quarantinedTo)
      if (disk) {
        const merged: Record<string, unknown> = { ...createSettingsDefaults(), ...disk }
        for (const key of this.dirtyKeys) {
          if (key in this.data) merged[key] = this.data[key]
          else delete merged[key]
        }
        this.data = merged
      }
    }

    writeJsonAtomic(path, this.data)
    this.lastSyncedMtime = fileMtimeMs(path)
    this.dirtyKeys.clear()
  }

  /**
   * Ensure a persisted custom base prompt injects soul.md. Runs before the mind
   * migration so a prompt missing both sections gains them in the default
   * soul-then-mind order. Idempotent.
   */
  private migrateGlobalSystemPromptSoul(): void {
    const prompt = this.data.globalSystemPrompt
    if (typeof prompt !== 'string') return
    if (prompt.includes('{{soul.md}}')) return
    this.data.globalSystemPrompt = prompt.trimEnd() + SOUL_PROMPT_SECTION
    this.scheduleSave('globalSystemPrompt')
    console.log('[Settings] Migrated globalSystemPrompt — backfilled {{soul.md}} injection')
  }

  /**
   * Ensure a persisted custom base prompt still injects mind. Mind injection
   * moved from bespoke executor code to the `{{mind.md}}` placeholder; a base
   * prompt saved before that change lacks the token, so backfill it. Idempotent.
   */
  private migrateGlobalSystemPromptMind(): void {
    const prompt = this.data.globalSystemPrompt
    if (typeof prompt !== 'string') return
    if (prompt.includes('{{mind.md}}')) return
    this.data.globalSystemPrompt = prompt.trimEnd() + MIND_PROMPT_SECTION
    this.scheduleSave('globalSystemPrompt')
    console.log('[Settings] Migrated globalSystemPrompt — backfilled {{mind.md}} injection')
  }

  /** Ensure built-in channel adapters are always available to the runtime. */
  private migrateBuiltInAdapters(): void {
    const saved = Array.isArray(this.data.adapters)
      ? this.data.adapters as AdapterRegistration[]
      : []
    const merged = withBuiltInAdapterRegistrations(saved)
    if (JSON.stringify(saved) !== JSON.stringify(merged)) {
      this.data.adapters = merged
      this.scheduleSave('adapters')
      console.log('[Settings] Migrated adapters — added built-in channel adapters')
    }
  }

  /** Ensure saved compute settings include all required packages and fields. */
  private migrateComputeDefaults(): void {
    const saved = this.data.compute as Record<string, unknown> | undefined
    if (!saved) return // No saved compute settings — DEFAULTS will apply

    // Remove stale Alpine package names that don't exist on Debian
    const STALE_PACKAGES = ['py3-pip', 'python3-full']  // Alpine names → python3-pip on Debian
    const savedPkgs = (saved.containerPackages as string[]) ?? []
    let merged = savedPkgs.filter((p) => !STALE_PACKAGES.includes(p))
    let changed = merged.length !== savedPkgs.length

    // Merge required packages into saved list
    for (const pkg of REQUIRED_CONTAINER_PACKAGES) {
      if (!merged.includes(pkg)) {
        merged.push(pkg)
        changed = true
      }
    }

    // Deduplicate
    const deduped = [...new Set(merged)]
    if (deduped.length !== merged.length) { merged = deduped; changed = true }

    if (changed) {
      saved.containerPackages = merged
    }

    // Ensure new fields exist with defaults
    if (!saved.containerImage) { saved.containerImage = DEFAULT_COMPUTE_SETTINGS.containerImage; changed = true }
    if (!saved.machineCpus) { saved.machineCpus = DEFAULT_COMPUTE_SETTINGS.machineCpus; changed = true }
    if (!saved.machineMemoryMb) { saved.machineMemoryMb = DEFAULT_COMPUTE_SETTINGS.machineMemoryMb; changed = true }
    if (!Array.isArray(saved.executionTargets)) { saved.executionTargets = []; changed = true }

    if (changed) {
      this.data.compute = saved
      this.scheduleSave('compute')
      console.log('[Settings] Migrated compute defaults — added missing packages/fields')
    }
  }

  /** Backfill new tool prompt keys from defaults into saved settings. */
  private migrateToolPrompts(): void {
    const saved = this.data.toolPrompts as Record<string, string> | undefined
    if (!saved) return // No saved toolPrompts — DEFAULTS will apply

    let changed = false
    for (const [key, value] of Object.entries(DEFAULT_TOOL_PROMPTS)) {
      if (!(key in saved)) {
        saved[key] = value
        changed = true
      }
    }
    if (changed) {
      this.data.toolPrompts = saved
      this.scheduleSave('toolPrompts')
      console.log('[Settings] Migrated toolPrompts — added missing keys')
    }
  }

  get(key: string): unknown {
    if (key === 'adapters') {
      return withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined)
    }
    return this.data[key]
  }

  set(key: string, value: unknown): void {
    // Compute settings are updated from several independent controls. Merge
    // partial updates so an execution-target write cannot erase machine or
    // host-access settings (and vice versa).
    if (key === 'compute' && value && typeof value === 'object' && !Array.isArray(value)) {
      const current = this.data.compute
      this.data.compute = {
        ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
        ...(value as Record<string, unknown>),
      }
    } else {
      this.data[key] = value
    }
    this.scheduleSave(key)
  }

  getAll(): Record<string, unknown> {
    const all: Record<string, unknown> = {
      ...this.data,
      adapters: withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined),
    }
    // Never ship key material to the renderer — even encrypted blobs have no
    // business there, and the plaintext fallback (no safeStorage) definitely doesn't.
    delete all.ownerMnemonic
    delete all.runtimePrivateKey
    delete all.runtimeEncPrivateKey
    return all
  }

  delete(key: string): void {
    delete this.data[key]
    this.scheduleSave(key)
  }

  /** Look up a provider by its id (e.g. 'anthropic' or 'custom:m3k9x1'). */
  getProvider(id: string): ProviderConfig | undefined {
    const providers = (this.data['providers'] as ProviderConfig[]) ?? []
    return providers.find((p) => p.id === id)
  }

  /**
   * Store a secret value encrypted via Electron's safeStorage.
   * Falls back to plaintext if safeStorage is unavailable.
   */
  setSecret(key: string, value: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value)
      this.data[key] = SAFE_STORAGE_PREFIX + encrypted.toString('base64')
    } else {
      this.data[key] = value
    }
    this.scheduleSave(key)
  }

  /**
   * Retrieve a secret value, decrypting if it was stored via safeStorage.
   */
  getSecret(key: string): string | null {
    const raw = this.data[key]
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'string') return String(raw)

    if (raw.startsWith(SAFE_STORAGE_PREFIX)) {
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn(`[Settings] safeStorage unavailable, cannot decrypt "${key}"`)
        return null
      }
      try {
        const buf = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64')
        return safeStorage.decryptString(buf)
      } catch (err) {
        console.warn(`[Settings] Failed to decrypt "${key}":`, err)
        return null
      }
    }

    return raw
  }

  /**
   * Check if safeStorage encryption is available on this platform.
   */
  isSafeStorageAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Ensure key-backed owner and runtime identities exist. Delegates to
   * OwnerIdentityService, which handles first launch, migration from legacy
   * label-only DIDs (whose private keys were discarded), and restamping.
   */
  ensureRuntimeIdentity(): { ownerDid: string; runtimeDid: string } {
    const { ownerDid, runtimeDid } = this.getOwnerIdentity().ensureIdentity()
    return { ownerDid, runtimeDid }
  }

  /** Owner identity service (owner-identity only type-imports this file — no cycle). */
  getOwnerIdentity(): OwnerIdentityService {
    if (!this.ownerIdentity) {
      this.ownerIdentity = new OwnerIdentityService(this)
    }
    return this.ownerIdentity
  }

  private ownerIdentity: OwnerIdentityService | undefined
}
