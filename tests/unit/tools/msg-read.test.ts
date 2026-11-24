import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { InboxReadTool } from '../../../src/main/tools/built-in/msg-read.tool'

describe('msg_read', () => {
  let dir: string
  let ws: AdfWorkspace
  const tool = new InboxReadTool()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-msg-read-'))
    ws = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'msg-read' })
  })

  afterEach(() => {
    ws.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('marks only the selected unread rows as read and omits original_message by default', async () => {
    const add = (content: string, received_at: number) => ws.addToInbox({
      from: 'sender', status: 'unread', content, received_at, original_message: '{"platform":"raw"}'
    })
    add('oldest', 1)
    const tiedFirst = add('tied first', 2)
    add('tied second', 2)
    const newest = add('newest', 3)

    const expected = ws.getInbox('unread').slice(0, 2).map(({ original_message, ...message }) => message)
    const result = await tool.execute({ limit: 2 }, ws)
    expect(result.content).toBe(JSON.stringify(expected, null, 2))
    expect(ws.getInbox('read').map((message) => message.id)).toEqual([newest, tiedFirst])
    expect(ws.getInbox('unread').map((message) => message.content)).toEqual(['tied second', 'oldest'])
    const withOriginal = await tool.execute({ status: 'read', limit: 1, include_original: true }, ws)
    expect(JSON.parse(withOriginal.content)).toEqual([ws.getInbox('read')[0]])
  })

  it('preserves numeric slice behavior for default, fractional, negative, and large limits', async () => {
    for (let i = 0; i < 4; i++) {
      ws.addToInbox({ from: 'sender', status: 'archived', content: `message ${i}`, received_at: i })
    }
    const messages = ws.getInbox('archived')
    for (const limit of [undefined, 0, -0, 0.5, -0.5, 1.5, -1.5, -10, Number.MAX_VALUE, Infinity, -Infinity]) {
      const expected = limit ? messages.slice(0, limit) : messages
      const result = await tool.execute({ status: 'archived', limit, include_original: true }, ws)
      expect(result.content).toBe(expected.length ? JSON.stringify(expected, null, 2) : 'No archived messages in inbox.')
    }
  })
})
