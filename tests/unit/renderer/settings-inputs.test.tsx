/**
 * Settings input checks (settings-inputs.tsx): a refused value is said inline
 * and never written, clamped or turned into 0; a manual peer is host:port;
 * the mesh port applies with a button, not on blur. Pure checks, static
 * markup and source checks; no jsdom.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommitInput, checkPeerAddress, checkWholeNumber } from '../../../src/renderer/components/settings/settings-inputs'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const page = () => readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')

describe('whole numbers (workers, CPUs, memory, port)', () => {
  it('in range is accepted; anything else is refused with the range, never 0', () => {
    expect(checkWholeNumber('0', 0, 256)).toEqual({ ok: true, value: 0 })
    expect(checkWholeNumber(' 12 ', 0, 256)).toEqual({ ok: true, value: 12 })
    for (const bad of ['', '-1', '1.5', 'abc', '257', '4e2']) {
      expect(checkWholeNumber(bad, 0, 256), bad).toEqual({ ok: false, error: 'Enter a whole number from 0 to 256.' })
    }
  })
})

describe('a manual peer', () => {
  it('host:port, a bare host, or [IPv6]:port', () => {
    expect(checkPeerAddress('100.101.102.103:7295')).toEqual({ ok: true, value: '100.101.102.103:7295' })
    expect(checkPeerAddress(' desk.tail1234.ts.net ')).toEqual({ ok: true, value: 'desk.tail1234.ts.net' })
    expect(checkPeerAddress('[fd7a:115c:a1e0::1]:7295').ok).toBe(true)
  })

  it('a URL, a path, a bad port or a bad host is refused with why', () => {
    expect(checkPeerAddress('')).toEqual({ ok: false, error: 'Enter an address.' })
    expect(checkPeerAddress('http://desk:7295')).toEqual({ ok: false, error: 'Use host:port, without http:// or a path.' })
    expect(checkPeerAddress('desk:7295/agents')).toEqual({ ok: false, error: 'Use host:port, without http:// or a path.' })
    expect(checkPeerAddress('desk:0')).toEqual({ ok: false, error: 'The port must be from 1 to 65535.' })
    expect(checkPeerAddress('desk:70000')).toEqual({ ok: false, error: 'The port must be from 1 to 65535.' })
    expect(checkPeerAddress('desk:port').ok).toBe(false)
    expect(checkPeerAddress('de_sk:7295')).toEqual({ ok: false, error: 'The host has characters a host name cannot have.' })
  })
})

describe('fields that commit on Enter or blur', () => {
  it('a CommitInput starts on the saved value with no error', () => {
    const html = renderToStaticMarkup(<CommitInput aria-label="Image" value="docker.io/library/node:20-alpine" onCommit={() => {}} />)
    expect(html).toContain('value="docker.io/library/node:20-alpine"')
    expect(html).not.toContain('role="alert"')
  })

  it('image, packages and workers are CommitInputs; the port applies with a button and never restarts on blur', () => {
    const src = page()
    for (const label of ['Image', 'Packages', 'CPUs', 'Memory', 'Workers']) {
      expect(src, label).toMatch(new RegExp(`<CommitInput\\s+aria-label="${label}"`))
    }
    expect(src).not.toContain('isNaN(n) || n < 0 ? 0')
    expect(src).toContain('onClick={() => void applyMeshPort()}')
    expect(src).not.toContain('Server restarts when you leave the field')
    expect(src).toContain('const checked = checkPeerAddress(draft)')
  })
})
