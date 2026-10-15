import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { embeddedBackend, srcPath } from '../harness/backend'
import { runScenario, type ParityScenario } from '../harness/scenario'

/**
 * W5-G: embedded Studio's review accept and create when another program is
 * writing the agent file. Minting its identity waits at most 100 ms for the
 * file's write lock; the user gets a sentence naming the file, nothing
 * crashes, and trying again works. (The daemon side: tests/daemon-agent-file-busy.test.ts.)
 */

/** Another program's connection holding the file's write lock (RESERVED) until released. */
function holdWriteLock(filePath: string): () => void {
  const db = new Database(filePath, { fileMustExist: true })
  db.exec('BEGIN IMMEDIATE')
  return () => { try { db.exec('ROLLBACK') } finally { db.close() } }
}

const BUSY = 'agent-1.adf is busy (another program is writing it); try again.'

describe('embedded: an agent file another program is writing', () => {
  it('review accept says so by name, and accepting again works', async () => {
    const results: unknown[] = []
    const scenario: ParityScenario = {
      name: 'w5g-busy-review-accept',
      description: 'Accept the review of agent-1 while another program writes it, then again.',
      fixtures: [{ name: 'agent-1', reviewed: false }],
      quietMs: 300,
      async run(ctx) {
        const { filePath } = ctx.agent('agent-1')
        await ctx.invoke(IPC.FILE_OPEN, { filePath })
        const release = holdWriteLock(filePath)
        try {
          results.push(await ctx.invoke(IPC.FILE_REVIEW_ACCEPT, { claim: false, expectedPath: filePath }))
        } finally {
          release()
        }
        results.push(await ctx.invoke(IPC.FILE_REVIEW_ACCEPT, { claim: false, expectedPath: filePath }))
      },
    }
    await runScenario(scenario, embeddedBackend)
    expect(results[0]).toEqual({ success: false, code: 'agent_file_busy', error: BUSY })
    expect(results[1]).toMatchObject({ success: true })
  }, 60_000)

  it('create says so by name, keeps the new file, and nothing else breaks', async () => {
    const results: Array<{ success: boolean; error?: string; filePath?: string }> = []
    const scenario: ParityScenario = {
      name: 'w5g-busy-create',
      description: 'Create agent-1 while its identity cannot be minted (busy), then again.',
      fixtures: [],
      quietMs: 300,
      async run(ctx) {
        // The new file cannot be locked from outside before it exists: the
        // mint reports what a held lock makes it report.
        const mod = await import(/* @vite-ignore */ srcPath('main/services/owner-identity.service.ts')) as typeof import('../../../src/main/services/owner-identity.service')
        const original = mod.OwnerIdentityService.prototype.ensureWorkspaceIdentity
        const spy = vi.spyOn(mod.OwnerIdentityService.prototype, 'ensureWorkspaceIdentity').mockImplementation(function (this: InstanceType<typeof mod.OwnerIdentityService>, ws, opts) {
          if (ws.getFilePath().endsWith('agent-1.adf')) throw new mod.AgentFileBusyError(ws.getFilePath())
          return original.call(this, ws, opts)
        })
        try {
          results.push(await ctx.invoke(IPC.FILE_CREATE_QUICK, { folder: ctx.env.agentsDir, name: 'agent-1' }))
        } finally {
          spy.mockRestore()
        }
        results.push(await ctx.invoke(IPC.FILE_CREATE_QUICK, { folder: ctx.env.agentsDir, name: 'agent-2' }))
      },
    }
    await runScenario(scenario, embeddedBackend, { tolerant: true })
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain(BUSY)
    expect(results[0].error).toContain('The new agent file is kept at')
    expect(results[1]).toMatchObject({ success: true })
  }, 60_000)
})
