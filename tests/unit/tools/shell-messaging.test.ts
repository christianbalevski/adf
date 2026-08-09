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

// ── 2b. Discovery commands default to scope:'all' (the mesh view) ──

describe('shell discovery scope', () => {
  async function getHandlers() {
    const { messagingHandlers } = await import(
      '../../../src/main/tools/shell/commands/messaging'
    )
    return {
      msg: messagingHandlers.find((h) => h.name === 'msg')!,
      who: messagingHandlers.find((h) => h.name === 'who')!,
      ping: messagingHandlers.find((h) => h.name === 'ping')!,
    }
  }

  function makeCtx(o: { args?: string[]; flags?: any; discoverContent?: string }) {
    const calls: Array<{ tool: string; input: any }> = []
    return {
      calls,
      ctx: {
        args: o.args ?? [], flags: o.flags ?? {}, stdin: '',
        workspace: {},
        toolRegistry: {
          executeTool: vi.fn(async (tool: string, input: any) => {
            calls.push({ tool, input })
            return { content: o.discoverContent ?? '[]', isError: false }
          }),
        },
        config: {}, env: {},
      } as any,
    }
  }

  it('who passes scope:"all" by default', async () => {
    const { who } = await getHandlers()
    const { ctx, calls } = makeCtx({})
    const result = await who.execute(ctx)
    expect(result.exit_code).toBe(0)
    expect(calls[0]).toEqual({ tool: 'agent_discover', input: { scope: 'all' } })
  })

  it('who --local narrows to scope:"local"', async () => {
    const { who } = await getHandlers()
    const { ctx, calls } = makeCtx({ flags: { local: true } })
    await who.execute(ctx)
    expect(calls[0].input).toEqual({ scope: 'local' })
  })

  it('msg --agents passes scope:"all" by default', async () => {
    const { msg } = await getHandlers()
    const { ctx, calls } = makeCtx({ flags: { agents: true } })
    await msg.execute(ctx)
    expect(calls[0]).toEqual({ tool: 'agent_discover', input: { scope: 'all' } })
  })

  it('msg --agents --local narrows to scope:"local"', async () => {
    const { msg } = await getHandlers()
    const { ctx, calls } = makeCtx({ flags: { agents: true, local: true } })
    await msg.execute(ctx)
    expect(calls[0].input).toEqual({ scope: 'local' })
  })

  it('ping always discovers with scope:"all"', async () => {
    const { ping } = await getHandlers()
    const cards = JSON.stringify([{ handle: 'peer_a', did: 'did:key:z6MkpeerA' }])
    const { ctx, calls } = makeCtx({ args: ['peer_a'], discoverContent: cards })
    const result = await ping.execute(ctx)
    expect(calls[0]).toEqual({ tool: 'agent_discover', input: { scope: 'all' } })
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe('peer_a: reachable')
  })

  it('ping matches by DID as well as handle', async () => {
    const { ping } = await getHandlers()
    const cards = JSON.stringify([{ handle: 'peer_a', did: 'did:key:z6MkpeerA' }])
    const { ctx } = makeCtx({ args: ['did:key:z6MkpeerA'], discoverContent: cards })
    const result = await ping.execute(ctx)
    expect(result.stdout).toBe('did:key:z6MkpeerA: reachable')
  })

  it('ping handles the plain-string "no agents" response with a clear message', async () => {
    const { ping } = await getHandlers()
    const { ctx } = makeCtx({
      args: ['ghost'],
      discoverContent: 'No other agents are reachable from your current scope.',
    })
    const result = await ping.execute(ctx)
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe('ghost: not found (no agents reachable from this runtime)')
  })

  it('ping reports "not found" when agents exist but none match', async () => {
    const { ping } = await getHandlers()
    const cards = JSON.stringify([{ handle: 'peer_a', did: 'did:key:z6MkpeerA' }])
    const { ctx } = makeCtx({ args: ['ghost'], discoverContent: cards })
    const result = await ping.execute(ctx)
    expect(result.stdout).toContain('ghost: not found')
    expect(result.stdout).toContain('1 discoverable agent')
  })

  it('ping surfaces a discover tool error instead of claiming not-found', async () => {
    const { ping } = await getHandlers()
    const ctx: any = {
      args: ['peer_a'], flags: {}, stdin: '', workspace: {},
      toolRegistry: { executeTool: vi.fn(async () => ({ content: 'boom', isError: true })) },
      config: {}, env: {},
    }
    const result = await ping.execute(ctx)
    expect(result.exit_code).not.toBe(0)
    expect(result.stderr).toContain('ping: boom')
  })
})

// ── 2c. msg gates each subcommand on the tool it actually dispatches ──

describe('shell msg resolveToolsFromArgs gating', () => {
  const lit = (value: string) => ({ type: 'literal', value }) as any

  async function resolver() {
    const { messagingHandlers } = await import(
      '../../../src/main/tools/shell/commands/messaging'
    )
    const msg = messagingHandlers.find((h) => h.name === 'msg')!
    expect(msg.resolvedTools).toEqual([]) // static list must not force msg_send onto every subcommand
    return (args: any[]) => msg.resolveToolsFromArgs!(args)
  }

  it('gates each subcommand on its actual tool', async () => {
    const resolve = await resolver()
    expect(resolve([lit('--read')])).toEqual(['msg_read'])
    expect(resolve([lit('--read'), lit('--status'), lit('archived')])).toEqual(['msg_read'])
    expect(resolve([lit('--list')])).toEqual(['msg_list'])
    expect(resolve([lit('--agents')])).toEqual(['agent_discover'])
    expect(resolve([lit('--agents'), lit('--local')])).toEqual(['agent_discover'])
    expect(resolve([lit('--update'), lit('m1,m2'), lit('--status'), lit('read')])).toEqual(['msg_update'])
    expect(resolve([lit('--archive'), lit('m1')])).toEqual(['msg_update'])
    expect(resolve([lit('--delete'), lit('m1')])).toEqual(['msg_update'])
  })

  it('plain send resolves to msg_send', async () => {
    const resolve = await resolver()
    expect(resolve([lit('did:key:z6Mkabc'), lit('hello')])).toEqual(['msg_send'])
    expect(resolve([])).toEqual(['msg_send'])
  })

  it('handles --flag=value form and quoted literal flags', async () => {
    const resolve = await resolver()
    expect(resolve([lit('--update=m1'), lit('--status'), lit('read')])).toEqual(['msg_update'])
    const quoted = { type: 'quoted', quote: 'single', parts: [lit('--read')] } as any
    expect(resolve([quoted])).toEqual(['msg_read'])
  })

  it('flags after -- are positional, not subcommands', async () => {
    const resolve = await resolver()
    expect(resolve([lit('did:key:z6Mkabc'), lit('--'), lit('--read')])).toEqual(['msg_send'])
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
      undefined,                                    // content_type
    )
  })

  it('validates typed form content at send time', async () => {
    const { SendMessageTool } = await import(
      '../../../src/main/tools/built-in/msg-send.tool'
    )
    const sendFn = vi.fn(async () => ({ success: true, messageId: 'msg-002' }))
    const checkFn = vi.fn(() => ({ sendMode: 'proactive' as const, isMessageTriggered: false }))
    const tool = new SendMessageTool(sendFn, checkFn)
    const workspace: any = {}
    const base = {
      recipient: 'telegram:555',
      content_type: 'application/vnd.adf.form+json',
    }

    // Not JSON at all
    const notJson = await tool.execute({ ...base, content: 'just some text' }, workspace)
    expect(notJson.isError).toBe(true)
    expect(notJson.content).toContain('not valid JSON')
    expect(sendFn).not.toHaveBeenCalled()

    // JSON but wrong shape
    const badShape = await tool.execute(
      { ...base, content: JSON.stringify({ id: 'BAD ID', questions: [] }) },
      workspace,
    )
    expect(badShape.isError).toBe(true)
    expect(badShape.content).toContain('Invalid form content')
    expect(sendFn).not.toHaveBeenCalled()

    // Valid form goes through with the content_type threaded to sendFn
    const form = {
      id: 'poll1',
      render: 'poll',
      questions: [
        { id: 'q1', text: 'Ship it?', type: 'choice', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] },
      ],
    }
    const ok = await tool.execute({ ...base, content: JSON.stringify(form) }, workspace)
    expect(ok.isError).toBe(false)
    expect(sendFn).toHaveBeenCalledTimes(1)
    expect(sendFn.mock.calls[0][2]).toBe(JSON.stringify(form))
    expect(sendFn.mock.calls[0][9]).toBe('application/vnd.adf.form+json')
  })
})
