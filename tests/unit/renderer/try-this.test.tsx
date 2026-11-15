/**
 * The "Try this" chip in an existing agent's chat. tryThisPrompt picks one
 * line from the attached MCP servers' npm packages; TryThisChip carries the
 * show/hide rule and the click. No jsdom in this repo, so the chip is called
 * as a function and its button's onClick invoked directly; LoopStream itself
 * is not rendered (AgentLoop.tsx only mounts TryThisChip, checked by source).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TRY_THIS_FALLBACK, TryThisChip, tryThisPrompt } from '../../../src/renderer/components/agent/try-this'
import type { AgentConfig, McpServerConfig } from '../../../src/shared/types/adf-v02.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const GMAIL_LINE = "Show me the senders and subjects of my latest emails. Don't change anything."
const CAL_LINE = "What's on my calendar for the next 7 days? Don't change anything."

const server = (name: string, npm_package?: string): McpServerConfig => ({ name, transport: 'stdio', command: 'npx', npm_package })
const withServers = (...servers: McpServerConfig[]): Pick<AgentConfig, 'mcp'> => ({ mcp: { servers } })

describe('tryThisPrompt', () => {
  it('Gmail attached: list the latest emails', () => {
    expect(tryThisPrompt(withServers(server('gmail', '@gongrzhe/server-gmail-autoauth-mcp')))).toBe(GMAIL_LINE)
  })
  it('Calendar attached: the next 7 days', () => {
    expect(tryThisPrompt(withServers(server('calendar', '@cocal/google-calendar-mcp')))).toBe(CAL_LINE)
  })
  it('both attached: the first in config order wins, either way round', () => {
    const gmail = server('gmail', '@gongrzhe/server-gmail-autoauth-mcp')
    const cal = server('calendar', '@cocal/google-calendar-mcp')
    expect(tryThisPrompt(withServers(gmail, cal))).toBe(GMAIL_LINE)
    expect(tryThisPrompt(withServers(cal, gmail))).toBe(CAL_LINE)
  })
  it('an unknown package before a known one is skipped; alone it falls back', () => {
    expect(tryThisPrompt(withServers(server('x', 'some-other-mcp')))).toBe(TRY_THIS_FALLBACK)
    expect(tryThisPrompt(withServers(server('x', 'some-other-mcp'), server('c', '@cocal/google-calendar-mcp')))).toBe(CAL_LINE)
    expect(tryThisPrompt(withServers(server('python-thing')))).toBe(TRY_THIS_FALLBACK)
  })
  it('keys on the package, not the name: a renamed Gmail server still matches, a server named gmail does not', () => {
    expect(tryThisPrompt(withServers(server('My mail', '@gongrzhe/server-gmail-autoauth-mcp')))).toBe(GMAIL_LINE)
    expect(tryThisPrompt(withServers(server('gmail', 'not-gmail')))).toBe(TRY_THIS_FALLBACK)
  })
  it('a package named like an Object.prototype member is not a match', () => {
    for (const pkg of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(tryThisPrompt(withServers(server('x', pkg)))).toBe(TRY_THIS_FALLBACK)
    }
  })
  it('no mcp section, an empty list, or no config: the general line', () => {
    expect(tryThisPrompt({})).toBe(TRY_THIS_FALLBACK)
    expect(tryThisPrompt(withServers())).toBe(TRY_THIS_FALLBACK)
    expect(tryThisPrompt(null)).toBe(TRY_THIS_FALLBACK)
  })
  it('the general line is the exact wording', () => {
    expect(TRY_THIS_FALLBACK).toBe("Tell me what you can do with what you can reach right now, and give me one thing to try. Don't change anything.")
  })
})

type ButtonEl = React.ReactElement<{ type: string; onClick: () => void; children: string }>
function chipButton(el: React.ReactElement | null): ButtonEl {
  expect(el).not.toBeNull()
  const kids = React.Children.toArray((el as React.ReactElement<{ children: React.ReactNode }>).props.children) as React.ReactElement[]
  const button = kids.find((k) => k.type === 'button') as ButtonEl | undefined
  expect(button).toBeDefined()
  return button!
}

describe('TryThisChip', () => {
  const gmail = withServers(server('Mail', '@gongrzhe/server-gmail-autoauth-mcp'))

  it('main loop, empty box: one chip; clicking hands the line to onPick and never submits', () => {
    const onPick = vi.fn()
    const button = chipButton(TryThisChip({ isMainLoop: true, draft: '', disabled: false, config: gmail, onPick }))
    // A plain button: inside the composer <form> it cannot trigger a send.
    expect(button.props.type).toBe('button')
    button.props.onClick()
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(GMAIL_LINE)
    const html = renderToStaticMarkup(<TryThisChip isMainLoop draft="" disabled={false} config={gmail} onPick={onPick} />)
    expect(html).toContain('Try this')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toContain('type="submit"')
  })

  it('shows the whole line: wraps, left-aligned, never truncated, no tooltip', () => {
    const cal = withServers(server('cal', '@cocal/google-calendar-mcp'))
    const html = renderToStaticMarkup(<TryThisChip isMainLoop draft="" disabled={false} config={cal} onPick={() => {}} />)
    const button = html.match(/<button[^>]*>([^<]*)<\/button>/)
    expect(button?.[1]).toBe(CAL_LINE.replace(/'/g, '&#x27;'))
    expect(html).not.toMatch(/\btruncate\b|text-ellipsis|whitespace-nowrap|line-clamp/)
    expect(html).not.toContain('title=')
    expect(button?.[0]).toMatch(/\btext-left\b/)
    expect(button?.[0]).toMatch(/\bwhitespace-normal\b/)
  })

  it('absent when the box has text, even whitespace', () => {
    expect(TryThisChip({ isMainLoop: true, draft: 'my draft', disabled: false, config: gmail, onPick: () => {} })).toBeNull()
    expect(TryThisChip({ isMainLoop: true, draft: ' ', disabled: false, config: gmail, onPick: () => {} })).toBeNull()
  })

  it('absent on a non-main loop tab', () => {
    expect(TryThisChip({ isMainLoop: false, draft: '', disabled: false, config: gmail, onPick: () => {} })).toBeNull()
  })

  it('absent while the composer is disabled for a pending ask', () => {
    expect(TryThisChip({ isMainLoop: true, draft: '', disabled: true, config: gmail, onPick: () => {} })).toBeNull()
  })

  it('AgentLoop mounts it with the loop draft, and the pick fills and focuses without sending', () => {
    const src = readFileSync(join(__dirname, '../../../src/renderer/components/agent/AgentLoop.tsx'), 'utf8')
    const tag = src.match(/<TryThisChip\b[\s\S]*?\/>/)?.[0] ?? ''
    expect(src).toMatch(/import \{ TryThisChip \} from '\.\/try-this'/)
    expect(tag).toMatch(/\bisMainLoop=\{isMainLoop\}/)
    expect(tag).toMatch(/\bdraft=\{input\}/)
    expect(tag).toMatch(/\bdisabled=\{askPending\}/)
    expect(tag).toMatch(/\bconfig=\{config\}/)
    // The pick fills the draft, then focuses the composer; nothing else (no send).
    expect(tag).toMatch(/onPick=\{\s*\(line\)\s*=>\s*\{\s*setInput\(line\);?\s*textareaRef\.current\?\.focus\(\);?\s*\}\s*\}/)
  })
})
