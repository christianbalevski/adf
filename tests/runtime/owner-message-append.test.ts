import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { AgentLeaseRegistry } from '../../src/main/runtime/agent-lease'
import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { appendOwnerMessageUnderLease } from '../../src/main/runtime/owner-message-append'

/**
 * The owner's message to an agent that could not start (both modes' fleet
 * message): written into its loop under the agent's lease, held from the
 * check to the end of the append; refused with the holder's sentence while
 * another runtime runs the file.
 */

const dirs: string[] = []
const registries: AgentLeaseRegistry[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of registries.splice(0)) await r.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-owner-append-'))
  dirs.push(dir)
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
  const leases = join(dir, 'leases')
  const own = new AgentLeaseRegistry({ dir: leases, kind: 'daemon', settingsPath: join(dir, 'own.json') })
  const other = new AgentLeaseRegistry({ dir: leases, kind: 'studio-embedded', settingsPath: join(dir, 'other.json') })
  registries.push(own, other)
  const loop = () => {
    const ws = AdfWorkspace.open(filePath)
    try { return ws.getLoop() } finally { ws.close() }
  }
  return { filePath, own, other, loop }
}

describe('appendOwnerMessageUnderLease', () => {
  it('refuses, writing nothing, while another runtime runs the file', async () => {
    const { filePath, own, other, loop } = setup()
    expect((await other.acquire(filePath)).ok).toBe(true)
    const before = loop().length
    const result = await appendOwnerMessageUnderLease(own, filePath, 'hello')
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/agent-1 is already running in another ADF Studio/) })
    expect(loop()).toHaveLength(before)
  })

  it('holds the lease through the append, then gives it back', async () => {
    const { filePath, own, other, loop } = setup()
    const original = AdfWorkspace.prototype.appendToLoop
    const heldDuringAppend: number[] = []
    vi.spyOn(AdfWorkspace.prototype, 'appendToLoop').mockImplementation(function (this: AdfWorkspace, ...args: Parameters<AdfWorkspace['appendToLoop']>) {
      heldDuringAppend.push(own.heldPaths().length)
      return original.apply(this, args)
    })
    const result = await appendOwnerMessageUnderLease(own, filePath, 'hello')
    expect(result).toEqual({ ok: true })
    expect(heldDuringAppend).toEqual([1])
    expect(loop().at(-1)).toMatchObject({ role: 'user', content_json: [{ type: 'text', text: 'hello' }] })
    expect(own.heldPaths()).toEqual([])
    expect((await other.acquire(filePath)).ok).toBe(true)
  })
})
