/**
 * Provider precedence (docs/guides/settings.md › Providers): the agent's own
 * provider, then its template's, then the runtime default set in Settings →
 * Providers. A template's empty Provider reads "Runtime default (<name>)",
 * and the providers set on the runtime but not on the agent are one group,
 * "Runtime", explained in its tooltip. Static markup, no jsdom.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderOptions, RUNTIME_PROVIDERS_TIP, runtimeDefaultLabel } from '../../../src/renderer/components/agent/AgentProviders'
import { PROVIDER_PRECEDENCE } from '../../../src/renderer/components/settings/AgentTemplatesTab'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const provider = (id: string, name: string): ProviderConfig =>
  ({ id, type: 'openai-compatible', name, baseUrl: 'https://llm.example.com/v1', apiKey: '' }) as ProviderConfig

describe('provider precedence', () => {
  it('a template\'s empty Provider names the runtime default: the marked one, else the first', () => {
    const list = [provider('p1', 'agent-1 LLM'), provider('p2', 'agent-2 LLM')]
    expect(runtimeDefaultLabel(list, 'p2')).toBe('Server default (agent-2 LLM)')
    expect(runtimeDefaultLabel(list, undefined)).toBe('Server default (agent-1 LLM)')
    expect(runtimeDefaultLabel(list, 'gone')).toBe('Server default (agent-1 LLM)')
    expect(runtimeDefaultLabel([], undefined)).toBe('Server default (none set up)')
  })

  it('server-only providers are one group with a one-word label; the explanation is its tooltip', () => {
    const html = renderToStaticMarkup(<select><ProviderOptions agentProviders={[{ id: 'p1', type: 'openai-compatible', name: 'agent-1 LLM', baseUrl: '' }]} appProviders={[provider('p1', 'agent-1 LLM'), provider('p2', 'agent-2 LLM')]} /></select>)
    expect(html).toContain('label="On this agent"')
    expect(html).toContain('label="Server"')
    expect(html).toContain(`title="${RUNTIME_PROVIDERS_TIP.replace(/→/g, '→')}"`)
    expect(html).not.toContain('App only')
  })

  it('the Templates page states the order once', () => {
    expect(PROVIDER_PRECEDENCE).toBe('An agent uses its own provider, else its template\'s, else the server default.')
  })
})
