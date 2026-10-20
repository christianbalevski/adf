/**
 * Settings' one save model (settings-save.tsx): every write's answer is
 * read — `{ success: false }` and a rejection are both refusals, with the
 * daemon's sentence — and a refusal rolls the control back. Static markup
 * and pure helpers, no jsdom; the bridge is a stub on globalThis.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notSavedMessage, SaveIndicator, SettingsSaveProvider, settingsWriteOutcome, useSettingsSave, writeSettings } from '../../../src/renderer/components/settings/settings-save'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const g = globalThis as { adfApi?: unknown }
afterEach(() => { delete g.adfApi })

describe('a settings write', () => {
  it('reads the answer: success, { success: false }, a rejection', async () => {
    expect(settingsWriteOutcome({ success: true })).toEqual({ ok: true })
    expect(settingsWriteOutcome(undefined)).toEqual({ ok: true })
    expect(settingsWriteOutcome({ success: false, error: 'The store is locked.' })).toEqual({ ok: false, error: 'The store is locked.' })
    expect(settingsWriteOutcome({ success: false })).toEqual({ ok: false, error: 'The settings could not be saved.' })

    g.adfApi = { setSettings: vi.fn().mockResolvedValue({ success: true }) }
    expect(await writeSettings({ theme: 'dark' })).toEqual({ ok: true })
    g.adfApi = { setSettings: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'settings:set': Error: The daemon secret store is locked.")) }
    expect(await writeSettings({ theme: 'dark' })).toEqual({ ok: false, error: 'The daemon secret store is locked.' })
    delete g.adfApi
    expect((await writeSettings({ theme: 'dark' })).ok).toBe(false)
  })

  it('the toast text', () => {
    expect(notSavedMessage('The store is locked.')).toBe('Not saved: The store is locked.')
  })

  it('outside the page the commit still rolls back a refusal', async () => {
    g.adfApi = { setSettings: vi.fn().mockResolvedValue({ success: false, error: 'no' }) }
    let api: ReturnType<typeof useSettingsSave> | null = null
    function Probe() { api = useSettingsSave(); return null }
    renderToStaticMarkup(<Probe />)
    const rollback = vi.fn()
    expect(await api!.commit({ menuBarEnabled: false }, rollback)).toBe(false)
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('the header indicator is quiet until a write lands', () => {
    const html = renderToStaticMarkup(<SettingsSaveProvider><SaveIndicator /></SettingsSaveProvider>)
    expect(html).toContain('role="status"')
    expect(html).toContain('opacity-0')
    expect(html).not.toContain('Saved')
  })
})
