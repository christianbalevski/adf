import { describe, expect, it, vi } from 'vitest'

import { ChatInfoTool } from '../../../src/main/tools/built-in/chat-info.tool'
import type { ChatInfoFn } from '../../../src/main/tools/built-in/chat-info.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { ChatInfo } from '../../../src/shared/types/channel-adapter.types'

const workspace = {} as AdfWorkspace

function makeInfo(overrides: Partial<ChatInfo> = {}): ChatInfo {
  return {
    platform: 'telegram',
    chat_id: '-100123',
    chat_type: 'supergroup',
    title: 'Team Chat',
    participant_count: 10,
    participants: [{ id: '1', name: 'Alice', role: 'creator' }],
    participants_truncated: true,
    participants_scope: 'admins',
    fetched_at: 1700000000000,
    ...overrides
  }
}

describe('ChatInfoTool', () => {
  describe('input schema', () => {
    it('rejects missing adapter and chat_id', () => {
      const tool = new ChatInfoTool(vi.fn() as ChatInfoFn)
      expect(tool.inputSchema.safeParse({}).success).toBe(false)
      expect(tool.inputSchema.safeParse({ adapter: 'telegram' }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ chat_id: '123' }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ adapter: '', chat_id: '123' }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ adapter: 'telegram', chat_id: '123' }).success).toBe(true)
    })

    it('bounds limit to an integer between 1 and 100', () => {
      const tool = new ChatInfoTool(vi.fn() as ChatInfoFn)
      const base = { adapter: 'telegram', chat_id: '123' }
      expect(tool.inputSchema.safeParse({ ...base, limit: 0 }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ ...base, limit: 101 }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ ...base, limit: 2.5 }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ ...base, limit: 50 }).success).toBe(true)
    })
  })

  it('returns the chat info as JSON when the adapter supports the lookup', async () => {
    const info = makeInfo()
    const fn = vi.fn().mockResolvedValue({ supported: true, info })
    const tool = new ChatInfoTool(fn)

    const result = await tool.execute({ adapter: 'telegram', chat_id: '-100123' }, workspace)

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual(info)
    expect(fn).toHaveBeenCalledWith('telegram', '-100123', undefined)
  })

  it('returns a non-error structured result when unsupported', async () => {
    const fn = vi.fn().mockResolvedValue({ supported: false, reason: 'Bot not connected' })
    const tool = new ChatInfoTool(fn)

    const result = await tool.execute({ adapter: 'telegram', chat_id: '123' }, workspace)

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.content)
    expect(parsed.supported).toBe(false)
    expect(parsed.reason).toContain('Bot not connected')
    expect(parsed.reason).not.toContain('source_context.to')
  })

  it('appends the source_context.to/cc hint for unsupported email lookups', async () => {
    const fn = vi.fn().mockResolvedValue({ supported: false, reason: 'Email has no live roster' })
    const tool = new ChatInfoTool(fn)

    const result = await tool.execute({ adapter: 'email', chat_id: 'thread-1' }, workspace)

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.content)
    expect(parsed.supported).toBe(false)
    expect(parsed.reason).toContain('Email has no live roster')
    expect(parsed.reason).toContain('source_context.to')
    expect(parsed.reason).toContain('source_context.cc')
    expect(parsed.reason).toContain('msg_read')
  })

  it('passes limit through to the injected chat-info fn', async () => {
    const fn = vi.fn().mockResolvedValue({ supported: true, info: makeInfo() })
    const tool = new ChatInfoTool(fn)

    await tool.execute({ adapter: 'discord', chat_id: 'chan-9', limit: 7 }, workspace)

    expect(fn).toHaveBeenCalledWith('discord', 'chan-9', { limit: 7 })
  })
})
