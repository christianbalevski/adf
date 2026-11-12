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
import { describe, expect, it, vi } from 'vitest'
import { CommitInput, ContainerMemoryGroup, checkContainerMemory, checkPeerAddress, checkWholeNumber } from '../../../src/renderer/components/settings/settings-inputs'

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

describe('container memory limit', () => {
  it('accepts 0 (no limit) and the range; refuses the gap between them', () => {
    expect(checkContainerMemory('0')).toEqual({ ok: true, value: 0 })
    expect(checkContainerMemory(' 512 ')).toEqual({ ok: true, value: 512 })
    expect(checkContainerMemory('32768')).toEqual({ ok: true, value: 32768 })
    expect(checkContainerMemory('00'), 'the service reads "00" as 0').toEqual({ ok: true, value: 0 })
    for (const bad of ['', '1', '511', '32769', '-1', '1.5', 'abc', '1e3', '0x200', '4096.0']) {
      expect(checkContainerMemory(bad), bad).toEqual({ ok: false, error: 'Enter 0 for no limit, or a whole number from 512 to 32768.' })
    }
  })

  // No DOM here: call the component and find the field's handlers wherever it sits in the element tree.
  type Field = { value: string; onCommit: (v: string) => void; check: (v: string) => string | null }
  const find = (node: unknown): Field | undefined => {
    if (!React.isValidElement(node)) return Array.isArray(node) ? node.map(find).find(Boolean) : undefined
    return node.type === CommitInput ? node.props as Field : find((node.props as { children?: unknown }).children)
  }
  const field = (value: number, onChange: (v: number) => void) => find(ContainerMemoryGroup({ value, onChange }))!

  it('shows a saved 0', () => {
    expect(renderToStaticMarkup(<ContainerMemoryGroup value={0} onChange={() => {}} />)).toContain('value="0"')
  })

  it.each([[1024.5, '4096'], [-5, '4096'], [100, '4096'], [undefined, '4096'], ['8192', '8192']])('shows the value in force for a saved %j: %s', (saved, shown) => {
    expect(renderToStaticMarkup(<ContainerMemoryGroup value={saved as never} onChange={() => {}} />)).toContain(`value="${shown}"`)
  })

  it('commits the number', () => {
    const onChange = vi.fn()
    field(4096, onChange).onCommit('2048')
    field(4096, onChange).onCommit('0')
    expect(onChange.mock.calls).toEqual([[2048], [0]])
  })

  it('refuses out-of-range input with the reason and commits nothing', () => {
    const onChange = vi.fn()
    const input = field(4096, onChange)
    expect(input.check('100')).toBe('Enter 0 for no limit, or a whole number from 512 to 32768.')
    expect(input.check('2048')).toBeNull()
    input.onCommit('100')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the page loads and saves it under containerMemoryMb', () => {
    const src = page()
    expect(src).toContain('<ContainerMemoryGroup value={containerMemoryMb} onChange={setContainerMemoryMb} />')
    expect(src).toContain('containerMemoryMb={computeContainerMemoryMb}')
    expect(src).toContain("persistCompute('containerMemoryMb', setComputeContainerMemoryMb, v, computeContainerMemoryMb)")
    expect(src).toContain('setComputeContainerMemoryMb(compute.containerMemoryMb)')
    expect(src).not.toContain('if (compute.containerMemoryMb)') // a truthiness check would drop a saved 0
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
    // The port and the address are on the Networking page (NetworkingSettings.tsx).
    const networking = readFileSync(join(__dirname, '../../../src/renderer/components/settings/NetworkingSettings.tsx'), 'utf-8')
    expect(networking).toContain('onClick={() => void applyMeshPort()}')
    expect(networking).not.toContain('Server restarts when you leave the field')
    expect(networking).toContain('const checked = checkPeerAddress(draft)')
  })
})
