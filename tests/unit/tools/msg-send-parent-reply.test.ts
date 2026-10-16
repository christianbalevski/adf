import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { SendMessageTool, resolveParentReplyAddress } from '../../../src/main/tools/built-in/msg-send.tool'
import { rewriteLoopbackHost } from '../../../src/main/services/mesh-server'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

/**
 * parent_id replies to a remote mesh sender must route to the transport-
 * observed host, not the sender's loopback reply_to (which would hit this
 * runtime and 404). Repro: reply_to http://127.0.0.1:7295/agents/remote/inbox,
 * observed peer 100.80.54.124.
 */

const REMOTE_DID = 'did:key:z6MkRemoteSender'
const LOOPBACK_REPLY_TO = 'http://127.0.0.1:7295/agents/remote/inbox'
const OBSERVED_ROUTE = 'http://100.80.54.124:7295/agents/remote/inbox'

type Row = Record<string, unknown>

function makeTool() {
  const sendFn = vi.fn(async () => ({ success: true, messageId: 'm1', statusCode: 202 }))
  const tool = new SendMessageTool(sendFn, () => ({ sendMode: 'proactive', isMessageTriggered: true }))
  return { tool, sendFn }
}

function workspaceWith(row: Row): AdfWorkspace {
  return { getInboxMessageById: (id: string) => (id === row.id ? row : null) } as unknown as AdfWorkspace
}

async function replyTo(row: Row, extra: Record<string, unknown> = {}) {
  const { tool, sendFn } = makeTool()
  const result = await tool.execute({ parent_id: row.id, content: 'ack', ...extra }, workspaceWith(row))
  expect(result.isError).toBe(false)
  const call = sendFn.mock.calls[0] as unknown[]
  return { recipient: call[0], address: call[1], threadId: call[4], parentId: call[5] }
}

describe('msg_send parent_id reply routing', () => {
  it('routes a remote mesh reply to the transport-observed return_path, not loopback reply_to', async () => {
    // return_path exactly as the HTTP ingress computes it
    const returnPath = rewriteLoopbackHost(LOOPBACK_REPLY_TO, '100.80.54.124')
    expect(returnPath).toBe(OBSERVED_ROUTE)
    const out = await replyTo({
      id: 'in1', from: REMOTE_DID, reply_to: LOOPBACK_REPLY_TO, return_path: returnPath,
      source: 'mesh', thread_id: 't1', meta: { message_verified: true }
    })
    expect(out.address).toBe(OBSERVED_ROUTE)
    // DID binding unchanged: recipient is still the parent's verified sender
    expect(out.recipient).toBe(REMOTE_DID)
    expect(out.threadId).toBe('t1')
    expect(out.parentId).toBe('in1')
  })

  it('handles IPv4-mapped IPv6 peer and localhost reply_to', async () => {
    const replyToUrl = 'http://localhost:7295/agents/remote/inbox'
    const returnPath = rewriteLoopbackHost(replyToUrl, '::ffff:192.168.1.50')
    const out = await replyTo({ id: 'in2', from: REMOTE_DID, reply_to: replyToUrl, return_path: returnPath, source: 'mesh' })
    expect(out.address).toBe('http://192.168.1.50:7295/agents/remote/inbox')
  })

  it('an explicit address still wins over parent routing', async () => {
    const out = await replyTo(
      { id: 'in3', from: REMOTE_DID, reply_to: LOOPBACK_REPLY_TO, return_path: OBSERVED_ROUTE, source: 'mesh' },
      { address: 'http://10.0.0.9:7295/agents/remote/inbox' }
    )
    expect(out.address).toBe('http://10.0.0.9:7295/agents/remote/inbox')
  })

  it('keeps an intentional non-loopback reply_to even when return_path differs', async () => {
    const out = await replyTo({
      id: 'in4', from: REMOTE_DID, reply_to: 'https://relay.example.com/agents/remote/inbox',
      return_path: OBSERVED_ROUTE, source: 'mesh'
    })
    expect(out.address).toBe('https://relay.example.com/agents/remote/inbox')
  })

  it('keeps loopback reply_to for same-host delivery (ingress did not rewrite)', async () => {
    const returnPath = rewriteLoopbackHost(LOOPBACK_REPLY_TO, '127.0.0.1')
    const out = await replyTo({ id: 'in5', from: REMOTE_DID, reply_to: LOOPBACK_REPLY_TO, return_path: returnPath, source: 'mesh' })
    expect(out.address).toBe(LOOPBACK_REPLY_TO)
  })

  it('keeps loopback reply_to for same-runtime local delivery (no return_path stored)', async () => {
    const out = await replyTo({ id: 'in6', from: 'did:key:z6MkLocal', reply_to: 'http://127.0.0.1:7295/agents/peer/inbox', source: 'mesh' })
    expect(out.address).toBe('http://127.0.0.1:7295/agents/peer/inbox')
  })

  it('leaves adapter-sourced rows alone (wire return_path never becomes an address)', async () => {
    const out = await replyTo({
      id: 'in7', from: 'telegram:42', source: 'telegram', source_context: { chat_id: -100123, chat_type: 'group' },
      return_path: 'http://100.80.54.124:7295/agents/x/inbox'
    })
    // No address → mesh-manager routes via the adapter using source_context (group/thread)
    expect(out.address).toBeUndefined()
    expect(out.recipient).toBe('telegram:42')
  })
})

describe('resolveParentReplyAddress boundaries', () => {
  const base = { reply_to: LOOPBACK_REPLY_TO, source: 'mesh' }

  it('uses return_path only when it is the host-only rewrite of reply_to', () => {
    expect(resolveParentReplyAddress({ ...base, return_path: OBSERVED_ROUTE })).toBe(OBSERVED_ROUTE)
  })

  it.each([
    ['different path (other agent)', 'http://100.80.54.124:7295/agents/victim/inbox'],
    ['different port', 'http://100.80.54.124:9999/agents/remote/inbox'],
    ['different scheme', 'https://100.80.54.124:7295/agents/remote/inbox'],
    ['added query', 'http://100.80.54.124:7295/agents/remote/inbox?x=1'],
    ['added credentials', 'http://u:p@100.80.54.124:7295/agents/remote/inbox'],
    ['loopback return_path', 'http://127.0.0.2:7295/agents/remote/inbox'],
    ['malformed return_path', 'not a url']
  ])('falls back to reply_to on %s', (_label, returnPath) => {
    expect(resolveParentReplyAddress({ ...base, return_path: returnPath })).toBe(LOOPBACK_REPLY_TO)
  })

  it('ignores return_path on non-mesh rows (e.g. email Return-Path header)', () => {
    expect(resolveParentReplyAddress({ reply_to: LOOPBACK_REPLY_TO, return_path: OBSERVED_ROUTE, source: 'email' }))
      .toBe(LOOPBACK_REPLY_TO)
    expect(resolveParentReplyAddress({ reply_to: LOOPBACK_REPLY_TO, return_path: OBSERVED_ROUTE }))
      .toBe(LOOPBACK_REPLY_TO)
  })

  it('handles bracketed IPv6 loopback reply_to', () => {
    const replyToUrl = 'http://[::1]:7295/agents/remote/inbox'
    const returnPath = rewriteLoopbackHost(replyToUrl, 'fd7a:115c:a1e0::1')
    expect(resolveParentReplyAddress({ reply_to: replyToUrl, return_path: returnPath, source: 'mesh' })).toBe(returnPath)
  })

  it('returns undefined when there is no reply_to', () => {
    expect(resolveParentReplyAddress({ return_path: OBSERVED_ROUTE, source: 'mesh' })).toBeUndefined()
  })
})

describe('msg_send recipient written as a URL', () => {
  it('is refused, naming DID and inbox address, and nothing is sent', async () => {
    const { tool, sendFn } = makeTool()
    const result = await tool.execute(
      { recipient: 'http://192.0.2.10:7295/agents/peer/card', content: 'hi' },
      workspaceWith({ id: 'none' }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/is a URL/)
    expect(result.content).toMatch(/DID/)
    expect(result.content).toMatch(/\/inbox/)
    expect(result.content).not.toMatch(/Adapter "http"/)
    expect(sendFn).not.toHaveBeenCalled()
  })

  it('still lets adapter recipients and DIDs through', async () => {
    for (const recipient of ['telegram:123', 'did:key:z6MkPeer']) {
      const { tool, sendFn } = makeTool()
      await tool.execute({ recipient, address: recipient.startsWith('did:') ? 'http://192.0.2.20:7295/agents/peer/inbox' : undefined, content: 'hi' }, workspaceWith({ id: 'none' }))
      expect(sendFn).toHaveBeenCalled()
    }
  })
})
