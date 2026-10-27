import { describe, it, expect } from 'vitest'
import { buildTranscript, claudeToolAlias, fingerprint, fromClaudeToolName, toApiMessage, toClaudeToolName, toolAliasMap } from '../../../src/main/providers/claude-subscription/transcript'
import { sessionConfig, splitForColdStart } from '../../../src/main/providers/claude-subscription/provider'
import { extractLoginUrl, stripAnsi } from '../../../src/main/providers/claude-subscription/auth-manager'
import { compareVersions } from '../../../src/main/utils/version-compare'
import type { LLMMessage } from '../../../src/shared/types/provider.types'

describe('claude-subscription transcript', () => {
  it('maps tool names through the adf MCP server', () => {
    expect(toClaudeToolName('fs_read')).toBe('mcp__adf__fs_read')
    expect(fromClaudeToolName('mcp__adf__fs_read')).toBe('fs_read')
    expect(fromClaudeToolName('other')).toBe('other')
  })

  it('shortens names over the 64-character API limit, deterministically and reversibly', () => {
    const long = 'mcp_google-drive_' + 'very_long_operation_name_'.repeat(3)
    const claude = toClaudeToolName(long)
    expect(claude.length).toBeLessThanOrEqual(64)
    expect(toClaudeToolName(long)).toBe(claude)
    expect(claudeToolAlias('short_name')).toBe('short_name')
    expect(fromClaudeToolName(claude, toolAliasMap([long, 'fs_read']))).toBe(long)
  })

  it('converts assistant tool calls and drops thinking', () => {
    const api = toApiMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 't1', name: 'fs_read', input: { path: 'a' } },
      ],
    })
    expect(api).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 't1', name: 'mcp__adf__fs_read', input: { path: 'a' } },
      ],
    })
  })

  it('puts tool results first and carries side text, images and the provenance prefix', () => {
    const api = toApiMessage({
      role: 'user',
      seq: 7,
      content: [
        { type: 'text', text: 'also this' },
        { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: true },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'input_audio', input_audio: { data: 'x', format: 'wav' } },
      ],
    })
    expect(api?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: true },
      { type: 'text', text: 'also this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: '[audio attachment omitted: not supported by Claude]' },
    ])
    const plain = toApiMessage({ role: 'user', seq: 3, content: [{ type: 'text', text: 'hi' }] })
    expect(plain?.content).toEqual([{ type: 'text', text: '[S3] hi' }])
  })

  it('fingerprints ignore thinking and metadata', () => {
    const a: LLMMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi ' }], created_at: 1 }
    const b: LLMMessage = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
    expect(fingerprint(a)).toBe(fingerprint(b))
    expect(fingerprint({ role: 'user', content: 'hi' })).not.toBe(fingerprint(b))
  })

  it('builds a linked transcript', () => {
    const entries = buildTranscript([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ], 'sid', '/tmp/c', 'claude-haiku-4-5')
    expect(entries.map((e) => e.type)).toEqual(['user', 'assistant', 'user'])
    expect(entries[0].parentUuid).toBeNull()
    expect(entries[1].parentUuid).toBe(entries[0].uuid)
    expect(entries[2].parentUuid).toBe(entries[1].uuid)
    expect(entries[1].message).toMatchObject({ role: 'assistant', stop_reason: 'tool_use', model: 'claude-haiku-4-5' })
    expect(entries.every((e) => e.sessionId === 'sid' && e.cwd === '/tmp/c')).toBe(true)
  })
})

describe('claude-subscription session config', () => {
  const base = { system: 's', messages: [] }

  it('leaves the output cap to the model and maps reasoning', () => {
    const adaptive = sessionConfig('m', { ...base, maxTokens: 4096, reasoning: { enabled: true, effort: 'high' } })
    expect(adaptive).toMatchObject({ thinking: { type: 'adaptive' }, effort: 'high' })
    expect(adaptive.maxOutputTokens).toBeUndefined()
    expect(sessionConfig('m', { ...base, reasoning: { max_tokens: 8000 } }).thinking).toMatchObject({ type: 'enabled', budgetTokens: 8000 })
    expect(sessionConfig('m', { ...base }).thinking).toEqual({ type: 'disabled' })
    expect(sessionConfig('m', { ...base, thinkingBudget: 0 }).thinking).toEqual({ type: 'disabled' })
  })
})

describe('claude-subscription cold start', () => {
  it('sends a trailing user message as the prompt', () => {
    const { history, prompt } = splitForColdStart([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ])
    expect(history).toHaveLength(2)
    expect(prompt).toEqual([{ type: 'text', text: 'c' }])
  })

  it('replays trailing tool results and asks the model to continue', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
    ]
    const { history, prompt } = splitForColdStart(messages)
    expect(history).toBe(messages)
    expect(prompt).toEqual([{ type: 'text', text: 'Continue.' }])
  })
})

describe('claude-subscription auth helpers', () => {
  const raw = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: \u001b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\u0007https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\u001b]8;;\u0007\nPaste code here if prompted > '

  it('extracts the sign-in URL from OSC 8 output', () => {
    expect(extractLoginUrl(raw)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz')
  })

  it('strips terminal escapes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007')).toBe('red link')
  })

  it('compares versions numerically', () => {
    expect(compareVersions('2.1.296', '2.1.248')).toBe(1)
    expect(compareVersions('2.1.248', '2.1.248')).toBe(0)
    expect(compareVersions('2.0.999', '2.1.0')).toBe(-1)
  })
})
