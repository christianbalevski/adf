import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-inbox-http-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-inbox-http-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf-8'), decryptString: (b: Buffer) => b.toString('utf-8') },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { MeshManager } from '../../src/main/runtime/mesh-manager'
import { MeshServer } from '../../src/main/services/mesh-server'
import { createDefaultPipeline, type MessagingPipelineContext } from '../../src/main/services/alf-pipeline'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import type { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import type { AlfMessage, SecurityConfig, Visibility } from '../../src/shared/types/adf-v02.types'

async function standUp(handle: string, port: number, opts: { blockList?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `adf-inbox-http-${handle}-`))
  const filePath = join(dir, `${handle}.adf`)
  const agent = createHeadlessAgent({
    filePath,
    name: handle,
    provider: new MockLLMProvider(),
    createOptions: {
      handle,
      messaging: {
        mode: 'respond_only',
        visibility: 'localhost' as Visibility,
        receive: true,
        ...(opts.blockList ? { block_list: opts.blockList } : {})
      } as never
    }
  })
  const did = agent.workspace.getDid()!
  const mesh = new MeshManager([dir])
  mesh.enableMesh()
  mesh.registerServableAgent(filePath, agent.workspace.getAgentConfig(), agent.registry, agent.workspace, agent.session, agent.executor)

  const settingsStub = { get: (k: string) => (k === 'meshPort' ? port : undefined) }
  const server = new MeshServer(new CodeSandboxService(), settingsStub)
  server.setMeshManager(mesh)
  await server.start()
  if (!server.isRunning()) throw new Error(`mesh server failed to start on ${port}`)

  const dispose = async () => {
    try { await server.stop() } catch { /* best-effort */ }
    try { mesh.unregisterAgent(filePath) } catch { /* best-effort */ }
    agent.dispose()
  }
  return { dir, filePath, agent, did, mesh, server, port, handle, dispose }
}

/** Produce a signed (level 1) or signed+encrypted (level 2) wire message via the egress pipeline. */
async function buildWireMessage(
  senderWorkspace: AdfWorkspace,
  senderDid: string,
  recipientDid: string,
  content: string,
  level: 1 | 2,
  replyTo: string
): Promise<AlfMessage> {
  const message: AlfMessage = {
    version: '0.1', network: 'devnet', id: `m-${content.length}-${level}`, timestamp: new Date(0).toISOString(),
    from: senderDid, to: recipientDid, reply_to: replyTo,
    payload: { content, content_type: 'text/plain', sent_at: new Date(0).toISOString() }
  }
  const security: SecurityConfig = { allow_unsigned: false, level }
  const ctx: MessagingPipelineContext = {
    direction: 'egress', workspace: senderWorkspace, localDid: senderDid, remoteDid: recipientDid,
    isLocal: false, security, derivedKey: null
  }
  const result = await createDefaultPipeline().processEgress(message, ctx)
  if (result.rejected) throw new Error(`egress rejected: ${result.rejected.reason}`)
  return result.data
}

async function post(port: number, handle: string, message: AlfMessage) {
  const res = await fetch(`http://127.0.0.1:${port}/agents/${handle}/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

describe('HTTP mesh inbox (POST /agents/:handle/inbox)', () => {
  it('accepts an encrypted message and stores it decrypted', async () => {
    const recipient = await standUp('recv-enc', 38911)
    const sender = await standUp('send-enc', 38912)
    try {
      const wire = await buildWireMessage(
        sender.agent.workspace, sender.did, recipient.did, 'launch code 0000', 2,
        `http://127.0.0.1:${sender.port}/send-enc/inbox`
      )
      // On the wire the payload is ciphertext, not the plaintext.
      expect(wire.payload.content_type).toBe('application/x-adf-encrypted')
      expect(JSON.stringify(wire)).not.toContain('launch code')

      const res = await post(recipient.port, recipient.handle, wire)
      expect(res.status).toBe(202)
      expect(res.body.message_id).toBeTruthy()

      const inbox = recipient.agent.workspace.getInbox()
      expect(inbox.length).toBe(1)
      expect(inbox[0].content).toBe('launch code 0000')
    } finally {
      await sender.dispose()
      await recipient.dispose()
    }
  })

  it('rejects a sender on the recipient block list with 403 and stores nothing', async () => {
    const sender = await standUp('send-blk', 38914)
    const recipient = await standUp('recv-blk', 38913, { blockList: [sender.did] })
    try {
      const wire = await buildWireMessage(
        sender.agent.workspace, sender.did, recipient.did, 'let me in', 1,
        `http://127.0.0.1:${sender.port}/send-blk/inbox`
      )
      const res = await post(recipient.port, recipient.handle, wire)
      expect(res.status).toBe(403)
      expect(recipient.agent.workspace.getInbox().length).toBe(0)
    } finally {
      await sender.dispose()
      await recipient.dispose()
    }
  })

  it('verifies a signed message whose reply_to is a loopback host (reply_to not mutated pre-verification)', async () => {
    const recipient = await standUp('recv-sig', 38915)
    const sender = await standUp('send-sig', 38916)
    try {
      const wire = await buildWireMessage(
        sender.agent.workspace, sender.did, recipient.did, 'signed hello', 1,
        `http://127.0.0.1:${sender.port}/send-sig/inbox`
      )
      const res = await post(recipient.port, recipient.handle, wire)
      expect(res.status).toBe(202)
      const inbox = recipient.agent.workspace.getInbox()
      expect(inbox[0].content).toBe('signed hello')
    } finally {
      await sender.dispose()
      await recipient.dispose()
    }
  })
})
