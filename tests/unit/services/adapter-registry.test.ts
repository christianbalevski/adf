import { describe, expect, it } from 'vitest'

import { getEnabledAgentAdapterConfig } from '../../../src/shared/constants/adapter-registry'
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
})
