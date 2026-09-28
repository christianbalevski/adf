// Narrow-terminal layout rules: the header keeps view names before the host,
// and the help reference wraps instead of cutting lines off.

import { describe, expect, it } from 'vitest'
import { headerLayout } from '../../src/main/tui/app/Header'
import { wrapLines } from '../../src/main/tui/app/palette/help'
import { lineText } from '../../src/main/tui/views/inspect/format'

const TITLES = ['Fleet', 'Chat', 'Files', 'Loops', 'Inspect', 'Runtime']

describe('header layout', () => {
  it('keeps full view names at 80 columns by shrinking the host first', () => {
    expect(headerLayout(120, TITLES, '● live'.length, '127.0.0.1:7385')).toEqual({ tabs: 'full', host: '127.0.0.1:7385', compact: false, web: false })
    expect(headerLayout(80, TITLES, '● live'.length, '127.0.0.1:7385')).toEqual({ tabs: 'full', host: '', compact: false, web: false })
    // The plain owner badge yields before the six view names shorten.
    const withBadge = { full: 'owner z6Mk…2doK  ● live'.length, compact: '● live'.length }
    expect(headerLayout(80, TITLES, withBadge, '127.0.0.1:7385')).toEqual({ tabs: 'full', host: '', compact: true, web: false })
    expect(headerLayout(120, TITLES, withBadge, '127.0.0.1:7385')).toMatchObject({ tabs: 'full', compact: false })
    expect(headerLayout(80, TITLES, '!1 pending  ● live'.length, '127.0.0.1:7385').tabs).toBe('short')
    expect(headerLayout(70, TITLES, '● offline'.length, '127.0.0.1:7385').tabs).toBe('short')
    expect(headerLayout(40, TITLES, '● live'.length, '127.0.0.1:7385').tabs).toBe('key')
  })

  it('shows the web server badge while there is room and drops it first', () => {
    const web = '● web :7295'.length
    expect(headerLayout(120, TITLES, '● live'.length, '127.0.0.1:7385', web)).toEqual({ tabs: 'full', host: '127.0.0.1:7385', compact: false, web: true })
    // At 80 columns it goes (after the host) before any view name shortens.
    expect(headerLayout(80, TITLES, '● live'.length, '127.0.0.1:7385', web)).toEqual({ tabs: 'full', host: '', compact: false, web: false })
    expect(headerLayout(100, TITLES, '● live'.length, '127.0.0.1:7385', web)).toMatchObject({ web: true, host: ':7385' })
  })
})

describe('help wrapping', () => {
  it('wraps long lines under the description column instead of truncating', () => {
    const key = '  '.length + 18
    const lines = wrapLines([
      [{ text: '  ' }, { text: 'shift+left'.padEnd(18) }, { text: 'Previous / next loop of the selected agent, from anywhere, also from the prompt' }],
      [{ text: '  Inner loops (also called side loops) are extra threads with their own goal and history.' }],
    ], 60)
    const text = lines.map(lineText)
    expect(text.every(t => t.length <= 60)).toBe(true)
    expect(text.join(' ')).not.toContain('…')
    expect(text[1].startsWith(' '.repeat(key))).toBe(true)
    expect(text.join(' ').replace(/\s+/g, ' ')).toContain('Inner loops (also called side loops) are extra threads with their own goal and history.')
  })
})
