import { describe, it, expect, vi } from 'vitest'

/**
 * Focused tests for shell `msg` command → msg_send mapping
 * and SendMessageTool contract.
 */

// ── 1. Shell msg handler maps positional recipient to msg_send.recipient ──

describe('shell msg command', () => {
  it('maps positional recipient to msg_send.recipient', async () => {
    // Dynamic import so the module resolves correctly
    const { messagingHandlers } = await import(
      '../../../src/main/tools/shell/commands/messaging'
    )
    const msgHandler = messagingHandlers.find((h) => h.name === 'msg')!

    let capturedInput: unknown = null

    const fakeToolRegistry = {
      executeTool: vi.fn(async (_name: string, input: unknown) => {
        capturedInput = input
        return { content: 'sent', isError: false }
      }),
    }

    const ctx: any = {
      args: ['did:key:z6Mkabc', 'Hello world'],
      flags: {},
      stdin: '',
      workspace: {},
      toolRegistry: fakeToolRegistry,
      config: {},
      env: {},
    }

    const result = await msgHandler.execute(ctx)

    expect(result.exit_code).toBe(0)
    expect(fakeToolRegistry.executeTool).toHaveBeenCalledWith(
      'msg_send',
      expect.objectContaining({ recipient: 'did:key:z6Mkabc', content: 'Hello world' }),
      ctx.workspace,
    )
    // Ensure the old `to` key is NOT present
    expect(capturedInput).not.toHaveProperty('to')
  })
})

// ── 1b. Shell msg --address maps to msg_send.address ──

describe('shell msg --address maps to address', () => {
  it('passes --address value as address to msg_send', async () => {
    const { messagingHandlers } = await import(
      '../../../src/main/tools/shell/commands/messaging'
    )
    const msgHandler = messagingHandlers.find((h) => h.name === 'msg')!

    let capturedInput: Record<string, unknown> = {}

    const fakeToolRegistry = {
      executeTool: vi.fn(async (_name: string, input: unknown) => {
        capturedInput = input as Record<string, unknown>
        return { content: 'sent', isError: false }
      }),
    }

    const ctx: any = {
      args: ['did:key:z6Mkabc', 'Hello'],
      flags: { address: 'http://127.0.0.1:7295/cb-mesh-client/inbox' },
      stdin: '',
      workspace: {},
      toolRegistry: fakeToolRegistry,
      config: {},
      env: {},
    }

    const result = await msgHandler.execute(ctx)

    expect(result.exit_code).toBe(0)
    expect(capturedInput.address).toBe('http://127.0.0.1:7295/cb-mesh-client/inbox')
  })
})

// ── 1c. Shell msg <bare-handle> is passed through to msg_send (which resolves
//        local handles) rather than rejected by the shell ──

describe('shell msg bare handle', () => {
  it('passes a bare handle through to msg_send as the recipient', async () => {
    const { messagingHandlers } = await import(
      '../../../src/main/tools/shell/commands/messaging'
    )
    const msgHandler = messagingHandlers.find((h) => h.name === 'msg')!

    const fakeToolRegistry = {
      executeTool: vi.fn(async () => ({ content: 'sent', isError: false })),
    }

    const ctx: any = {
      args: ['local_agent', 'Hello'],
      flags: {},
      stdin: '',
      workspace: {},
      toolRegistry: fakeToolRegistry,
      config: {},
      env: {},
    }

    const result = await msgHandler.execute(ctx)

    expect(result.exit_code).toBe(0)
    expect(fakeToolRegistry.executeTool).toHaveBeenCalledWith(
      'msg_send',
      expect.objectContaining({ recipient: 'local_agent', content: 'Hello' }),
      expect.anything(),
    )
  })
})

// ── 2. Shell msg --delete archives THEN deletes (delete only works on archived) ──

describe('shell msg --delete command', () => {
  it('archives then deletes so it works on any message state', async () => {
    const { messagingHandlers } = await import(
      '../../../src/main/tools/shell/commands/messaging'
    )
    const msgHandler = messagingHandlers.find((h) => h.name === 'msg')!

    const fakeToolRegistry = {
      executeTool: vi.fn(async () => ({ content: 'ok', isError: false })),
    }

    const ctx: any = {
      args: [], flags: { delete: 'msg-42' }, stdin: '',
      workspace: {}, toolRegistry: fakeToolRegistry, config: {}, env: {},
    }

    const result = await msgHandler.execute(ctx)

    expect(result.exit_code).toBe(0)
    const calls = fakeToolRegistry.executeTool.mock.calls
    expect(calls[0]).toEqual(['msg_update', { message_ids: ['msg-42'], status: 'archived' }, ctx.workspace])
    expect(calls[1]).toEqual(['msg_update', { message_ids: ['msg-42'], status: 'delete' }, ctx.workspace])
  })
})

// ── 3. SendMessageTool accepts { recipient, content } and calls sendFn ──

describe('SendMessageTool', () => {
  it('accepts { recipient, content } and calls sendFn successfully', async () => {
    const { SendMessageTool } = await import(
      '../../../src/main/tools/built-in/msg-send.tool'
    )

    const sendFn = vi.fn(async () => ({
      success: true,
      messageId: 'msg-001',
    }))

    const checkFn = vi.fn(() => ({
      sendMode: 'proactive' as const,
      isMessageTriggered: false,
    }))

    const tool = new SendMessageTool(sendFn, checkFn)

    // Minimal workspace stub — msg_send requires DID+address directly now.
    const workspace: any = {}

    const result = await tool.execute(
      {
        recipient: 'did:key:z6Mktest',
        address: 'http://127.0.0.1:7295/test/inbox',
        content: 'ping',
      },
      workspace,
    )

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Message sent to did:key:z6Mktest')
    expect(sendFn).toHaveBeenCalledWith(
      'did:key:z6Mktest',                           // recipient
      'http://127.0.0.1:7295/test/inbox',      // address
      'ping',                                       // content
      undefined,                                    // subject
      undefined,                                    // thread_id
      undefined,                                    // parent_id
      undefined,                                    // attachments
      undefined,                                    // meta
      undefined,                                    // message_meta
    )
  })
})
