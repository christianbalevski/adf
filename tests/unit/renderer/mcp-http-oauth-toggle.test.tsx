import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { McpHttpOAuthToggle } from '../../../src/renderer/components/mcp/McpHttpOAuthToggle'
import { blankDraft, isOAuthEntry } from '../../../src/renderer/components/mcp/McpAddServerModal'
import { buildMcpServerConfigFromRegistration, MCP_EXECUTABLE_IDENTITY_FIELDS, sameExecutableIdentity } from '../../../src/shared/utils/mcp-config'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

;(globalThis as { React?: typeof React }).React = React

describe('custom HTTP browser sign-in', () => {
  it('renders the selectable sign-in control with its current value', () => {
    const off = renderToStaticMarkup(<McpHttpOAuthToggle enabled={false} onChange={() => {}} />)
    const on = renderToStaticMarkup(<McpHttpOAuthToggle enabled onChange={() => {}} />)
    expect(off).toContain('Browser sign-in (OAuth)')
    expect(off).toContain('type="checkbox"')
    expect(off).not.toContain('checked=""')
    expect(on).toContain('checked=""')
  })

  it('selects OAuth for a custom URL, preserves token fallback, and invalidates the old verification', () => {
    const original = {
      ...blankDraft('http'), name: 'remote', url: 'https://example.test/mcp',
      bearerTokenEnvVar: 'TOKEN', lastVerifiedAt: 123,
    }
    let draft: McpServerRegistration = original
    const onChange = vi.fn((enabled: boolean) => { draft = { ...draft, oauth: enabled || undefined } })
    const control = McpHttpOAuthToggle({ enabled: false, onChange })
    const input = control.props.children[1] as React.ReactElement<React.InputHTMLAttributes<HTMLInputElement>>
    input.props.onChange!({ target: { checked: true } } as React.ChangeEvent<HTMLInputElement>)

    expect(onChange).toHaveBeenCalledWith(true)
    expect(isOAuthEntry(draft)).toBe(true)
    const connected = buildMcpServerConfigFromRegistration(draft)
    expect(connected.oauth).toBe(true)
    expect(connected.bearer_token_env_var).toBeUndefined()
    expect(MCP_EXECUTABLE_IDENTITY_FIELDS).toContain('oauth')
    expect(sameExecutableIdentity(original, draft)).toBe(false)
    // Persisting and reopening the registration retains the chosen auth mode.
    expect(isOAuthEntry(JSON.parse(JSON.stringify(draft)))).toBe(true)

    input.props.onChange!({ target: { checked: false } } as React.ChangeEvent<HTMLInputElement>)
    const tokenConfig = buildMcpServerConfigFromRegistration(draft)
    expect(tokenConfig.oauth).toBeUndefined()
    expect(tokenConfig.bearer_token_env_var).toBe('TOKEN')
  })
})
