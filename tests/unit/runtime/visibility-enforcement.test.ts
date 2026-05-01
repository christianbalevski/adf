import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-visibility-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-visibility-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { MeshManager } from '../../../src/main/runtime/mesh-manager'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import type { Visibility } from '../../../src/shared/types/adf-v02.types'

type Pair = {
  senderFile: string
  senderHandle: string
  sender: ReturnType<typeof createHeadlessAgent>
  recipientFile: string
  recipientHandle: string
  recipient: ReturnType<typeof createHeadlessAgent>
  mesh: MeshManager
  dispose: () => void
}

function makePair(opts: {
  senderDirRel?: string   // subpath under base to place sender's .adf
  recipientDirRel?: string
  senderHandle: string
  recipientHandle: string
  senderVisibility?: Visibility
  recipientVisibility: Visibility
}): Pair {
  const base = mkdtempSync(join(tmpdir(), 'adf-visibility-'))
  const senderDir = opts.senderDirRel ? join(base, opts.senderDirRel) : base
  const recipientDir = opts.recipientDirRel ? join(base, opts.recipientDirRel) : base

  // create dirs if needed
  const fs = require('node:fs')
  if (!fs.existsSync(senderDir)) fs.mkdirSync(senderDir, { recursive: true })
  if (!fs.existsSync(recipientDir)) fs.mkdirSync(recipientDir, { recursive: true })

  const senderFile = join(senderDir, `${opts.senderHandle}.adf`)
  const recipientFile = join(recipientDir, `${opts.recipientHandle}.adf`)

  const sender = createHeadlessAgent({
    filePath: senderFile,
    name: opts.senderHandle,
    provider: new MockLLMProvider(),
    createOptions: {
      handle: opts.senderHandle,
      messaging: { mode: 'proactive', visibility: opts.senderVisibility ?? 'localhost' } as never
    }
  })

  const recipient = createHeadlessAgent({
    filePath: recipientFile,
    name: opts.recipientHandle,
    provider: new MockLLMProvider(),
    createOptions: {
      handle: opts.recipientHandle,
      messaging: { mode: 'respond_only', visibility: opts.recipientVisibility, receive: true } as never
    }
  })

  const mesh = new MeshManager([base])
  mesh.enableMesh()

  mesh.registerServableAgent(senderFile, sender.workspace.getAgentConfig(), sender.registry, sender.workspace, sender.session, sender.executor)
  mesh.registerServableAgent(recipientFile, recipient.workspace.getAgentConfig(), recipient.registry, recipient.workspace, recipient.session, recipient.executor)

  const dispose = () => {
    try { mesh.unregisterAgent(senderFile) } catch { /* idempotent */ }
    try { mesh.unregisterAgent(recipientFile) } catch { /* idempotent */ }
    sender.dispose()
    recipient.dispose()
  }

  return {
    senderFile, senderHandle: opts.senderHandle, sender,
    recipientFile, recipientHandle: opts.recipientHandle, recipient,
    mesh, dispose
  }
}

// URL addresses against the default 127.0.0.1:7295 bind are accepted by
// resolveLocalAgentByUrl and route to the in-process fast path. We use the URL
// form so the test exercises the mesh-manager visibility check at the local
// delivery branch, not the tool's pre-check (which is tested separately below).
function addressFor(handle: string) {
  return `http://127.0.0.1:7295/${handle}/mesh/inbox`
}

describe('In-process visibility enforcement (mesh.sendMessage)', () => {
  it('rejects delivery to an off-tier recipient and does not write to their inbox', async () => {
    const p = makePair({
      senderHandle: 'sender',
      recipientHandle: 'receiver',
      recipientVisibility: 'off'
    })
    try {
      const before = p.recipient.workspace.getInbox().length
      const result = await p.mesh.sendMessage(
        p.senderFile,
        'did:key:zUnknown',          // DID not resolvable; address URL resolves locally
        addressFor(p.recipientHandle),
        'hello'
      )
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/agent not accepting messages/)
      expect(p.recipient.workspace.getInbox().length).toBe(before)
    } finally {
      p.dispose()
    }
  })

  it('rejects delivery to a directory-tier recipient from a non-ancestor sender', async () => {
    const p = makePair({
      senderDirRel: 'projects/app-a',
      recipientDirRel: 'projects/app-b',
      senderHandle: 'alice',
      recipientHandle: 'bob',
      recipientVisibility: 'directory'
    })
    try {
      const before = p.recipient.workspace.getInbox().length
      const result = await p.mesh.sendMessage(
        p.senderFile,
        'did:key:zUnknown',
        addressFor(p.recipientHandle),
        'hello'
      )
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/visibility tier mismatch/)
      expect(p.recipient.workspace.getInbox().length).toBe(before)
    } finally {
      p.dispose()
    }
  })

  it('allows delivery to a directory-tier recipient from a sibling in the same directory', async () => {
    const p = makePair({
      senderHandle: 'peer-a',
      recipientHandle: 'peer-b',
      recipientVisibility: 'directory'
    })
    try {
      const result = await p.mesh.sendMessage(
        p.senderFile,
        'did:key:zUnknown',
        addressFor(p.recipientHandle),
        'hello'
      )
      expect(result.success).toBe(true)
    } finally {
      p.dispose()
    }
  })

  it('allows delivery to a localhost-tier recipient from any same-runtime sender', async () => {
    const p = makePair({
      senderDirRel: 'x',
      recipientDirRel: 'y',
      senderHandle: 'foo',
      recipientHandle: 'bar',
      recipientVisibility: 'localhost'
    })
    try {
      const result = await p.mesh.sendMessage(
        p.senderFile,
        'did:key:zUnknown',
        addressFor(p.recipientHandle),
        'hi'
      )
      expect(result.success).toBe(true)
    } finally {
      p.dispose()
    }
  })
})

describe('msg_send bare-handle resolver visibility pre-check', () => {
  it('returns a tool error with the tier-mismatch reason when the target\'s tier is directory and caller is non-ancestor', async () => {
    const p = makePair({
      senderDirRel: 'projects/app-a',
      recipientDirRel: 'projects/app-b',
      senderHandle: 'alice',
      recipientHandle: 'bob',
      recipientVisibility: 'directory'
    })
    try {
      const tool = p.sender.registry.get('msg_send')
      expect(tool).toBeTruthy()
      const result = await tool!.execute(
        { recipient: p.recipientHandle, content: 'hi' },
        p.sender.workspace
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/visibility tier mismatch/)
    } finally {
      p.dispose()
    }
  })
})

describe('agent_discover visibility filtering', () => {
  it('excludes off-tier and inaccessible agents from a localhost-tier caller', () => {
    const base = mkdtempSync(join(tmpdir(), 'adf-discover-'))
    const callerFile = join(base, 'caller.adf')
    const okFile = join(base, 'ok.adf')
    const offFile = join(base, 'off.adf')

    const caller = createHeadlessAgent({
      filePath: callerFile,
      name: 'caller',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'caller', messaging: { mode: 'proactive', visibility: 'localhost' } as never }
    })
    const ok = createHeadlessAgent({
      filePath: okFile,
      name: 'ok',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'ok', messaging: { mode: 'respond_only', visibility: 'localhost', receive: true } as never }
    })
    const off = createHeadlessAgent({
      filePath: offFile,
      name: 'off',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'off', messaging: { mode: 'respond_only', visibility: 'off' } as never }
    })

    const mesh = new MeshManager([base])
    mesh.enableMesh()
    mesh.registerServableAgent(callerFile, caller.workspace.getAgentConfig(), caller.registry, caller.workspace, caller.session, caller.executor)
    mesh.registerServableAgent(okFile, ok.workspace.getAgentConfig(), ok.registry, ok.workspace, ok.session, ok.executor)
    mesh.registerServableAgent(offFile, off.workspace.getAgentConfig(), off.registry, off.workspace, off.session, off.executor)

    try {
      const dir = mesh.getDirectoryForAgent(callerFile)
      const handles = dir.map(e => e.handle)
      expect(handles).toContain('ok')
      expect(handles).not.toContain('off')
      expect(handles).not.toContain('caller')
    } finally {
      mesh.unregisterAgent(callerFile)
      mesh.unregisterAgent(okFile)
      mesh.unregisterAgent(offFile)
      caller.dispose()
      ok.dispose()
      off.dispose()
    }
  })

  it('returns empty directory for an off-tier caller', () => {
    const base = mkdtempSync(join(tmpdir(), 'adf-discover-off-'))
    const callerFile = join(base, 'caller.adf')
    const otherFile = join(base, 'other.adf')

    const caller = createHeadlessAgent({
      filePath: callerFile,
      name: 'caller',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'caller', messaging: { mode: 'respond_only', visibility: 'off' } as never }
    })
    const other = createHeadlessAgent({
      filePath: otherFile,
      name: 'other',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'other', messaging: { mode: 'respond_only', visibility: 'localhost', receive: true } as never }
    })

    const mesh = new MeshManager([base])
    mesh.enableMesh()
    mesh.registerServableAgent(callerFile, caller.workspace.getAgentConfig(), caller.registry, caller.workspace, caller.session, caller.executor)
    mesh.registerServableAgent(otherFile, other.workspace.getAgentConfig(), other.registry, other.workspace, other.session, other.executor)

    try {
      expect(mesh.getDirectoryForAgent(callerFile)).toEqual([])
    } finally {
      mesh.unregisterAgent(callerFile)
      mesh.unregisterAgent(otherFile)
      caller.dispose()
      other.dispose()
    }
  })
})

describe('hasAgentOfTier / hasAnyReachableAgent', () => {
  it('reports tier presence accurately', () => {
    const base = mkdtempSync(join(tmpdir(), 'adf-tier-'))
    const aFile = join(base, 'a.adf')
    const bFile = join(base, 'b.adf')

    const a = createHeadlessAgent({
      filePath: aFile, name: 'a', provider: new MockLLMProvider(),
      createOptions: { handle: 'a', messaging: { mode: 'respond_only', visibility: 'localhost' } as never }
    })
    const b = createHeadlessAgent({
      filePath: bFile, name: 'b', provider: new MockLLMProvider(),
      createOptions: { handle: 'b', messaging: { mode: 'respond_only', visibility: 'lan' } as never }
    })

    const mesh = new MeshManager([base])
    mesh.enableMesh()
    mesh.registerServableAgent(aFile, a.workspace.getAgentConfig(), a.registry, a.workspace, a.session, a.executor)
    mesh.registerServableAgent(bFile, b.workspace.getAgentConfig(), b.registry, b.workspace, b.session, b.executor)

    try {
      expect(mesh.hasAgentOfTier('lan')).toBe(true)
      expect(mesh.hasAgentOfTier('localhost')).toBe(true)
      expect(mesh.hasAgentOfTier('directory')).toBe(false)
      expect(mesh.hasAgentOfTier('off')).toBe(false)
      expect(mesh.hasAnyReachableAgent()).toBe(true)
    } finally {
      mesh.unregisterAgent(aFile)
      mesh.unregisterAgent(bFile)
      a.dispose()
      b.dispose()
    }
  })

  it('reports no reachable agents when all visibilities are off', () => {
    const base = mkdtempSync(join(tmpdir(), 'adf-off-'))
    const file = join(base, 'ghost.adf')
    const ghost = createHeadlessAgent({
      filePath: file, name: 'ghost', provider: new MockLLMProvider(),
      createOptions: { handle: 'ghost', messaging: { mode: 'proactive', visibility: 'off' } as never }
    })
    const mesh = new MeshManager([base])
    mesh.enableMesh()
    mesh.registerServableAgent(file, ghost.workspace.getAgentConfig(), ghost.registry, ghost.workspace, ghost.session, ghost.executor)
    try {
      expect(mesh.hasAnyReachableAgent()).toBe(false)
    } finally {
      mesh.unregisterAgent(file)
      ghost.dispose()
    }
  })
})
