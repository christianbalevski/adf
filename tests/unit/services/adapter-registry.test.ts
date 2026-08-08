import { describe, expect, it } from 'vitest'

import { ADAPTER_REGISTRY, findAdapterRegistryEntry, getEnabledAgentAdapterConfig } from '../../../src/shared/constants/adapter-registry'
import type { AdaptersConfig } from '../../../src/shared/types/channel-adapter.types'

describe('adapter registry helpers', () => {
  it('requires explicit per-agent enablement before an adapter can start', () => {
    expect(getEnabledAgentAdapterConfig(undefined, 'telegram')).toBeNull()
    expect(getEnabledAgentAdapterConfig({}, 'telegram')).toBeNull()
    expect(getEnabledAgentAdapterConfig({ telegram: { enabled: false } }, 'telegram')).toBeNull()

    const adapters: AdaptersConfig = {
      telegram: {
        enabled: true,
        policy: { dm: 'all', groups: 'mention' },
      },
    }

    expect(getEnabledAgentAdapterConfig(adapters, 'telegram')).toBe(adapters.telegram)
  })

  it('ships discord as a verified built-in adapter', () => {
    const entry = findAdapterRegistryEntry('discord')
    expect(entry).toBeDefined()
    expect(entry?.builtIn).toBe(true)
    expect(entry?.verified).toBe(true)
    expect(entry?.requiredEnvKeys).toContain('DISCORD_BOT_TOKEN')
    expect(entry?.optionalEnvKeys).toContain('DISCORD_APPLICATION_ID')
    expect(ADAPTER_REGISTRY.map((e) => e.type)).toEqual(expect.arrayContaining(['telegram', 'email', 'discord']))
  })

  it('ships slack as a verified built-in adapter requiring app + bot tokens', () => {
    const entry = findAdapterRegistryEntry('slack')
    expect(entry).toBeDefined()
    expect(entry?.builtIn).toBe(true)
    expect(entry?.verified).toBe(true)
    expect(entry?.requiredEnvKeys).toEqual(['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'])
  })

  it('ships whatsapp as a verified built-in adapter with no required credentials', () => {
    const entry = findAdapterRegistryEntry('whatsapp')
    expect(entry).toBeDefined()
    expect(entry?.builtIn).toBe(true)
    expect(entry?.verified).toBe(true)
    expect(entry?.requiredEnvKeys).toEqual([])
    expect(ADAPTER_REGISTRY.map((e) => e.type)).toEqual(expect.arrayContaining(['slack', 'whatsapp']))
  })
})
