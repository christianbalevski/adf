import { describe, expect, it, vi } from 'vitest'

import { ChannelAdapterManager } from '../../../src/main/services/channel-adapter-manager'
import type {
  AdapterContext,
  AdapterInstanceConfig,
  AdapterStatus,
  ChannelAdapter,
  InboundMessage
} from '../../../src/shared/types/channel-adapter.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

/** Adapter that connects immediately and hands its ctx to the test. */
class CtxCaptureAdapter implements ChannelAdapter {
  ctx: AdapterContext | null = null
  currentStatus: AdapterStatus = 'disconnected'

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    this.currentStatus = 'connected'
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
  }

  async send() {
    return { success: true as const }
  }

  canDeliver(): boolean {
    return true
  }

  status(): AdapterStatus {
    return this.currentStatus
  }
}

const config: AdapterInstanceConfig = { enabled: true }

function makeWorkspace(existingIds: string[] = []): AdfWorkspace {
  let seq = 0
  return {
    addToInbox: vi.fn(() => `inbox-${++seq}`),
    hasInboxMessage: vi.fn((_source: string, messageId: string) => existingIds.includes(messageId)),
    findOutboxByMetaValue: vi.fn(() => null),
    findOutboxByMetaArrayValue: vi.fn(() => null)
  } as unknown as AdfWorkspace
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { sender: 'U1', payload: 'hello', ...overrides }
}

async function startCaptured(
  workspace: AdfWorkspace
): Promise<{ manager: ChannelAdapterManager; ctx: AdapterContext }> {
  const manager = new ChannelAdapterManager()
  const adapter = new CtxCaptureAdapter()
  const ok = await manager.startAdapter('test', () => adapter, config, workspace)
  expect(ok).toBe(true)
  return { manager, ctx: adapter.ctx! }
}

describe('ChannelAdapterManager ingest dedup', () => {
  it('skips a message whose (source, messageId) already has an inbox row', async () => {
    const workspace = makeWorkspace(['chat1:42'])
    const { manager, ctx } = await startCaptured(workspace)
    const onInbound = vi.fn()
    manager.on('inbound', onInbound)

    const result = ctx.ingest(inbound({ messageId: 'chat1:42' }))

    expect(result).toBeNull()
    expect(workspace.addToInbox).not.toHaveBeenCalled()
    expect(onInbound).not.toHaveBeenCalled()
  })

  it('ingests and emits when the messageId is new, returning the inbox id', async () => {
    const workspace = makeWorkspace(['chat1:42'])
    const { manager, ctx } = await startCaptured(workspace)
    const onInbound = vi.fn()
    manager.on('inbound', onInbound)

    const result = ctx.ingest(inbound({ messageId: 'chat1:43' }))

    expect(result).toBe('inbox-1')
    expect(onInbound).toHaveBeenCalledTimes(1)
  })

  it('never consults the dedup index for messages without a messageId', async () => {
    const workspace = makeWorkspace()
    const { ctx } = await startCaptured(workspace)

    const result = ctx.ingest(inbound())

    expect(result).toBe('inbox-1')
    expect(workspace.hasInboxMessage).not.toHaveBeenCalled()
  })
})

describe('ChannelAdapterManager catch-up phase', () => {
  it('holds inbound notifications during the drain and flushes them in order on endCatchUp', async () => {
    const workspace = makeWorkspace()
    const { manager, ctx } = await startCaptured(workspace)
    const onInbound = vi.fn()
    manager.on('inbound', onInbound)

    ctx.beginCatchUp!()
    ctx.ingest(inbound({ payload: 'first' }))
    ctx.ingest(inbound({ payload: 'second' }))
    // Inbox writes happen immediately (fully visible)...
    expect(workspace.addToInbox).toHaveBeenCalledTimes(2)
    // ...but the trigger-facing notifications are held.
    expect(onInbound).not.toHaveBeenCalled()

    const summary = ctx.endCatchUp!()

    expect(summary).toEqual({ ingested: 2, deduped: 0 })
    expect(onInbound).toHaveBeenCalledTimes(2)
    expect(onInbound.mock.calls[0][1].payload).toBe('first')
    expect(onInbound.mock.calls[1][1].payload).toBe('second')
  })

  it('counts dedup skips during the drain', async () => {
    const workspace = makeWorkspace(['dup:1'])
    const { ctx } = await startCaptured(workspace)

    ctx.beginCatchUp!()
    ctx.ingest(inbound({ messageId: 'dup:1' }))
    ctx.ingest(inbound({ messageId: 'new:2' }))
    const summary = ctx.endCatchUp!()

    expect(summary).toEqual({ ingested: 1, deduped: 1 })
  })

  it('nests: only the outermost endCatchUp flushes', async () => {
    const workspace = makeWorkspace()
    const { manager, ctx } = await startCaptured(workspace)
    const onInbound = vi.fn()
    manager.on('inbound', onInbound)

    ctx.beginCatchUp!()
    ctx.beginCatchUp!()
    ctx.ingest(inbound())
    ctx.endCatchUp!()
    expect(onInbound).not.toHaveBeenCalled()
    ctx.endCatchUp!()
    expect(onInbound).toHaveBeenCalledTimes(1)
  })

  it('endCatchUp without a begin is a harmless no-op', async () => {
    const workspace = makeWorkspace()
    const { ctx } = await startCaptured(workspace)

    expect(ctx.endCatchUp!()).toEqual({ ingested: 0, deduped: 0 })
  })

  it('resumes immediate emission after the drain ends', async () => {
    const workspace = makeWorkspace()
    const { manager, ctx } = await startCaptured(workspace)
    const onInbound = vi.fn()
    manager.on('inbound', onInbound)

    ctx.beginCatchUp!()
    ctx.endCatchUp!()
    ctx.ingest(inbound())

    expect(onInbound).toHaveBeenCalledTimes(1)
  })

  it('flushes an orphaned drain when the adapter is stopped mid-catch-up', async () => {
    const workspace = makeWorkspace()
    const { manager, ctx } = await startCaptured(workspace)
    const onInbound = vi.fn()
    manager.on('inbound', onInbound)

    ctx.beginCatchUp!()
    ctx.ingest(inbound())
    // Adapter dies before endCatchUp — the messages are already in the inbox;
    // their notifications must not be lost.
    await manager.stopAdapter('test')

    expect(onInbound).toHaveBeenCalledTimes(1)
  })
})
