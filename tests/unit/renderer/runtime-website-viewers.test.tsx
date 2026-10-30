import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownManager } from '@tiptap/markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openWebsite, openFile } = vi.hoisted(() => ({ openWebsite: vi.fn(), openFile: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useRuntimeWebsiteLink', () => ({ useRuntimeWebsiteLink: () => openWebsite }))
vi.mock('../../../src/renderer/utils/open-adf-link', () => ({ isAdfFileUrl: (s: string) => s.startsWith('adf-file://'), openAdfFileLink: openFile }))
vi.mock('../../../src/renderer/utils/markdown', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/renderer/utils/markdown')>(),
  useMarkdownHighlightVersion: () => 0,
}))

import { MarkdownEntry } from '../../../src/renderer/components/agent/MarkdownEntry'
import { getEditorExtensions } from '../../../src/renderer/components/editor/EditorExtensions'

;(globalThis as { React?: typeof React }).React = React

function click(href: string, detail = 1) {
  return { detail, button: 0, preventDefault: vi.fn(), target: { closest: () => ({ getAttribute: () => href }) } }
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('runtime website links in ADF Markdown views', () => {
  it('routes conversation links through the runtime resolver, preserving absolute and file links', () => {
    vi.stubGlobal('window', { open: vi.fn() })
    let rendered!: React.ReactElement<{ onClick: (e: unknown) => void }>
    // Render with real React hooks; effects/DOM parsing are not needed to
    // exercise the component's delegated anchor handler.
    function Probe() {
      rendered = (MarkdownEntry as unknown as { type: (p: { content: string }) => typeof rendered }).type({ content: '[Site](/agents/a/)' })
      return rendered
    }
    renderToStaticMarkup(<Probe />)
    const relative = click('/agents/a/report?q=1#summary')
    rendered.props.onClick(relative)
    expect(relative.preventDefault).toHaveBeenCalled()
    expect(openWebsite).toHaveBeenCalledWith('/agents/a/report?q=1#summary')
    for (const url of ['https://custom.example/agents/a/', 'http://localhost:7295/agents/a/']) {
      rendered.props.onClick(click(url))
      expect(window.open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
    }
    rendered.props.onClick(click('adf-file://README.md'))
    expect(openFile).toHaveBeenCalledWith('adf-file://README.md')
    const fragment = click('#heading')
    rendered.props.onClick(fragment)
    expect(fragment.preventDefault).not.toHaveBeenCalled()
    expect(openWebsite).toHaveBeenCalledTimes(1)
  })

  it('handles editor links ahead of the default opener and keeps Markdown relative after opening', () => {
    const extensions = getEditorExtensions(openWebsite)
    const handler = extensions.find((e) => e.name === 'adfLinkClickHandler')!
    const plugins = handler.config.addProseMirrorPlugins!.call({ options: handler.options } as never)
    const plugin = plugins[0]
    const source = '[Site](/agents/a/report?q=1#summary) and [Custom](https://custom.example/path)'
    const markdown = new MarkdownManager({ extensions })
    const document = markdown.parse(source)
    const before = markdown.serialize(document)
    expect(before).toContain('](/agents/a/report?q=1#summary)')
    const event = click('/agents/a/report?q=1#summary')
    expect(plugin.props.handleClick!.call(plugin, {} as never, 0, event as never)).toBe(true)
    expect(openWebsite).toHaveBeenCalledWith('/agents/a/report?q=1#summary')
    expect(plugin.props.handleClick!.call(plugin, {} as never, 0, click(event.target.closest().getAttribute(), 2) as never)).toBe(true)
    expect(openWebsite).toHaveBeenCalledTimes(1)
    expect(markdown.serialize(document)).toBe(before)
    expect(plugin.props.handleClick!.call(plugin, {} as never, 0, click('https://custom.example/path') as never)).toBe(false)
    expect(handler.config.priority).toBeGreaterThan(1000)
  })
})
