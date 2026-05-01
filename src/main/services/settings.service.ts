import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULT_BASE_PROMPT, DEFAULT_TOOL_PROMPTS, DEFAULT_COMPACTION_PROMPT } from '../../shared/constants/adf-defaults'
import { withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import {
  generateEd25519KeyPair,
  extractRawPublicKey,
  publicKeyToDid
} from '../crypto/identity-crypto'

/** Prefix used to mark values encrypted via safeStorage in the JSON file */
const SAFE_STORAGE_PREFIX = 'safe:'

const DEFAULTS: Record<string, unknown> = {
  providers: [],
  theme: 'light',
  globalSystemPrompt: DEFAULT_BASE_PROMPT,
  toolPrompts: DEFAULT_TOOL_PROMPTS,
  compactionPrompt: DEFAULT_COMPACTION_PROMPT,
  trackedDirectories: [],
  meshEnabled: true,
  meshLan: false,
  meshPort: 7295,
  maxDirectoryScanDepth: 5,
  autoCompactThreshold: 100000,
  mcpServers: [],
  adapters: withBuiltInAdapterRegistrations(),
  reviewedAgents: [] as string[],
  sandboxPackages: [],
  compute: {
    hostAccessEnabled: false,
    hostApproved: [] as string[],
    containerPackages: ['python3-full', 'python3-pip', 'git', 'curl', 'wget', 'jq', 'unzip', 'ca-certificates', 'openssh-client', 'procps', 'chromium', 'chromium-driver', 'fonts-liberation', 'libnss3', 'libatk-bridge2.0-0', 'libdrm2', 'libgbm1', 'libasound2'] as string[],
    machineCpus: 2,
    machineMemoryMb: 2048,
    containerImage: 'docker.io/library/node:20-slim',
  }
}

function getSettingsPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'adf-settings.json')
}

function loadStore(): Record<string, unknown> {
  const path = getSettingsPath()
  try {
    if (existsSync(path)) {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf-8')) }
    }
  } catch {
    // Corrupted file — reset to defaults
  }
  return { ...DEFAULTS }
}

function saveStore(data: Record<string, unknown>): void {
  const path = getSettingsPath()
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

/** Required container packages that must always be present. */
const REQUIRED_CONTAINER_PACKAGES = DEFAULTS.compute.containerPackages as string[]

export class SettingsService {
  private data: Record<string, unknown>

  constructor() {
    this.data = loadStore()
    this.migrateBuiltInAdapters()
    this.migrateComputeDefaults()
    this.migrateToolPrompts()
  }

  /** Ensure built-in channel adapters are always available to the runtime. */
  private migrateBuiltInAdapters(): void {
    const saved = Array.isArray(this.data.adapters)
      ? this.data.adapters as AdapterRegistration[]
      : []
    const merged = withBuiltInAdapterRegistrations(saved)
    if (JSON.stringify(saved) !== JSON.stringify(merged)) {
      this.data.adapters = merged
      saveStore(this.data)
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
    if (!saved.containerImage) { saved.containerImage = (DEFAULTS.compute as Record<string, unknown>).containerImage; changed = true }
    if (!saved.machineCpus) { saved.machineCpus = (DEFAULTS.compute as Record<string, unknown>).machineCpus; changed = true }
    if (!saved.machineMemoryMb) { saved.machineMemoryMb = (DEFAULTS.compute as Record<string, unknown>).machineMemoryMb; changed = true }

    if (changed) {
      this.data.compute = saved
      saveStore(this.data)
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
      saveStore(this.data)
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
    this.data[key] = value
    saveStore(this.data)
  }

  getAll(): Record<string, unknown> {
    return {
      ...this.data,
      adapters: withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined),
    }
  }

  delete(key: string): void {
    delete this.data[key]
    saveStore(this.data)
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
    saveStore(this.data)
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
   * Ensure owner and runtime DIDs exist in settings.
   * Generated once on first app launch, persisted forever.
   */
  ensureRuntimeIdentity(): { ownerDid: string; runtimeDid: string } {
    let ownerDid = this.data['ownerDid'] as string | undefined
    let runtimeDid = this.data['runtimeDid'] as string | undefined

    if (!ownerDid) {
      const kp = generateEd25519KeyPair()
      const raw = extractRawPublicKey(kp.publicKey)
      ownerDid = publicKeyToDid(raw)
      this.set('ownerDid', ownerDid)
    }

    if (!runtimeDid) {
      const kp = generateEd25519KeyPair()
      const raw = extractRawPublicKey(kp.publicKey)
      runtimeDid = publicKeyToDid(raw)
      this.set('runtimeDid', runtimeDid)
    }

    return { ownerDid, runtimeDid }
  }
}
