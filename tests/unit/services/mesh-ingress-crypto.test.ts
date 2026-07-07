import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), `adf-ingress-crypto-${process.pid}`), on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { MeshManager } from '../../../src/main/runtime/mesh-manager'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { encryptPayloadForDid } from '../../../src/main/crypto/message-crypto'
import type { AlfMessage, AlfPayload } from '../../../src/shared/types/adf-v02.types'

// runInboundCrypto is the single ingress-crypto implementation shared by the
// HTTP inbox (mesh-server preHandler), the WS cold path, and same-runtime
// delivery. Testing it guards the crypto for every inbound transport at once —
// the HTTP path once drifted from the pipeline and stored ciphertext.

let base: string
let mesh: MeshManager
let recipient: ReturnType<typeof createHeadlessAgent>
let recipientFile: string

const PLAINTEXT: AlfPayload = {
  content: 'the launch code is 0000',
  content_type: 'text/plain',
  sent_at: '2026-07-06T12:00:00Z'
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'adf-ingress-crypto-'))
  recipientFile = join(base, 'receiver.adf')
  recipient = createHeadlessAgent({
    filePath: recipientFile,
    name: 'receiver',
    provider: new MockLLMProvider(),
    createOptions: { handle: 'receiver', messaging: { mode: 'respond_only', receive: true } as never }
  })
  mesh = new MeshManager([base])
  mesh.enableMesh()
  mesh.registerServableAgent(recipientFile, recipient.workspace.getAgentConfig(), recipient.registry, recipient.workspace, recipient.session, recipient.executor, null, null, null)
})

afterEach(() => {
  try { mesh.unregisterAgent(recipientFile) } catch { /* idempotent */ }
  recipient.dispose()
  rmSync(base, { recursive: true, force: true })
})

function encryptedMessageTo(did: string): AlfMessage {
  return {
    version: '0.1', network: 'devnet', id: 'm1', timestamp: 'now',
    from: 'did:key:zSender', to: did, reply_to: 'http://x/mesh/inbox',
    payload: encryptPayloadForDid(PLAINTEXT, did)!
  }
}

describe('MeshManager.runInboundCrypto (shared ingress crypto)', () => {
  it('decrypts a payload encrypted to the recipient DID', async () => {
    const recipientDid = recipient.workspace.getDid()!
    const result = await mesh.runInboundCrypto(recipientFile, encryptedMessageTo(recipientDid), false)

    expect(result.rejected).toBeUndefined()
    expect(result.data.payload.content).toBe('the launch code is 0000')
    expect(result.data.meta?.payload_encrypted).toBe(true)
  })

  it('rejects with 403 when the payload was encrypted to a different DID', async () => {
    // Encrypt to some other agent, deliver to our recipient.
    const other = createHeadlessAgent({ filePath: join(base, 'other.adf'), name: 'other', provider: new MockLLMProvider() })
    try {
      const message = encryptedMessageTo(other.workspace.getDid()!)
      message.to = recipient.workspace.getDid()!
      const result = await mesh.runInboundCrypto(recipientFile, message, false)
      expect(result.rejected?.code).toBe(403)
    } finally {
      other.dispose()
    }
  })

  it('returns 404 for an unregistered recipient', async () => {
    const result = await mesh.runInboundCrypto(join(base, 'ghost.adf'), encryptedMessageTo(recipient.workspace.getDid()!), false)
    expect(result.rejected?.code).toBe(404)
  })

  it('passes a plaintext payload through and stamps verification meta', async () => {
    const message: AlfMessage = {
      version: '0.1', network: 'devnet', id: 'm2', timestamp: 'now',
      from: 'did:key:zSender', to: recipient.workspace.getDid()!, reply_to: 'http://x',
      payload: { content: 'hello', content_type: 'text/plain', sent_at: 'now' }
    }
    const result = await mesh.runInboundCrypto(recipientFile, message, false)
    expect(result.rejected).toBeUndefined()
    expect(result.data.payload.content).toBe('hello')
    expect(result.data.meta?.payload_encrypted).toBeUndefined()
  })
})
