import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSessionSettings, ConnectionSettings } from '../../../src/renderer/components/settings/ConnectionSettings'
import { installBrowserSessionControls, useBrowserSessionControls, type BrowserSessionControls } from '../../../src/renderer/utils/browser-session'

;(globalThis as { React?: typeof React }).React = React

const releases: Array<() => void> = []
const install = (controls: BrowserSessionControls) => {
  const release = installBrowserSessionControls(controls)
  releases.push(release)
  return release
}
const web = () => vi.stubGlobal('window', { adfApi: { platform: 'web' } })

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release()
  vi.unstubAllGlobals()
})

describe('browser session settings', () => {
  it('delegates to the existing bootstrap action and reflects its busy state', async () => {
    web()
    const signOut = vi.fn().mockResolvedValue(undefined)
    install({ busy: false, signOut })
    const html = renderToStaticMarkup(<BrowserSessionSettings />)
    expect(html).toContain('Browser session')
    expect(html).toContain('>Sign out<')
    expect(html).not.toContain('disabled=""')

    let exposed: BrowserSessionControls | null = null
    function Probe() { exposed = useBrowserSessionControls(); return null }
    renderToStaticMarkup(<Probe />)
    await exposed!.signOut()
    expect(signOut).toHaveBeenCalledOnce()

    install({ busy: true, signOut })
    const busy = renderToStaticMarkup(<BrowserSessionSettings />)
    expect(busy).toContain('Signing out…')
    expect(busy).toContain('disabled=""')
  })

  it('remains available while the daemon connection settings have not loaded', () => {
    web()
    install({ busy: false, signOut: vi.fn().mockResolvedValue(undefined) })
    const html = renderToStaticMarkup(<ConnectionSettings />)
    expect(html).toContain('Loading…')
    expect(html).toContain('>Sign out<')
  })

  it('never adds browser sign-out to desktop Studio or a missing session', () => {
    web()
    expect(renderToStaticMarkup(<BrowserSessionSettings />)).toBe('')
    install({ busy: false, signOut: vi.fn().mockResolvedValue(undefined) })
    vi.stubGlobal('window', { adfApi: { platform: 'darwin' } })
    expect(renderToStaticMarkup(<BrowserSessionSettings />)).toBe('')
  })

  it('does not let cleanup of an older registration remove the current session action', () => {
    web()
    const releaseOld = install({ busy: false, signOut: vi.fn().mockResolvedValue(undefined) })
    const releaseCurrent = install({ busy: true, signOut: vi.fn().mockResolvedValue(undefined) })
    releaseOld()
    expect(renderToStaticMarkup(<BrowserSessionSettings />)).toContain('Signing out…')
    releaseCurrent()
    expect(renderToStaticMarkup(<BrowserSessionSettings />)).toBe('')
  })
})
