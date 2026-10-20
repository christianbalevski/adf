/**
 * Settings → Prompts: a prompt is a draft until Save (a keystroke never
 * reaches every agent), Revert drops the draft, and Reset shows only while
 * the saved prompt differs from the default. Static markup, no jsdom.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PromptEditor, PromptSectionRows, promptEditorState } from '../../../src/renderer/components/settings/PromptEditor'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const editor = (value: string, draft: string | undefined) => renderToStaticMarkup(
  <PromptEditor label="System prompt" value={value} defaultValue="default" draft={draft} onDraft={() => {}} onSave={async () => true} onReset={() => {}} rows={4} />,
)

describe('a prompt editor', () => {
  it('dirty is a draft that differs from the saved text; modified is a saved text that is not the default', () => {
    expect(promptEditorState('default', 'default', undefined)).toEqual({ dirty: false, modified: false })
    expect(promptEditorState('default', 'default', 'default')).toEqual({ dirty: false, modified: false })
    expect(promptEditorState('default', 'default', 'mine')).toEqual({ dirty: true, modified: false })
    expect(promptEditorState('mine', 'default', undefined)).toEqual({ dirty: false, modified: true })
  })

  it('the default with no draft: no Save, Revert or Reset', () => {
    const html = editor('default', undefined)
    expect(html).not.toContain('>Save<')
    expect(html).not.toContain('>Revert<')
    expect(html).not.toContain('>Reset<')
  })

  it('a draft: Save and Revert, and the textarea shows the draft', () => {
    const html = editor('default', 'my edit')
    expect(html).toContain('>Save<')
    expect(html).toContain('>Revert<')
    expect(html).toContain('>my edit</textarea>')
    expect(html).not.toContain('>Reset<')
  })

  it('a saved prompt that is not the default: Reset', () => {
    const html = editor('mine', undefined)
    expect(html).toContain('>Reset<')
    expect(html).not.toContain('>Save<')
  })

  it('section rows mark Modified and Unsaved', () => {
    const html = renderToStaticMarkup(
      <PromptSectionRows
        defaults={{ a: 'A', b: 'B' }}
        labels={{ a: 'Alpha', b: 'Beta' }}
        conditions={{}}
        values={{ a: 'changed', b: 'B' }}
        drafts={{ b: 'draft' }}
        onDraft={() => {}}
        onSave={async () => true}
        onReset={() => {}}
        expandedKey={null}
        onToggle={() => {}}
      />,
    )
    expect(html.match(/>Modified</g)).toHaveLength(1)
    expect(html.match(/>Unsaved</g)).toHaveLength(1)
  })
})

describe('the Prompts page copy', () => {
  it('one sentence that matches the composition modes, and no contradicting line', async () => {
    const { PROMPTS_COMPOSITION } = await import('../../../src/renderer/components/settings/SettingsPage')
    const { RUNTIME_NAV_ITEMS } = await import('../../../src/renderer/components/settings/settings-nav')
    expect(PROMPTS_COMPOSITION.split(/[.!]\s/)).toHaveLength(1)
    expect(PROMPTS_COMPOSITION).toMatch(/before its own instructions/)
    expect(PROMPTS_COMPOSITION).toMatch(/No base prompt or Bare/)
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const page = readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
    expect(page).not.toContain('unless its file provides more specific instructions')
    expect(page).not.toContain('Applied before per-file instructions')
    expect(RUNTIME_NAV_ITEMS.find((i) => i.id === 'agents')?.description).toBe('Agents read these when they start.')
  }, 30_000)
})
