import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-inline-att-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-inline-att-test', getVersion: () => '0.0.0-test' },
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
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import type { AlfMessage, Visibility } from '../../src/shared/types/adf-v02.types'

// Each agent runs in its own MeshManager + MeshServer, so sends between them
// take the remote (HTTP) transport, not the same-runtime fast path.
async function standUp(handle: string, port: number) {
  const dir = mkdtempSync(join(tmpdir(), `adf-inline-att-${handle}-`))
  const filePath = join(dir, `${handle}.adf`)
  const agent = createHeadlessAgent({
    filePath,
    name: handle,
    provider: new MockLLMProvider(),
    createOptions: {
      handle,
      messaging: { mode: 'proactive', visibility: 'localhost' as Visibility, receive: true } as never
    }
  })
  const did = agent.workspace.getDid()!
  const mesh = new MeshManager([dir])
  mesh.enableMesh()
  mesh.registerServableAgent(filePath, agent.workspace.getAgentConfig(), agent.registry, agent.workspace, agent.session, agent.executor)

  const server = new MeshServer(new CodeSandboxService(), { get: (k: string) => (k === 'meshPort' ? port : undefined) })
  server.setMeshManager(mesh)
  await server.start()
  if (!server.isRunning()) throw new Error(`mesh server failed to start on ${port}`)
  const boundPort = server.getPort()
  const inboxUrl = `http://127.0.0.1:${boundPort}/agents/${handle}/inbox`

  const dispose = async () => {
    try { await server.stop() } catch { /* best-effort */ }
    try { mesh.unregisterAgent(filePath) } catch { /* best-effort */ }
    agent.dispose()
  }
  return { filePath, agent, did, mesh, inboxUrl, handle, dispose }
}

function unsignedMessage(to: string, attachments: AlfMessage['payload']['attachments'], senderAlias = 'peer'): AlfMessage {
  return {
    version: '0.1', network: 'devnet', id: `m-${Math.random().toString(36).slice(2)}`, timestamp: new Date(0).toISOString(),
    from: 'did:key:zPeerSenderDid0123456789', to, reply_to: 'http://127.0.0.1:1/agents/peer/inbox',
    payload: { content: 'see attached', content_type: 'text/plain', sent_at: new Date(0).toISOString(), sender_alias: senderAlias, attachments }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mesh inline attachments between runtimes', () => {
  it('sends the bytes in the signed message and imports them on arrival (1 MiB, over HTTP)', async () => {
    const recipient = await standUp('recv-att', 38941)
    const sender = await standUp('send-att', 38942)
    try {
      const bytes = randomBytes(1024 * 1024)
      sender.agent.workspace.writeFileBuffer('blob.bin', bytes, 'application/octet-stream')
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const result = await sender.mesh.sendMessage(
        sender.filePath, recipient.did, recipient.inboxUrl, 'see attached',
        undefined, undefined, undefined, ['blob.bin']
      )
      expect(result.error).toBeUndefined()
      expect(result.statusCode).toBe(202)

      // (a) The wire message carries the bytes and is signed.
      const call = fetchSpy.mock.calls.find(c => String(c[0]) === recipient.inboxUrl)!
      const wire = JSON.parse(String((call[1] as RequestInit).body)) as AlfMessage
      const wireAtt = wire.payload.attachments![0]
      expect(wireAtt.transfer).toBe('inline')
      expect(wireAtt.size_bytes).toBe(bytes.length)
      expect(wireAtt.data).toBe(bytes.toString('base64'))
      expect(wire.signature).toBeTruthy()

      // (b) The recipient verified the signature and imported the file.
      const row = recipient.agent.workspace.getInbox()[0]
      expect(row.meta?.message_verified).toBe(true)
      const stored = row.attachments![0]
      expect(stored.transfer).toBe('imported')
      expect(stored.path).toBe('imported/send-att/blob.bin')
      expect(stored.data).toBeUndefined()
      expect(stored.size_bytes).toBe(bytes.length)
      expect(recipient.agent.workspace.readFileBuffer('imported/send-att/blob.bin')!.equals(bytes)).toBe(true)

      // Neither inbox nor outbox rows hold the base64 copy.
      const sample = bytes.subarray(0, 300).toString('base64')
      expect(JSON.stringify(row)).not.toContain(sample)
      expect(JSON.stringify(sender.agent.workspace.getOutbox())).not.toContain(sample)
    } finally {
      await sender.dispose()
      await recipient.dispose()
    }
  })

  it('rejects a signed message whose attachment bytes were altered in transit', async () => {
    const recipient = await standUp('recv-tamper', 38943)
    const sender = await standUp('send-tamper', 38944)
    try {
      sender.agent.workspace.writeFileBuffer('note.txt', Buffer.from('original'), 'text/plain')
      let captured: AlfMessage | null = null
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        captured = JSON.parse(String((init as RequestInit).body)) as AlfMessage
        return new Response(JSON.stringify({ message_id: 'x' }), { status: 202 })
      })
      await sender.mesh.sendMessage(sender.filePath, recipient.did, recipient.inboxUrl, 'hi', undefined, undefined, undefined, ['note.txt'])
      vi.restoreAllMocks()

      const tampered = captured! as AlfMessage
      tampered.payload.attachments![0].data = Buffer.from('replaced').toString('base64')
      const res = await recipient.mesh.processIngressMessage(recipient.filePath, tampered)
      expect(res.success).toBe(false)
      expect(recipient.agent.workspace.getInbox().length).toBe(0)
      expect(recipient.agent.workspace.fileExists('imported/send-tamper/note.txt')).toBe(false)
    } finally {
      await sender.dispose()
      await recipient.dispose()
    }
  })

  it('keeps the record but writes nothing when the decoded size does not match size_bytes', async () => {
    const recipient = await standUp('recv-size', 38945)
    try {
      const message = unsignedMessage(recipient.did, [{
        filename: 'short.txt', content_type: 'text/plain', transfer: 'inline',
        data: Buffer.from('abc').toString('base64'), size_bytes: 999
      }])
      const res = await recipient.mesh.processIngressMessage(recipient.filePath, message)
      expect(res.success).toBe(true)

      const stored = recipient.agent.workspace.getInbox()[0].attachments![0]
      expect(stored.skipped).toBe(true)
      expect(stored.reason).toContain('does not match size_bytes')
      expect(stored.transfer).toBe('inline')
      expect(stored.path).toBeUndefined()
      expect(stored.data).toBeUndefined()
      expect(recipient.agent.workspace.fileExists('imported/peer/short.txt')).toBe(false)
    } finally {
      await recipient.dispose()
    }
  })

  it('confines wire filenames and sender aliases to one folder under imported/', async () => {
    const recipient = await standUp('recv-path', 38946)
    try {
      const message = unsignedMessage(recipient.did, [{
        filename: '../../mind.md', content_type: 'text/markdown', transfer: 'inline',
        data: Buffer.from('# not yours').toString('base64'), size_bytes: 11
      }, {
        // `path` is a storage-side field; a wire value must never be kept.
        filename: 'ref.bin', content_type: 'application/octet-stream', transfer: 'reference',
        url: 'https://example.invalid/ref.bin', path: 'mind.md'
      } as never], '../owner')
      const res = await recipient.mesh.processIngressMessage(recipient.filePath, message)
      expect(res.success).toBe(true)

      const [imported, reference] = recipient.agent.workspace.getInbox()[0].attachments!
      expect(imported.path).toBe('imported/.._owner/mind.md')
      expect(recipient.agent.workspace.readFileBuffer('imported/.._owner/mind.md')!.toString()).toBe('# not yours')
      expect(reference.transfer).toBe('reference')
      expect(reference.path).toBeUndefined()
    } finally {
      await recipient.dispose()
    }
  })
})
