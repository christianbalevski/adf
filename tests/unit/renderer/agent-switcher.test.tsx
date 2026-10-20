/**
 * Go to agent (Cmd/Ctrl+K): the switcher's combobox and listbox markup, for
 * tracked agents ranked with one that needs you and one running.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rankAgents, type SwitcherAgent } from '../../../src/renderer/utils/agent-switcher'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

afterEach(() => { vi.unstubAllGlobals() })

const agent = (name: string, extra: Partial<SwitcherAgent> = {}): SwitcherAgent =>
  ({ filePath: `/agents/${name}.adf`, name, folder: 'agents', running: false, needsYou: 0, ...extra })

async function render(query: string, agents: SwitcherAgent[], current = 0): Promise<string> {
  vi.resetModules()
  vi.stubGlobal('window', { location: { search: '' }, adfApi: { platform: 'linux' } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const { SwitcherView } = await import('../../../src/renderer/components/common/AgentSwitcher')
  const noop = () => {}
  return renderToStaticMarkup(
    <SwitcherView listId="switcher" query={query} matches={rankAgents(agents, query)} current={current} openFilePath="/agents/agent-1.adf"
      onQuery={noop} onKeyDown={noop} onHover={noop} onChoose={noop} />
  )
}

const options = (html: string) => [...html.matchAll(/<li id="([^"]+)" role="option" aria-selected="(true|false)"[^>]*>(.*?)<\/li>/g)]

describe('AgentSwitcher', () => {
  it('a combobox that controls a listbox; the active option is its active descendant', async () => {
    const html = await render('', [agent('agent-1'), agent('agent-2', { needsYou: 1 }), agent('agent-3', { running: true })], 1)
    const input = html.match(/<input[^>]*>/)![0]
    expect(input).toContain('role="combobox"')
    expect(input).toContain('aria-expanded="true"')
    expect(input).toContain('aria-autocomplete="list"')
    expect(input).toContain('aria-controls="switcher"')
    expect(input).toContain('aria-activedescendant="switcher-option-1"')
    expect(html).toContain('<ul id="switcher" role="listbox" aria-label="Agents"')
    const opts = options(html)
    expect(opts.map((o) => o[3].match(/agent-\d/)![0])).toEqual(['agent-2', 'agent-3', 'agent-1'])
    expect(opts.map((o) => [o[1], o[2]])).toEqual([['switcher-option-0', 'false'], ['switcher-option-1', 'true'], ['switcher-option-2', 'false']])
    expect(opts[0][3]).toContain('Needs you')
    expect(opts[1][3]).toContain('Running')
    expect(opts[2][3]).toContain('Open')
  })

  it('highlights the matched characters; no match says so and has no active descendant', async () => {
    const html = await render('a2', [agent('agent-1'), agent('agent-2')])
    expect(options(html)).toHaveLength(1)
    expect(html).toContain('<strong class="font-semibold">a</strong>')
    const none = await render('zzz', [agent('agent-1')])
    expect(none).toContain('aria-expanded="false"')
    expect(none).not.toContain('aria-activedescendant')
    expect(none).toContain('No match')
  })
})
