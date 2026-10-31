import { afterEach, describe, expect, it } from 'vitest'

import { ChannelAdapterManager } from '../../../src/main/services/channel-adapter-manager'
import { withAgentEnabledAdapterRegistrations } from '../../../src/shared/constants/adapter-registry'
import type { AdapterRegistration, AdaptersConfig } from '../../../src/shared/types/channel-adapter.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

// Workspace methods are only reached through ctx callbacks, which a stub that
// fails in start() never invokes.
const workspace = {} as AdfWorkspace
const known: AdapterRegistration[] = [{ id: 'telegram', type: 'telegram', managed: false }]

let manager: ChannelAdapterManager | null = null
afterEach(async () => { await manager?.stopAll(); manager = null })

describe('withAgentEnabledAdapterRegistrations', () => {
  it('adds a bare registration for an enabled channel the runtime does not know', () => {
    const adapters: AdaptersConfig = { whatsapp_agent: { enabled: true }, telegram: { enabled: true } }
    expect(withAgentEnabledAdapterRegistrations(known, adapters).map((r) => r.type)).toEqual(['telegram', 'whatsapp_agent'])
  })

  it('ignores unknown channels that are not enabled', () => {
    const adapters: AdaptersConfig = { whatsapp_agent: { enabled: false } }
    expect(withAgentEnabledAdapterRegistrations(known, adapters)).toBe(known)
  })
})

describe('ChannelAdapterManager with a channel this runtime cannot load', () => {
  it('reports it as an error with the reason instead of skipping it', async () => {
    manager = new ChannelAdapterManager()
    await manager.reconcile({
      registrations: known,
      adaptersConfig: { whatsapp_agent: { enabled: true } },
      workspace,
      resolveFactory: async () => null,
    })
    const state = manager.getState('whatsapp_agent')
    expect(state?.status).toBe('error')
    expect(state?.error).toMatch(/no "whatsapp_agent" channel/)
    expect(state?.error).toMatch(/update ADF where the agent runs/i)
  })
})
