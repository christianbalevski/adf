import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import type { ProviderSettingsStore } from '../providers/provider-factory'
import { defaultUserDataPath } from '../utils/user-data-path'
import { withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'

export class FileSettingsStore implements ProviderSettingsStore {
  private readonly data: Record<string, unknown>

  constructor(readonly filePath?: string) {
    this.data = filePath ? readSettingsFile(filePath) : {}
  }

  get(key: string): unknown {
    if (key === 'adapters') {
      return withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined)
    }
    return this.data[key]
  }

  getAll(): Record<string, unknown> {
    return structuredCloneJson({
      ...this.data,
      adapters: withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined),
    })
  }

  set(key: string, value: unknown): void {
    this.data[key] = value
    this.save()
  }

  update(values: Record<string, unknown>): void {
    Object.assign(this.data, values)
    this.save()
  }

  getProvider(id: string): ProviderConfig | undefined {
    const providers = (this.data.providers as ProviderConfig[] | undefined) ?? []
    return providers.find(provider => provider.id === id)
  }

  private save(): void {
    if (!this.filePath) return
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
  }
}

function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {}
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function defaultSettingsPath(): string {
  return join(defaultUserDataPath(), 'adf-settings.json')
}

function structuredCloneJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}
