import { describe, it, expect, beforeEach } from 'vitest'
import { applyConfig, applyDocument } from '../../../src/renderer/hooks/useAgent'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

/**
 * Every main-loop turn end re-reads the document and config. Main hands back a
 * freshly deserialized object each time, so applying it blindly gave the store
 * a new identity for unchanged content — a structuredClone of the whole config
 * and a re-render of everything derived from it, plus a document the agent
 * never touched marked dirty.
 */

const baseConfig = (): AgentConfig =>
  ({ id: 'agent-1', name: 'agent-1', handle: 'agent-1' } as unknown as AgentConfig)

describe('turn-end header refresh identity', () => {
  beforeEach(() => {
    useAgentStore.getState().setConfig(null)
    useDocumentStore.getState().setDocumentContent('')
    useDocumentStore.getState().setDirty(false)
  })

  it('keeps the config identity when the re-read config is equal', () => {
    const first = baseConfig()
    applyConfig(first)
    expect(useAgentStore.getState().config).toBe(first)

    applyConfig(baseConfig()) // same content, fresh object off the bridge
    expect(useAgentStore.getState().config).toBe(first)
  })

  it('applies a config that actually changed', () => {
    applyConfig(baseConfig())
    const changed = { ...baseConfig(), handle: 'agent-2' } as unknown as AgentConfig
    applyConfig(changed)
    expect(useAgentStore.getState().config).toBe(changed)
  })

  it('leaves the document clean when the re-read content is identical', () => {
    applyDocument('# agent-1')
    useDocumentStore.getState().setDirty(false)

    applyDocument('# agent-1')
    expect(useDocumentStore.getState().isDirty).toBe(false)
  })

  it('still applies a document that changed', () => {
    applyDocument('# agent-1')
    applyDocument('# agent-1 edited')
    expect(useDocumentStore.getState().documentContent).toBe('# agent-1 edited')
  })
})
