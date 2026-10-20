import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { providerSaveFailure, rebaseProviderList, saveErrorMessage, saveProviderList } from '../../../src/renderer/components/providers/provider-save'
import { ProvidersPanel } from '../../../src/renderer/components/providers/ProvidersPanel'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

/**
 * Settings → Providers when the store refuses a save (the daemon's secret
 * store locked: 409 secret_store_locked). The refusal is never swallowed:
 * the rows it concerns say "Not saved" with the daemon's sentence, and the
 * edits stay. No jsdom: the panel renders to static markup.
 */

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const provider = (id: string, patch: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id, type: 'openai-compatible', name: id, baseUrl: 'https://llm.example.com/v1', apiKey: '', apiKeyStorage: 'secret-store', ...patch }) as ProviderConfig

const LOCKED = 'The daemon secret store is locked, so provider "agent-1 LLM" cannot change its address, type, key storage or API key now.'

describe('a refused providers save', () => {
  it('names the rows that differ from what was saved; a removal or a new default goes on the panel; other refusals are not the providers\'', () => {
    const saved = { providers: [provider('p1'), provider('p2')], defaultProviderId: 'p1' }
    expect(providerSaveFailure(saved, { providers: [provider('p1', { baseUrl: 'https://other.example/v1' }), provider('p2')], defaultProviderId: 'p1' }, LOCKED))
      .toEqual({ rows: { p1: LOCKED }, panel: null })
    expect(providerSaveFailure(saved, { providers: [provider('p2')], defaultProviderId: 'p2' }, LOCKED)).toEqual({ rows: {}, panel: LOCKED })
    expect(providerSaveFailure(saved, saved, LOCKED)).toBeNull()
  })

  it('saveProviderList never rejects: a refusal comes back with the daemon\'s sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = { providers: [provider('p1')], defaultProviderId: 'p1' }
    const attempted = { providers: [provider('p1', { apiKey: 'sk-re-entered' })], defaultProviderId: 'p1' }
    const refused = await saveProviderList(() => Promise.reject(new Error(`Error invoking remote method 'settings:set': Error: ${LOCKED}`)), saved, attempted)
    expect(refused).toEqual({ saved: false, failure: { rows: { p1: LOCKED }, panel: null }, error: LOCKED })
    expect(await saveProviderList(() => Promise.resolve({ success: true }), saved, attempted)).toEqual({ saved: true, failure: null })
    expect(saveErrorMessage('x')).toBe('x')
    warn.mockRestore()
  })

  it('Settings → Providers shows "Not saved" on the refused row', () => {
    const html = renderToStaticMarkup(
      <ProvidersPanel
        loaded
        providers={[provider('p1', { name: 'agent-1 LLM' }), provider('p2', { name: 'agent-2 LLM' })]}
        setProviders={() => {}}
        defaultProviderId="p1"
        setDefaultProviderId={() => {}}
        flushSave={() => {}}
        saveFailure={{ rows: { p1: LOCKED }, panel: null }}
        onOpenTemplate={() => {}}
      />,
    )
    expect(html).toContain(`Not saved: ${LOCKED.replace(/"/g, '&quot;')}`)
    expect(html.match(/Not saved:/g)).toHaveLength(1)
  })
})

describe('a providers save from one window, with a change from another window stored meanwhile (agent windows)', () => {
  const saved = { providers: [provider('p1'), provider('p2')], defaultProviderId: 'p1' }

  it('keeps what the other window added; applies the change and the removal made here', () => {
    const attempted = { providers: [provider('p1', { name: 'mine' }), provider('p3')], defaultProviderId: 'p1' }
    const latest = { providers: [provider('p1'), provider('p2', { name: 'theirs' }), provider('p4')], defaultProviderId: 'p1' }
    // p2 was removed here, but the other window changed it: the removal is this window's, so it goes.
    expect(rebaseProviderList(saved, attempted, latest)).toEqual({ providers: [provider('p1', { name: 'mine' }), provider('p4'), provider('p3')], defaultProviderId: 'p1' })
  })

  it('an unchanged list writes back the stored one; the default moves only when this window moved it', () => {
    const latest = { providers: [provider('p1'), provider('p2'), provider('p4')], defaultProviderId: 'p4' }
    expect(rebaseProviderList(saved, saved, latest)).toEqual(latest)
    expect(rebaseProviderList(saved, { ...saved, defaultProviderId: 'p2' }, latest).defaultProviderId).toBe('p2')
    // A default whose provider is gone falls back to the first.
    expect(rebaseProviderList(saved, { providers: [provider('p2')], defaultProviderId: 'p1' }, { providers: [provider('p1'), provider('p2')], defaultProviderId: 'p1' }))
      .toEqual({ providers: [provider('p2')], defaultProviderId: 'p2' })
  })
})
