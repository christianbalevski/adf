import { describe, expect, it } from 'vitest'
import { MsgDeleteTool } from '../../../src/main/tools/built-in/msg-delete.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

// The delete builders drop filter fields the target table does not know, so an
// unsupported field used to degrade into `DELETE FROM adf_outbox` with no WHERE.
function stubWorkspace() {
  const calls: Array<{ table: string; filter: unknown }> = []
  const ws = {
    deleteInboxByFilter: (filter: unknown) => {
      calls.push({ table: 'inbox', filter })
      return { deleted: 0, audited: false }
    },
    deleteOutboxByFilter: (filter: unknown) => {
      calls.push({ table: 'outbox', filter })
      return { deleted: 0, audited: false }
    }
  } as unknown as AdfWorkspace
  return { ws, calls }
}

describe('msg_delete filter validation', () => {
  const tool = new MsgDeleteTool()

  it('rejects an inbox-only filter field on the outbox instead of wiping it', async () => {
    const { ws, calls } = stubWorkspace()
    const res = await tool.execute({ source: 'outbox', filter: { source: 'telegram' } }, ws)
    expect(res.isError).toBe(true)
    expect(res.content).toContain('not supported for outbox')
    expect(calls).toHaveLength(0)
  })

  it('rejects an empty filter', async () => {
    const { ws, calls } = stubWorkspace()
    const res = await tool.execute({ source: 'inbox', filter: {} }, ws)
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('still runs a supported outbox filter', async () => {
    const { ws, calls } = stubWorkspace()
    const res = await tool.execute({ source: 'outbox', filter: { status: 'sent' } }, ws)
    expect(res.isError).toBe(false)
    expect(calls[0]).toEqual({ table: 'outbox', filter: { status: 'sent' } })
  })

  it('still runs a supported inbox filter', async () => {
    const { ws, calls } = stubWorkspace()
    const res = await tool.execute({ source: 'inbox', filter: { source: 'telegram' } }, ws)
    expect(res.isError).toBe(false)
    expect(calls[0]).toEqual({ table: 'inbox', filter: { source: 'telegram' } })
  })
})
