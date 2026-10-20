/**
 * One ConfirmDialog for risky actions, its button named for the action
 * (never OK or Yes); low-risk removals offer Undo instead. No Settings file
 * uses window.confirm. Static markup and source checks, no jsdom.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConfirmDialog, HOST_ACCESS_CONFIRM } from '../../../src/renderer/components/common/ConfirmDialog'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const SETTINGS_DIR = join(__dirname, '../../../src/renderer/components/settings')

describe('ConfirmDialog', () => {
  it('a title, what happens, Cancel, and a verb button', () => {
    const html = renderToStaticMarkup(<ConfirmDialog options={{ title: 'Replace owner', body: 'Every agent is restamped.', confirmLabel: 'Replace owner', danger: true }} onAnswer={() => {}} />)
    expect(html).toContain('Replace owner')
    expect(html).toContain('Every agent is restamped.')
    expect(html).toContain('>Cancel<')
    expect(html).not.toMatch(/>(OK|Yes)</)
  })

  it('host access is asked for as Allow host access', () => {
    expect(HOST_ACCESS_CONFIRM.confirmLabel).toBe('Allow host access')
    expect(HOST_ACCESS_CONFIRM.body).toMatch(/bypasses container isolation/)
  })

  it('no Settings file calls window.confirm; the risky actions go through the dialog', () => {
    for (const file of readdirSync(SETTINGS_DIR).filter((f) => /\.tsx?$/.test(f))) {
      expect(readFileSync(join(SETTINGS_DIR, file), 'utf-8'), file).not.toContain('window.confirm')
    }
    const page = readFileSync(join(SETTINGS_DIR, 'SettingsPage.tsx'), 'utf-8')
    expect(page).toContain("confirmLabel: 'Replace owner'")
    expect(page).toContain('confirm(HOST_ACCESS_CONFIRM)')
    expect(page).toContain("confirmLabel: 'Revoke'")
    // Low-risk removals: Undo, not a question.
    expect(page).toContain('offerUndo(`Removed peer')
    expect(page).toContain('offerUndo(`Removed ${source}')
  })
})
