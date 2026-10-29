import { describe, expect, it, vi } from 'vitest'
import { preserveBrowserQueues } from '../../src/web/recovery'
import type { QueueHandoverEntry } from '../../src/shared/types/ipc.types'

function storage(entries: Record<string, unknown>): Storage {
  const rows = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
  return { get length() { return rows.size }, key: index => [...rows.keys()][index] ?? null, getItem: key => rows.get(key) ?? null } as Storage
}
const queued = (text: string, id = 'message-one'): QueueHandoverEntry => ({
  filePath: '/agent.adf', loop: 'main', messages: [{ id, text, content: [{ type: 'text', text }] }],
})

describe('browser queue recovery', () => {
  it('preserves live and closed-tab pending messages for manual review without replaying them', async () => {
    const live = queued('live text')
    const closed = queued('closed tab text', 'message-two')
    const saved = storage({
      'adf.web.session.oldscope.tab.closed': { queue: [closed] },
      'adf.web.session.oldscope.tab.live': { queue: [live] },
      'adf.web.session.another-session.tab.other': { queue: [queued('other user', 'message-three')] },
    })
    const stash = vi.fn().mockResolvedValue({ success: true })
    await preserveBrowserQueues([live], saved, 'oldscope', 'client-one', stash)
    expect(stash).toHaveBeenCalledOnce()
    const copy = stash.mock.calls[0][0]
    expect(copy).toMatchObject({ agentFilePath: '/agent.adf', path: 'queued-messages.json', kept: 'browser-queue-oldscope-client-one' })
    const recovered = JSON.parse(copy.content)
    expect(recovered.instructions).toContain('sending them manually')
    expect(recovered.entries.flatMap((entry: QueueHandoverEntry) => entry.messages.map(message => message.text))).toEqual(['live text', 'closed tab text'])
    expect(copy.content).not.toContain('other user')
    expect(live.messages).toHaveLength(1)
    expect(saved.getItem('adf.web.session.oldscope.tab.closed')).toContain('closed tab text')
  })

  it('propagates quota failures before a caller can renew or reload', async () => {
    const quota = new Error('quota')
    await expect(preserveBrowserQueues([queued('keep me')], null, 'scope', 'client', async () => { throw quota })).rejects.toBe(quota)
    await expect(preserveBrowserQueues([queued('keep me')], null, 'scope', 'client', async () => ({ success: false }))).rejects.toThrow('refused pending messages')
  })

  it('makes no recovery file for empty queues and keeps distinct agents and loops separate', async () => {
    const stash = vi.fn().mockResolvedValue({ success: true })
    await preserveBrowserQueues([], null, 'scope', 'client', stash)
    expect(stash).not.toHaveBeenCalled()
    await preserveBrowserQueues([queued('main'), { ...queued('side'), loop: 'side' }, { ...queued('other'), filePath: '/other.adf' }], null, 'scope', 'client', stash)
    expect(stash).toHaveBeenCalledTimes(2)
    expect(JSON.parse(stash.mock.calls[0][0].content).entries.map((entry: QueueHandoverEntry) => entry.loop)).toEqual(['main', 'side'])
  })
})
