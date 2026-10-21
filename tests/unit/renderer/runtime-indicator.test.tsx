/**
 * The status bar's runtime indicator (docs/design/settings-scopes.md §4.1):
 * nothing for This computer while connected, a remote's name with the remote
 * icon, the state in the same spot while not connected; the address in the
 * tooltip. Read from this window's connection (#149). Static markup.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { runtimeIndicator } from '../../../src/renderer/stores/connection.store'
import { RuntimeIndicator } from '../../../src/renderer/components/layout/StatusBar'
import type { ConnectionCurrent } from '../../../src/shared/types/connection.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const current = (over: Partial<ConnectionCurrent> = {}): ConnectionCurrent => ({ id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected', ...over })

describe('the runtime indicator (settings-scopes.md §4.1)', () => {
  it('nothing for This computer or Inside Studio while connected', () => {
    expect(runtimeIndicator(current())).toBeNull()
    expect(runtimeIndicator(current({ id: 'embedded', kind: 'embedded', name: 'Inside Studio' }))).toBeNull()
    expect(renderToStaticMarkup(<RuntimeIndicator current={current()} onOpen={() => {}} />)).toBe('')
  })

  it('a remote: its name with the remote icon; the address only in the tooltip', () => {
    const remote = current({ id: 'remote:box-1', kind: 'remote', name: 'box-1', url: 'https://box-1.tail1234.ts.net:7385' })
    expect(runtimeIndicator(remote)).toEqual({ text: 'box-1', remote: true, tooltip: 'https://box-1.tail1234.ts.net:7385', problem: false })
    const html = renderToStaticMarkup(<RuntimeIndicator current={remote} onOpen={() => {}} />)
    expect(html).toContain('>box-1<')
    expect(html).toContain('title="https://box-1.tail1234.ts.net:7385"')
    expect(html).toContain('<svg')
  })

  it('a problem shows in the same spot with the status line\'s words, This computer included', () => {
    expect(runtimeIndicator(current({ kind: 'remote', name: 'box-1', state: 'retrying' }))?.text).toBe('box-1 · Not connected, retrying')
    expect(runtimeIndicator(current({ state: 'connecting' }))).toEqual({ text: 'host-0 (Local) · Connecting', remote: false, tooltip: null, problem: true })
    expect(renderToStaticMarkup(<RuntimeIndicator current={current({ state: 'not-connected' })} onOpen={() => {}} />)).not.toContain('<svg')
  })

  it('no remote saved: no runtime name, ever; a problem shows in the status line\'s words alone', () => {
    expect(runtimeIndicator(current(), false)).toBeNull()
    expect(runtimeIndicator(current({ state: 'retrying' }), false)).toEqual({ text: 'Not connected, retrying', remote: false, tooltip: null, problem: true })
    const html = renderToStaticMarkup(<RuntimeIndicator current={current({ state: 'connecting' })} showName={false} onOpen={() => {}} />)
    expect(html).toContain('>Connecting<')
    expect(html).not.toContain('host-0 (Local)')
    expect(html).not.toContain('Runtime:')
  })
})
